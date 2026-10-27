// Copia di tutti i dati di Estimly (un file per licenza e per archivio) nel bucket privato "backup" della suite.
// Si tengono gli ultimi 7 giorni (cartella = giorno della settimana). Vale per tutte le licenze, anche per chi usa solo Estimly.
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const SUITE_URL = process.env.SUITE_SUPABASE_URL || 'https://qudoygcfphqhhyenpwlr.supabase.co';
const SUITE_KEY = process.env.SUITE_SUPABASE_SECRET_KEY || '';
const ARCHIVI = ['licenses', 'studio-data', 'studio-data-backups', 'quote-photos', 'team-photos', 'leads', 'leads-sheet-seen',
  'followups', 'public-links', 'signed-documents', 'auth-index'];

const gettone = () => crypto.createHash('sha256').update(SUITE_KEY + '|' + new Date().toISOString().slice(0, 10)).digest('hex');

async function carica(percorso, testo) {
  const r = await fetch(`${SUITE_URL}/storage/v1/object/backup/${percorso}`, {
    method: 'POST',
    headers: { apikey: SUITE_KEY, Authorization: 'Bearer ' + SUITE_KEY, 'Content-Type': 'application/json', 'x-upsert': 'true' },
    body: testo
  });
  if (!r.ok) throw new Error(`${percorso}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
}

export default async (req) => {
  if (!SUITE_KEY || req.headers.get('x-backup-token') !== gettone()) return;
  const giorno = 'giorno-' + new Date().getUTCDay();
  const inizio = new Date().toISOString();
  const esito = { inizio, archivi: {}, errori: [] };
  for (const nome of ARCHIVI) {
    const store = getStore(nome);
    const gruppi = new Map();   // licenza -> { chiave: valore }
    let n = 0;
    try {
      for await (const pagina of store.list({ paginate: true })) {
        for (const b of pagina.blobs) {
          const v = await store.get(b.key, { type: 'text' });
          if (v === null) continue;
          const lic = nome === 'auth-index' || nome === 'licenses' ? '_tutte' : String(b.key).split(':')[0];
          if (!gruppi.has(lic)) gruppi.set(lic, {});
          gruppi.get(lic)[b.key] = v;
          n++;
        }
      }
      for (const [lic, dati] of gruppi) {
        const sicuro = lic.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
        await carica(`estimly/${giorno}/${nome}/${sicuro}.json`, JSON.stringify({ archivio: nome, licenza: lic, creato_il: inizio, voci: dati }));
      }
      esito.archivi[nome] = { voci: n, file: gruppi.size };
    } catch (e) {
      esito.errori.push(`${nome}: ${String(e).slice(0, 200)}`);
    }
  }
  esito.fine = new Date().toISOString();
  try { await carica(`estimly/${giorno}/_esito.json`, JSON.stringify(esito)); } catch (e) { console.error('esito non salvato', e); }
  console.log('backup-suite finito', JSON.stringify(esito));
};
