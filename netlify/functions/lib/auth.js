// Autenticazione e permessi lato server di Estimly 2.0.
//
// Il login è email + password. La password non viene mai salvata: si conserva solo l'hash
// (scrypt, con sale casuale per persona). Dopo il login il server rilascia una sessione
// ("SES-" + 48 caratteri casuali) che il browser invia nel campo `key` di ogni richiesta, al posto
// della chiave di licenza: la chiave di licenza non arriva più sui dispositivi del team.
// Ogni funzione chiama authorize(): da lì si ricava lo studio, la persona e il ruolo, e si
// verifica che il ruolo possa fare quell'azione. I permessi dell'interfaccia sono solo di comodo:
// il controllo vero è questo.
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

export const ROLE_KEYS = ['admin', 'socio', 'segreteria', 'marketing', 'lettura'];
export const ROLE_LABELS = {
  admin: 'Amministratore',
  socio: 'Socio',
  segreteria: 'Segreteria',
  marketing: 'Marketing',
  lettura: 'Sola lettura'
};

const SESSION_DAYS = 30;

// '*' = tutto. Le capacità sono stringhe "area.azione".
const ROLE_CAPS = {
  admin: ['*'],
  socio: ['*'],
  segreteria: [
    'app.load', 'quotes.read', 'money.read', 'clients.read', 'catalog.read', 'settings.read',
    'followups.read', 'followups.write', 'payments.read', 'payments.write', 'quotes.update.limited'
  ],
  marketing: ['app.load', 'leads.read', 'marketing.read'],
  lettura: [
    'app.load', 'quotes.read', 'money.read', 'clients.read', 'catalog.read', 'settings.read',
    'followups.read', 'payments.read', 'leads.read', 'marketing.read'
  ]
};

export function capsFor(role) {
  return ROLE_CAPS[role] || [];
}

export function can(role, cap) {
  const caps = capsFor(role);
  if (caps.includes('*')) return true;
  const list = Array.isArray(cap) ? cap : [cap];
  return list.some((c) => caps.includes(c));
}

// Azione richiesta -> capacità necessaria. `null` = pubblica (si autentica con altro, es. il link
// del cliente). Un'azione non elencata richiede '*' (solo amministratore e socio).
const ACTION_CAPS = {
  'sync-data': {
    load: 'app.load', loadPhotos: ['quotes.read'], save: 'catalog.write', saveQuote: 'quotes.create',
    updateQuote: ['quotes.update', 'quotes.update.limited'], syncManager: 'quotes.update',
    deleteQuote: 'quotes.delete', saveClient: 'clients.write', deleteClient: 'clients.write'
  },
  leads: { list: 'leads.read', _default: 'leads.write' },
  followups: { list: 'followups.read', _default: 'followups.write' },
  'stripe-connect': {
    'connect-start': 'settings.write', status: 'payments.read', disconnect: 'settings.write',
    'add-payment-request': 'payments.write', 'refresh-payments': 'payments.write',
    'remove-payment-request': 'payments.write', 'create-checkout-session': null, 'confirm-payment': null
  },
  'clients-sheet-sync': { _default: 'settings.write' },
  estimlyai: { _default: 'quotes.create' },
  'desearq-costi': { _default: 'money.read' },
  'estimly-benchmarks': { _default: 'quotes.read' },
  'public-quote': { 'create-link': 'followups.write', 'create-presentation-link': 'leads.write', 'download-signed-document': 'quotes.read' },
  'validate-key': { _default: null },
  'team-auth': { _default: null }
};

export function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(String(password), salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, keyHex] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
    const expected = Buffer.from(keyHex, 'hex');
    const actual = await scryptAsync(String(password), Buffer.from(saltHex, 'hex'));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (err) {
    return false;
  }
}

// Costo di un controllo "a vuoto", per non far capire dai tempi se un'email esiste.
let dummyHash = null;
export async function dummyVerify(password) {
  if (!dummyHash) dummyHash = await hashPassword('estimly-dummy');
  await verifyPassword(password, dummyHash);
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function getTeam(key) {
  return (await getStore('team').get(key, { type: 'json', consistency: 'strong' })) || null;
}

export async function saveTeam(key, team) {
  await getStore('team').setJSON(key, team);
}

export function teamHasUsers(team) {
  return !!(team && Array.isArray(team.users) && team.users.length);
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, nome: u.nome, email: u.email, ruolo: u.ruolo, desc: u.desc || '',
    hasPhoto: !!u.hasPhoto, createdAt: u.createdAt || ''
  };
}

export function generateStudioCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[bytes[i] % alphabet.length];
  return `DSQ-${s.slice(0, 4)}-${s.slice(4)}`;
}

export async function createSession(studioKey, user) {
  const token = crypto.randomBytes(24).toString('hex');
  const exp = Date.now() + SESSION_DAYS * 86400000;
  await getStore('sessions').setJSON(sha256(token), { key: studioKey, uid: user.id, sv: user.sv || 0, exp });
  return `SES-${token}`;
}

export async function destroySession(raw) {
  const m = /^SES-([0-9a-f]{48})$/i.exec(String(raw || '').trim());
  if (!m) return;
  try { await getStore('sessions').delete(sha256(m[1].toLowerCase())); } catch (err) { /* già assente */ }
}

function deny(status, error) {
  return { error: json({ error }, status) };
}

// Ritorna { key, license, user, role, legacy } oppure { error: Response }.
// `fn` è il nome della funzione chiamante (per la tabella dei permessi).
export async function authorize(body, fn, opts = {}) {
  const raw = String((body && body.key) || '').trim();
  const actionName = body && (body.action || body.mode);
  const table = ACTION_CAPS[fn] || {};
  let cap = Object.prototype.hasOwnProperty.call(table, actionName) ? table[actionName] : table._default;
  if (cap === undefined) cap = '*';
  if (opts.cap !== undefined) cap = opts.cap;

  const licenses = getStore('licenses');

  if (/^SES-/i.test(raw)) {
    const m = /^SES-([0-9a-f]{48})$/i.exec(raw);
    if (!m) return deny(401, 'invalid_session');
    const sessions = getStore('sessions');
    const id = sha256(m[1].toLowerCase());
    const sess = await sessions.get(id, { type: 'json' });
    if (!sess || sess.exp < Date.now()) {
      if (sess) { try { await sessions.delete(id); } catch (err) { /* ok */ } }
      return deny(401, 'session_expired');
    }
    const team = await getTeam(sess.key);
    const user = team && Array.isArray(team.users) ? team.users.find((u) => u.id === sess.uid) : null;
    if (!user || (user.sv || 0) !== (sess.sv || 0)) return deny(401, 'session_expired');
    const license = await licenses.get(sess.key, { type: 'json' });
    if (!license || license.status !== 'active') return deny(401, 'invalid_license');
    if (cap !== null && !can(user.ruolo, cap)) return deny(403, 'forbidden');
    // sessione scorrevole: si rinnova quando mancano meno di 20 giorni
    if (sess.exp - Date.now() < 20 * 86400000) {
      try { await sessions.setJSON(id, { ...sess, exp: Date.now() + SESSION_DAYS * 86400000 }); } catch (err) { /* ok */ }
    }
    return { key: sess.key, license, user, role: user.ruolo, team, legacy: false };
  }

  // Chiave di licenza "nuda": vale solo finché lo studio non ha attivato gli accessi con email e
  // password. Dopo, passare dal login è obbligatorio, anche per l'amministratore.
  const key = raw.toUpperCase();
  if (!key) return deny(400, 'missing_key');
  const license = await licenses.get(key, { type: 'json' });
  if (!license || license.status !== 'active') return deny(401, 'invalid_license');
  const team = await getTeam(key);
  if (teamHasUsers(team)) return deny(401, 'login_required');
  return { key, license, user: null, role: 'admin', team, legacy: true };
}

// ---- foto (in un archivio separato, per non appesantire i dati dello studio) ----
export const MAX_PHOTO_CHARS = 700000;
export function validPhoto(s) {
  return typeof s === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length <= MAX_PHOTO_CHARS;
}

// Dati dello studio visibili al ruolo: niente chiavi segrete per chi non amministra.
const SECRET_SETTINGS = ['resendApiKey', 'stripeAccountId'];
export function settingsForRole(settings, role) {
  const s = { ...(settings || {}) };
  if (!can(role, 'settings.write')) SECRET_SETTINGS.forEach((k) => { delete s[k]; });
  return s;
}
export function brandingOnly(settings) {
  const s = settings || {};
  return { nome: s.nome, tagline: s.tagline, logo: s.logo, colorPrimary: s.colorPrimary, colorInk: s.colorInk };
}
