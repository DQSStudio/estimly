// ===================== Costo orario da Cost (calcolatore costi fissi Desearq) =====================
// Endpoint che Estimly interroga per sostituire il ricalcolo manuale del "Calcola il tuo costo
// orario" con il valore già calcolato nel prodotto Cost dello studio (evita di dover ricontrollare
// e riscrivere lo stesso numero in due posti). Riservato agli studi col pacchetto completo
// (license.suiteEnabled), flag indipendente da Estimly 2.0/followupEnabled.
//
// Legge dalla tabella condivisa public.estimly_costi_studio (Supabase, stesso progetto già usato
// per DSQ Manager), scritta da Cost tramite la stessa SUPABASE_ANON_KEY. Nessun dato scritto da
// qui: questo endpoint è sola lettura.

import { getStore } from '@netlify/blobs';

const SUPABASE_URL = 'https://qgeiehavpnqdxqnggfzq.supabase.co';
const TABLE = 'estimly_costi_studio';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }

  let body;
  try { body = await req.json(); }
  catch (err) { return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 }); }

  const key = (body.key || '').trim().toUpperCase();
  if (!key) return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400 });

  const licenses = getStore('licenses');
  const license = await licenses.get(key, { type: 'json' });
  if (!license || license.status !== 'active') {
    return new Response(JSON.stringify({ error: 'invalid_license' }), { status: 200 });
  }
  if (!license.suiteEnabled) {
    return new Response(JSON.stringify({ error: 'not_suite' }), { status: 200 });
  }

  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!anonKey) {
    return new Response(JSON.stringify({ error: 'not_configured' }), { status: 200 });
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${TABLE}?license_key=eq.${encodeURIComponent(key)}&select=tariffa_oraria,updated_at&limit=1`,
      { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } }
    );
    if (!res.ok) return new Response(JSON.stringify({ error: 'supabase_error' }), { status: 200 });
    const rows = await res.json();
    if (!rows.length) return new Response(JSON.stringify({ error: 'not_found' }), { status: 200 });
    return new Response(JSON.stringify({
      ok: true,
      tariffaOraria: rows[0].tariffa_oraria,
      updatedAt: rows[0].updated_at
    }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'server_error' }), { status: 200 });
  }
};
