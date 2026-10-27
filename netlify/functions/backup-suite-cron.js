// Ogni notte avvia la copia di tutti i dati di Estimly (Netlify Blobs) nell'archivio privato di backup della suite.
import crypto from 'node:crypto';

export const config = { schedule: '45 2 * * *' };

const gettone = (chiave) => crypto.createHash('sha256').update(chiave + '|' + new Date().toISOString().slice(0, 10)).digest('hex');

export default async (req) => {
  const chiave = process.env.SUITE_SUPABASE_SECRET_KEY || '';
  if (!chiave) { console.error('backup-suite: manca SUITE_SUPABASE_SECRET_KEY'); return; }
  const base = process.env.URL || 'https://dsqestimly.netlify.app';
  const r = await fetch(base + '/.netlify/functions/backup-suite-background', { method: 'POST', headers: { 'x-backup-token': gettone(chiave) } });
  console.log('backup-suite avviato', r.status);
};
