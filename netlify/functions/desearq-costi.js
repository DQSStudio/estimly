// ===================== Costo orario da Cost (calcolatore costi fissi Desearq) =====================
// Endpoint che Estimly interroga per sostituire il ricalcolo manuale del "Calcola il tuo costo
// orario" con il valore già calcolato nel prodotto Cost dello studio (evita di dover ricontrollare
// e riscrivere lo stesso numero in due posti). Riservato agli studi col pacchetto completo
// (license.suiteEnabled), flag indipendente da Estimly 2.0/followupEnabled.
//
// Il collegamento tra Cost ed Estimly passa per la LICENZA di Estimly: la suite sa a quale studio
// appartiene la licenza (core.licenze_prodotto) e da lì legge il totale annuo calcolato da Cost
// (flow.costi_studio). Lo studio non deve inserire nessun codice né l'email di Cost.
//
// La lettura avviene solo da qui, con la chiave segreta della suite (variabile d'ambiente su Netlify,
// mai nel codice né nel browser), tramite la funzione public.estimly_costi_da_licenza che riceve
// soltanto l'impronta SHA-256 della licenza. Nessun dato scritto da qui: sola lettura.
//
// Cost scrive il TOTALE ANNUO dei costi da coprire (stipendio + costi fissi + margine, secondo
// il proprio calcolo) in `totale_annuo`, non una tariffa oraria già pronta: la conversione in
// tariffa oraria resta responsabilità di Estimly, che applica le proprie ore fatturabili annue
// (settimane/giorni/ore al giorno/% fatturabile, già presenti in studioSettings.costCalc) — la
// stessa formula del calcolatore "Calcola il tuo costo orario" già esistente.

import { authorize } from './lib/auth.js';
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { licenseStore } from './lib/licenze.js';

const SUITE_URL = process.env.SUITE_SUPABASE_URL || 'https://qudoygcfphqhhyenpwlr.supabase.co';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }

  let body;
  try { body = await req.json(); }
  catch (err) { return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 }); }

  // Accesso: sessione (email + password) o, finché lo studio non attiva i login, chiave di licenza.
  const auth = await authorize(body, 'desearq-costi');
  if (auth.error) return auth.error;
  body.key = auth.key;

  const key = (body.key || '').trim().toUpperCase();
  if (!key) return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400 });

  const licenses = licenseStore();
  const license = await licenses.get(key, { type: 'json' });
  if (!license || license.status !== 'active') {
    return new Response(JSON.stringify({ error: 'invalid_license' }), { status: 200 });
  }
  if (!license.suiteEnabled) {
    return new Response(JSON.stringify({ error: 'not_suite' }), { status: 200 });
  }

  const secretKey = process.env.SUITE_SUPABASE_SECRET_KEY;
  if (!secretKey) {
    return new Response(JSON.stringify({ error: 'not_configured' }), { status: 200 });
  }

  try {
    const hash = createHash('sha256').update(key).digest('hex');
    const res = await fetch(`${SUITE_URL}/rest/v1/rpc/estimly_costi_da_licenza`, {
      method: 'POST',
      headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_chiave_hash: hash })
    });
    if (!res.ok) return new Response(JSON.stringify({ error: 'supabase_error' }), { status: 200 });
    const row = await res.json();
    if (!row) return new Response(JSON.stringify({ error: 'not_found' }), { status: 200 });
    return new Response(JSON.stringify({
      ok: true,
      totaleAnnuo: row.totale_annuo,
      anno: row.anno || null,
      updatedAt: row.updated_at,
      anni: Array.isArray(row.anni) ? row.anni.map(a => ({ anno: a.anno, totaleAnnuo: a.totale_annuo, updatedAt: a.updated_at })) : []
    }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'server_error' }), { status: 200 });
  }
};
