// Importa nella suite le licenze di Estimly (una volta; si può rilanciare senza danni).
// Protetta come admin-keys (x-admin-password). Crea uno studio per ogni chiave non ancora collegata.
import { getStore } from '@netlify/blobs';

const SUITE_URL = process.env.SUITE_SUPABASE_URL || 'https://qudoygcfphqhhyenpwlr.supabase.co';
const SUITE_KEY = process.env.SUITE_SUPABASE_SECRET_KEY || '';

export default async (req) => {
  const out = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return out({ error: 'method not allowed' }, 405);
  const auth = req.headers.get('x-admin-password');
  if (!auth || auth !== process.env.ADMIN_PASSWORD) return out({ error: 'unauthorized' }, 401);
  if (!SUITE_KEY) return out({ error: 'manca SUITE_SUPABASE_SECRET_KEY' }, 500);

  const store = getStore('licenses');
  const { blobs } = await store.list();
  const risultati = [];
  for (const b of blobs) {
    const lic = await store.get(b.key, { type: 'json' });
    if (!lic) continue;
    const r = await fetch(SUITE_URL + '/rest/v1/rpc/estimly_importa', {
      method: 'POST',
      headers: { apikey: SUITE_KEY, Authorization: 'Bearer ' + SUITE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_chiave: b.key,
        p_cliente: lic.customer || '',
        p_attiva: lic.status === 'active',
        p_funzioni: { ai: !!lic.aiEnabled, followup: !!lic.followupEnabled, costcalc: !!lic.costCalcEnabled, suite: !!lic.suiteEnabled }
      })
    });
    risultati.push({ chiave: '…' + b.key.slice(-4), cliente: lic.customer || '', stato: lic.status, ok: r.ok, errore: r.ok ? undefined : (await r.text()).slice(0, 160) });
  }
  return out({ ok: true, totale: risultati.length, risultati });
};
