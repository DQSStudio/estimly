import { getStore } from '@netlify/blobs';
import { authorize, capsFor, publicUser, ROLE_LABELS } from './lib/auth.js';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ valid: false, error: 'method not allowed' }), { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch (err) {
    return new Response(JSON.stringify({ valid: false }), { status: 400 });
  }

  const raw = String(body.key || '').trim();
  if (!raw) {
    return new Response(JSON.stringify({ valid: false }), { status: 400 });
  }

  try {
    // `key` può essere una sessione (login con email e password) o la chiave di licenza.
    // Con gli accessi attivati la sola chiave non basta più: serve il login.
    const auth = await authorize(body, 'validate-key');
    if (auth.error) {
      const status = auth.error.status;
      let err = '';
      try { err = (await auth.error.json()).error || ''; } catch (e) { /* ok */ }
      return new Response(JSON.stringify({ valid: false, error: err }), { status: status === 401 || status === 403 ? 200 : status, headers: { 'Content-Type': 'application/json' } });
    }
    const { license, key } = auth;
    const store = getStore('licenses');
    const record = { ...license };
    record.lastValidatedAt = new Date().toISOString();
    record.validationCount = (record.validationCount || 0) + 1;
    await store.setJSON(key, record);

    return new Response(JSON.stringify({
      valid: true,
      customer: record.customer,
      aiEnabled: !!record.aiEnabled,
      followupEnabled: !!record.followupEnabled,
      costCalcEnabled: !!record.costCalcEnabled,
      suiteEnabled: !!record.suiteEnabled,
      auth: auth.legacy ? 'legacy' : 'login',
      role: auth.role,
      roleLabel: ROLE_LABELS[auth.role],
      caps: capsFor(auth.role),
      user: publicUser(auth.user),
      studioCode: auth.team && auth.team.code ? auth.team.code : ''
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ valid: false, error: 'server error' }), { status: 500 });
  }
};
