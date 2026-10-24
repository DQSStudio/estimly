// Archivio licenze con "sovrapposizione" dalla suite: se la chiave è collegata a uno studio della suite,
// stato e funzioni (EstimlyAI, Follow-up, costo orario, Suite) valgono come impostati dal pannello Desearq.
// Se la suite non risponde o la chiave non è collegata, vale il dato storico: nessun blocco per i clienti.
import { getStore } from '@netlify/blobs';

const SUITE_URL = process.env.SUITE_SUPABASE_URL || 'https://qudoygcfphqhhyenpwlr.supabase.co';
const SUITE_KEY = process.env.SUITE_SUPABASE_SECRET_KEY || '';
const cache = new Map();            // chiave -> { t, v }
const TTL = 20000;

const FLAG = { ai: 'aiEnabled', followup: 'followupEnabled', costcalc: 'costCalcEnabled', suite: 'suiteEnabled' };

async function overlay(key) {
  if (!SUITE_KEY || !key) return null;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  let v = null;
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch(SUITE_URL + '/rest/v1/rpc/estimly_overlay', {
      method: 'POST',
      headers: { apikey: SUITE_KEY, Authorization: 'Bearer ' + SUITE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_chiave: key }),
      signal: ctl.signal
    });
    clearTimeout(to);
    if (r.ok) v = await r.json();
    else return null;                // errore: niente cache, si usa il dato storico
  } catch (e) { return null; }
  cache.set(key, { t: Date.now(), v });
  return v;
}

export function licenseStore() {
  const raw = getStore('licenses');
  return {
    raw,
    list: (...a) => raw.list(...a),
    setJSON: (...a) => raw.setJSON(...a),
    delete: (...a) => raw.delete(...a),
    async get(key, opts) {
      const rec = await raw.get(key, opts);
      if (!rec || typeof rec !== 'object') return rec;
      const ov = await overlay(key);
      if (!ov) return rec;
      const out = { ...rec, status: ov.attiva ? 'active' : 'suspended' };
      for (const [code, field] of Object.entries(FLAG)) out[field] = !!(ov.funzioni && ov.funzioni[code]);
      return out;
    }
  };
}
