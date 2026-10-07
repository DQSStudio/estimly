// Login e gestione del team di Estimly 2.0 (email + password).
//
// Azioni (POST JSON):
//  - bootstrap       primo accesso dello studio: con la chiave di licenza crea l'amministratore
//  - login           email + password -> sessione
//  - me              chi sono (con la sessione nel campo `key`)
//  - logout          chiude la sessione
//  - list            elenco del team con le foto            (solo amministratore e socio)
//  - save            aggiunge / modifica una persona         (solo amministratore e socio)
//  - delete          elimina una persona                     (solo amministratore e socio)
//  - setPhoto        foto di una persona (la propria, o di chiunque se amministratore)
//  - changePassword  cambio della propria password
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import {
  ROLE_KEYS, ROLE_LABELS, authorize, can, capsFor, createSession, destroySession, dummyVerify,
  generateStudioCode, getTeam, hashPassword, json, publicUser, saveTeam, sha256, teamHasUsers,
  validPhoto, verifyPassword
} from './lib/auth.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

function cleanEmail(e) { return String(e || '').trim().toLowerCase(); }
function cleanText(s, max) { return String(s || '').trim().slice(0, max); }
function emailId(email) { return sha256(cleanEmail(email)); }

function studioInfo(license, team) {
  return {
    code: team && team.code ? team.code : '',
    customer: license && license.customer ? license.customer : '',
    aiEnabled: !!(license && license.aiEnabled),
    followupEnabled: !!(license && license.followupEnabled),
    costCalcEnabled: !!(license && license.costCalcEnabled),
    suiteEnabled: !!(license && license.suiteEnabled)
  };
}

function sessionPayload(user, license, team) {
  return {
    user: publicUser(user),
    role: user.ruolo,
    roleLabel: ROLE_LABELS[user.ruolo],
    caps: capsFor(user.ruolo),
    studio: studioInfo(license, team)
  };
}

async function readPhoto(studioKey, uid) {
  try { return (await getStore('team-photos').get(`${studioKey}:${uid}`, { type: 'text' })) || ''; } catch (err) { return ''; }
}

function isPrivileged(role) { return role === 'admin' || role === 'socio'; }

async function login(body) {
  const email = cleanEmail(body.email);
  const password = String(body.password || '');
  if (!EMAIL_RE.test(email) || !password) return json({ error: 'invalid_credentials' }, 401);

  const throttle = getStore('auth-throttle');
  const tid = emailId(email);
  const th = (await throttle.get(tid, { type: 'json' })) || { n: 0, until: 0, last: 0 };
  if (th.until && th.until > Date.now()) {
    return json({ error: 'too_many_attempts', retryAfterSec: Math.ceil((th.until - Date.now()) / 1000) }, 429);
  }

  const studioKey = await getStore('auth-index').get(tid, { type: 'text' });
  let user = null;
  let team = null;
  if (studioKey) {
    team = await getTeam(studioKey);
    user = team && Array.isArray(team.users) ? team.users.find((u) => cleanEmail(u.email) === email) : null;
  }
  const ok = user ? await verifyPassword(password, user.hash) : (await dummyVerify(password), false);
  if (!ok) {
    const recent = th.last && Date.now() - th.last < FAIL_WINDOW_MS ? th.n : 0;
    const n = recent + 1;
    await throttle.setJSON(tid, { n, last: Date.now(), until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
    return json({ error: 'invalid_credentials' }, 401);
  }
  const license = await getStore('licenses').get(studioKey, { type: 'json' });
  if (!license || license.status !== 'active') return json({ error: 'invalid_license' }, 401);
  await throttle.delete(tid).catch(() => {});
  const session = await createSession(studioKey, user);
  const foto = user.hasPhoto ? await readPhoto(studioKey, user.id) : '';
  return json({ ok: true, session, ...sessionPayload(user, license, team), foto });
}

async function bootstrap(body) {
  const raw = String(body.key || '').trim();
  if (/^SES-/i.test(raw)) return json({ error: 'already_logged_in' }, 400);
  const key = raw.toUpperCase();
  const email = cleanEmail(body.email);
  const nome = cleanText(body.nome, 80);
  const password = String(body.password || '');
  if (!key) return json({ error: 'missing_key' }, 400);
  if (!nome) return json({ error: 'missing_name' }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: 'invalid_email' }, 400);
  if (password.length < 8) return json({ error: 'weak_password' }, 400);

  const license = await getStore('licenses').get(key, { type: 'json' });
  if (!license || license.status !== 'active') return json({ error: 'invalid_license' }, 401);
  const existing = await getTeam(key);
  if (teamHasUsers(existing)) return json({ error: 'already_activated' }, 409);

  const index = getStore('auth-index');
  const eid = emailId(email);
  if (await index.get(eid, { type: 'text' })) return json({ error: 'email_in_use' }, 409);

  const user = {
    id: 'u_' + crypto.randomBytes(5).toString('hex'), nome, email, ruolo: 'admin', desc: '',
    hash: await hashPassword(password), sv: 0, hasPhoto: false, createdAt: new Date().toISOString()
  };
  const team = { code: (existing && existing.code) || generateStudioCode(), users: [user] };
  await saveTeam(key, team);
  await index.set(eid, key);
  const session = await createSession(key, user);
  return json({ ok: true, session, ...sessionPayload(user, license, team), foto: '' });
}

async function me(auth) {
  if (auth.legacy) {
    return json({ ok: true, legacy: true, role: 'admin', caps: ['*'], user: null, studio: studioInfo(auth.license, auth.team) });
  }
  const foto = auth.user.hasPhoto ? await readPhoto(auth.key, auth.user.id) : '';
  return json({ ok: true, ...sessionPayload(auth.user, auth.license, auth.team), foto });
}

async function list(auth) {
  const users = (auth.team && auth.team.users) || [];
  const out = await Promise.all(users.map(async (u) => ({ ...publicUser(u), foto: u.hasPhoto ? await readPhoto(auth.key, u.id) : '' })));
  return json({ ok: true, users: out, code: (auth.team && auth.team.code) || '', roles: ROLE_LABELS });
}

async function saveMember(auth, body) {
  const m = body.member && typeof body.member === 'object' ? body.member : null;
  if (!m) return json({ error: 'missing_member' }, 400);
  const nome = cleanText(m.nome, 80);
  const email = cleanEmail(m.email);
  const desc = cleanText(m.desc, 240);
  const password = String(m.password || '');
  if (!nome) return json({ error: 'missing_name' }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: 'invalid_email' }, 400);
  if (!ROLE_KEYS.includes(m.ruolo)) return json({ error: 'invalid_role' }, 400);

  const team = (await getTeam(auth.key)) || { code: generateStudioCode(), users: [] };
  const index = getStore('auth-index');
  const idx = m.id ? team.users.findIndex((u) => u.id === m.id) : -1;
  const isNew = idx === -1;
  const current = isNew ? null : team.users[idx];

  if (isNew && password.length < 8) return json({ error: 'weak_password' }, 400);
  if (password && password.length < 8) return json({ error: 'weak_password' }, 400);

  const eid = emailId(email);
  const owner = await index.get(eid, { type: 'text' });
  // l'email deve essere libera in tutta Estimly, a meno che non sia già quella di questa persona
  if (owner && !(current && cleanEmail(current.email) === email)) return json({ error: 'email_in_use' }, 409);

  // almeno una persona con pieni poteri deve restare
  const nextRole = m.ruolo;
  if (current && isPrivileged(current.ruolo) && !isPrivileged(nextRole)) {
    const others = team.users.filter((u) => u.id !== current.id && isPrivileged(u.ruolo));
    if (!others.length) return json({ error: 'last_admin' }, 400);
  }

  const user = isNew
    ? { id: 'u_' + crypto.randomBytes(5).toString('hex'), hasPhoto: false, sv: 0, createdAt: new Date().toISOString() }
    : { ...current };
  const credentialsChanged = !isNew && (user.ruolo !== nextRole || cleanEmail(user.email) !== email || !!password);
  user.nome = nome; user.email = email; user.desc = desc; user.ruolo = nextRole;
  if (password) user.hash = await hashPassword(password);
  // cambiando ruolo, email o password le sessioni aperte di quella persona si chiudono
  if (credentialsChanged && !(auth.user && auth.user.id === user.id && !password)) user.sv = (user.sv || 0) + 1;

  if (isNew) team.users.push(user); else team.users[idx] = user;
  await saveTeam(auth.key, team);
  if (current && cleanEmail(current.email) !== email) await index.delete(emailId(current.email)).catch(() => {});
  await index.set(eid, auth.key);
  return json({ ok: true, user: publicUser(user) });
}

async function deleteMember(auth, body) {
  const id = String(body.id || '');
  if (auth.user && auth.user.id === id) return json({ error: 'cannot_delete_self' }, 400);
  const team = await getTeam(auth.key);
  const user = team && team.users.find((u) => u.id === id);
  if (!user) return json({ error: 'not_found' }, 404);
  if (isPrivileged(user.ruolo) && !team.users.some((u) => u.id !== id && isPrivileged(u.ruolo))) return json({ error: 'last_admin' }, 400);
  team.users = team.users.filter((u) => u.id !== id);
  await saveTeam(auth.key, team);
  await getStore('auth-index').delete(emailId(user.email)).catch(() => {});
  await getStore('team-photos').delete(`${auth.key}:${id}`).catch(() => {});
  return json({ ok: true });
}

async function setPhoto(auth, body) {
  const id = String(body.id || (auth.user && auth.user.id) || '');
  const own = !!(auth.user && auth.user.id === id);
  if (!own && !can(auth.role, 'team.manage')) return json({ error: 'forbidden' }, 403);
  const team = await getTeam(auth.key);
  const idx = team ? team.users.findIndex((u) => u.id === id) : -1;
  if (idx === -1) return json({ error: 'not_found' }, 404);
  const photos = getStore('team-photos');
  if (!body.foto) {
    await photos.delete(`${auth.key}:${id}`).catch(() => {});
    team.users[idx].hasPhoto = false;
  } else {
    if (!validPhoto(body.foto)) return json({ error: 'invalid_photo' }, 400);
    await photos.set(`${auth.key}:${id}`, body.foto);
    team.users[idx].hasPhoto = true;
  }
  await saveTeam(auth.key, team);
  return json({ ok: true });
}

async function changePassword(auth, body) {
  if (!auth.user) return json({ error: 'login_required' }, 401);
  const next = String(body.next || '');
  if (next.length < 8) return json({ error: 'weak_password' }, 400);
  if (!(await verifyPassword(String(body.current || ''), auth.user.hash))) return json({ error: 'invalid_credentials' }, 401);
  const team = await getTeam(auth.key);
  const idx = team.users.findIndex((u) => u.id === auth.user.id);
  team.users[idx].hash = await hashPassword(next);
  team.users[idx].sv = (team.users[idx].sv || 0) + 1;
  await saveTeam(auth.key, team);
  const session = await createSession(auth.key, team.users[idx]);
  return json({ ok: true, session });
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body;
  try { body = await req.json(); } catch (err) { return json({ error: 'invalid_body' }, 400); }

  try {
    switch (body.action) {
      case 'login': return await login(body);
      case 'bootstrap': return await bootstrap(body);
      case 'logout': await destroySession(body.key); return json({ ok: true });
      case 'me': {
        const auth = await authorize(body, 'team-auth', { cap: null });
        if (auth.error) return auth.error;
        return await me(auth);
      }
      case 'list': case 'save': case 'delete': {
        const auth = await authorize(body, 'team-auth', { cap: 'team.manage' });
        if (auth.error) return auth.error;
        if (auth.legacy) return json({ error: 'activate_first' }, 409);
        if (body.action === 'list') return await list(auth);
        if (body.action === 'save') return await saveMember(auth, body);
        return await deleteMember(auth, body);
      }
      case 'setPhoto': case 'changePassword': {
        const auth = await authorize(body, 'team-auth', { cap: null });
        if (auth.error) return auth.error;
        if (auth.legacy) return json({ error: 'activate_first' }, 409);
        return body.action === 'setPhoto' ? await setPhoto(auth, body) : await changePassword(auth, body);
      }
      default: return json({ error: 'unknown_action' }, 400);
    }
  } catch (err) {
    console.error('[team-auth]', String((err && err.message) || err));
    return json({ error: 'server_error' }, 500);
  }
};
