import { getStore } from '@netlify/blobs';

// ===================== Rete di sicurezza per l'import clienti da Google Sheet =====================
// Lo script agganciato al Google Form dovrebbe già chiamare clients-sheet-sync.js ad ogni invio
// (vedi apps-script-sync-clienti.js), ma se per qualsiasi motivo quel ping non arrivasse, questa
// funzione programmata rilancia la stessa sincronizzazione ogni 15 minuti per tutte le licenze
// che hanno una chiave Google Sheets configurata in CLIENTS_SHEET_LICENSE_KEYS (elenco separato
// da virgole — oggi basta la sola licenza di Nicola).
export const config = { schedule: '*/15 * * * *' };

export default async () => {
  const keysEnv = process.env.CLIENTS_SHEET_LICENSE_KEYS || '';
  const keys = keysEnv.split(',').map((k) => k.trim().toUpperCase()).filter(Boolean);
  if (keys.length === 0) {
    console.log('[clients-sheet-cron] nessuna licenza configurata in CLIENTS_SHEET_LICENSE_KEYS, salto');
    return new Response('ok', { status: 200 });
  }

  const licenses = getStore('licenses');
  for (const key of keys) {
    try {
      const license = await licenses.get(key, { type: 'json' });
      if (!license || license.status !== 'active') {
        console.log(`[clients-sheet-cron] licenza ${key} non attiva, salto`);
        continue;
      }
      const base = process.env.URL || process.env.DEPLOY_PRIME_URL || '';
      const res = await fetch(`${base}/.netlify/functions/clients-sheet-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      const data = await res.json().catch(() => ({}));
      console.log(`[clients-sheet-cron] key=${key} esito:`, JSON.stringify(data));
    } catch (err) {
      console.error(`[clients-sheet-cron] errore per key=${key}:`, String(err.message || err));
    }
  }

  return new Response('ok', { status: 200 });
};
