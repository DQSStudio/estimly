// Il Pannello Desearq chiede a Estimly di generare la chiave di licenza di uno studio.
// Chiamata dal browser del gestore: serve il suo login della suite (con doppia autenticazione) e
// il controllo "gestore" lo fa la suite stessa.
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const SUITE_URL = process.env.SUITE_SUPABASE_URL || 'https://qudoygcfphqhhyenpwlr.supabase.co';
const SUITE_KEY = process.env.SUITE_SUPABASE_SECRET_KEY || '';
const ORIGINE = 'https://dsqadmin-pannello.netlify.app';

const cors = {
  'Access-Control-Allow-Origin': ORIGINE,
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};
const out = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: cors });

const rpc = (nome, args) => fetch(SUITE_URL + '/rest/v1/rpc/' + nome, {
  method: 'POST',
  headers: { apikey: SUITE_KEY, Authorization: 'Bearer ' + SUITE_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify(args)
});

function nuovaChiave() {
  const p = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `DQSS-${p()}-${p()}-${p()}`;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return out({ error: 'method not allowed' }, 405);
  if (!SUITE_KEY) return out({ error: 'manca SUITE_SUPABASE_SECRET_KEY' }, 500);

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return out({ error: 'unauthorized' }, 401);
  const ur = await fetch(SUITE_URL + '/auth/v1/user', { headers: { apikey: SUITE_KEY, Authorization: 'Bearer ' + token } });
  if (!ur.ok) return out({ error: 'unauthorized' }, 401);
  const user = await ur.json();
  let aal = '';
  try { aal = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).aal || ''; } catch (e) { /* illeggibile */ }
  if (aal !== 'aal2') return out({ error: 'mfa_required' }, 403);
  const adm = await rpc('piattaforma_e_admin', { p_user: user.id });
  const mfa = await rpc('piattaforma_mfa_ok', { p_user: user.id });
  if (!(adm.ok && (await adm.json())) || !(mfa.ok && (await mfa.json()))) return out({ error: 'forbidden' }, 403);

  let body; try { body = await req.json(); } catch (e) { return out({ error: 'invalid body' }, 400); }
  const orgId = String(body.org_id || '');
  const cliente = String(body.cliente || '').trim();
  if (!orgId || !cliente) return out({ error: 'dati mancanti' }, 400);

  const store = getStore('licenses');
  const key = nuovaChiave();
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || '';
  // prima si registra il collegamento nella suite (verifica anche che Estimly sia attivo per lo studio)
  const link = await rpc('piattaforma_collega_estimly', { p_org: orgId, p_chiave: key, p_url: host ? 'https://' + host : '' });
  if (!link.ok) {
    let msg = 'collegamento non riuscito';
    try { msg = (await link.json()).message || msg; } catch (e) { /* ok */ }
    return out({ error: msg }, 400);
  }
  await store.setJSON(key, {
    customer: cliente, status: 'active', aiEnabled: false, followupEnabled: false, costCalcEnabled: false, suiteEnabled: false,
    createdAt: new Date().toISOString(), validationCount: 0
  });
  return out({ ok: true, chiave: key });
};
