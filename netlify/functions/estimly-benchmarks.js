import { getStore } from '@netlify/blobs';

// Stesso progetto Supabase già usato da test-supabase.js per l'ecosistema Desearq.
const SUPABASE_URL = 'https://qgeiehavpnqdxqnggfzq.supabase.co';
const TABLE = 'estimly_benchmarks';

const TIPI_PROGETTO = ['Appartamento', 'Villa', 'Ufficio', 'Negozio', 'Hotel'];
const INTERVENTI = ['Ristrutturazione completa', 'Ristrutturazione parziale', 'Nuova costruzione', 'Interior design'];

function sortedNums(arr) {
  return arr.filter((n) => typeof n === 'number' && !Number.isNaN(n)).sort((a, b) => a - b);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function midpoint(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return (a + b) / 2;
  if (typeof a === 'number') return a;
  if (typeof b === 'number') return b;
  return null;
}

function affidabilitaFromCampione(n) {
  if (n >= 10) return 'alta';
  if (n >= 3) return 'media';
  if (n >= 1) return 'bassa';
  return 'nessun_dato';
}

function summarizeOre(rows) {
  const points = rows
    .map((r) => (typeof r.ore_precise === 'number' ? r.ore_precise : midpoint(r.ore_min, r.ore_max)))
    .filter((n) => typeof n === 'number' && !Number.isNaN(n));
  const sorted = sortedNums(points);
  if (sorted.length === 0) return null;
  if (sorted.length < 4) {
    return { min: sorted[0], max: sorted[sorted.length - 1], campione: sorted.length };
  }
  return {
    min: Math.round(percentile(sorted, 0.25)),
    max: Math.round(percentile(sorted, 0.75)),
    campione: sorted.length
  };
}

function summarizeDurata(rows) {
  const points = rows
    .map((r) => midpoint(r.durata_mesi_min, r.durata_mesi_max))
    .filter((n) => typeof n === 'number' && !Number.isNaN(n));
  const sorted = sortedNums(points);
  if (sorted.length === 0) return null;
  if (sorted.length < 4) {
    return { min: sorted[0], max: sorted[sorted.length - 1] };
  }
  return {
    min: Math.round(percentile(sorted, 0.25) * 10) / 10,
    max: Math.round(percentile(sorted, 0.75) * 10) / 10
  };
}

async function fetchBenchmarkRows(anonKey, params) {
  const url = `${SUPABASE_URL}/rest/v1/${TABLE}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` }
  });
  if (!res.ok) {
    throw new Error('supabase_read_error: ' + (await res.text()).slice(0, 300));
  }
  return res.json();
}

async function estimate(anonKey, body) {
  const tipoProgetto = (body.tipoProgetto || '').trim();
  const intervento = (body.intervento || '').trim();
  const superficie = Number(body.superficie);
  if (!tipoProgetto || !intervento) {
    return { error: 'missing_fields' };
  }

  const baseParams = () => {
    const p = new URLSearchParams();
    p.set('select', 'ore_min,ore_max,ore_precise,durata_mesi_min,durata_mesi_max,superficie_mq');
    p.set('tipo_progetto', `eq.${tipoProgetto}`);
    p.set('intervento', `eq.${intervento}`);
    p.set('limit', '300');
    return p;
  };

  let fallback = false;
  let rows = [];

  if (Number.isFinite(superficie) && superficie > 0) {
    const p = baseParams();
    p.set('superficie_mq', `gte.${Math.round(superficie * 0.7)}`);
    p.append('superficie_mq', `lte.${Math.round(superficie * 1.3)}`);
    // PostgREST richiede filtri ripetuti sulla stessa colonna come query params distinti con stessa chiave
    rows = await fetchBenchmarkRows(anonKey, p);
  }

  if (rows.length < 3) {
    fallback = true;
    rows = await fetchBenchmarkRows(anonKey, baseParams());
  }

  const ore = summarizeOre(rows);
  const durata = summarizeDurata(rows);
  const campione = rows.length;

  return {
    oreMin: ore ? ore.min : null,
    oreMax: ore ? ore.max : null,
    durataMesiMin: durata ? durata.min : null,
    durataMesiMax: durata ? durata.max : null,
    affidabilita: affidabilitaFromCampione(campione),
    campioneSimili: campione,
    filtroAllargato: fallback
  };
}

async function summary(anonKey, body) {
  const tipoProgetto = (body.tipoProgetto || '').trim();
  const p = new URLSearchParams();
  p.set('select', 'ore_min,ore_max,ore_precise,superficie_mq,zona');
  if (tipoProgetto) p.set('tipo_progetto', `eq.${tipoProgetto}`);
  p.set('limit', '1000');
  const rows = await fetchBenchmarkRows(anonKey, p);

  const ratios = [];
  const zonaRatios = new Map();
  for (const r of rows) {
    const ore = typeof r.ore_precise === 'number' ? r.ore_precise : midpoint(r.ore_min, r.ore_max);
    if (typeof ore !== 'number' || !(r.superficie_mq > 0)) continue;
    const ratio = ore / r.superficie_mq;
    ratios.push(ratio);
    if (r.zona) {
      const z = String(r.zona).trim();
      if (!zonaRatios.has(z)) zonaRatios.set(z, []);
      zonaRatios.get(z).push(ratio);
    }
  }

  const avg = (arr) => (arr.length ? arr.reduce((s, n) => s + n, 0) / arr.length : null);
  const oreMedieMq = avg(ratios);

  const perZona = Array.from(zonaRatios.entries())
    .map(([zona, arr]) => ({ zona, oreMedieMq: avg(arr), campione: arr.length }))
    .sort((a, b) => b.campione - a.campione)
    .slice(0, 5);

  return {
    totaleProgetti: rows.length,
    oreMedieMq: oreMedieMq != null ? Math.round(oreMedieMq * 100) / 100 : null,
    perZona
  };
}

async function contribute(anonKey, body) {
  const tipoProgetto = (body.tipoProgetto || '').trim();
  const intervento = (body.intervento || '').trim();
  if (!TIPI_PROGETTO.includes(tipoProgetto) || !INTERVENTI.includes(intervento)) {
    return { error: 'invalid_fields' };
  }

  const row = {
    tipo_progetto: tipoProgetto,
    intervento,
    superficie_mq: Number.isFinite(Number(body.superficie)) ? Number(body.superficie) : null,
    servizi: Array.isArray(body.servizi) ? body.servizi.slice(0, 20).map(String) : [],
    complessita: body.complessita ? String(body.complessita).slice(0, 40) : null,
    zona: body.zona ? String(body.zona).slice(0, 80) : null,
    ore_min: Number.isFinite(Number(body.oreMin)) ? Number(body.oreMin) : null,
    ore_max: Number.isFinite(Number(body.oreMax)) ? Number(body.oreMax) : null,
    ore_precise: Number.isFinite(Number(body.orePrecise)) ? Number(body.orePrecise) : null,
    durata_mesi_min: Number.isFinite(Number(body.durataMesiMin)) ? Number(body.durataMesiMin) : null,
    durata_mesi_max: Number.isFinite(Number(body.durataMesiMax)) ? Number(body.durataMesiMax) : null,
    affidabilita_dato: body.orePrecise ? 'esatto' : 'fascia',
    fonte: body.fonte === 'storico' ? 'storico' : 'nuovo'
  };

  if (!row.ore_min && !row.ore_max && !row.ore_precise) {
    return { error: 'missing_ore' };
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(row)
  });
  if (!res.ok) {
    throw new Error('supabase_write_error: ' + (await res.text()).slice(0, 300));
  }
  return { ok: true };
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const key = (body.key || '').trim().toUpperCase();
  if (!key) {
    return new Response(JSON.stringify({ error: 'missing key' }), { status: 400 });
  }

  const licenses = getStore('licenses');
  const license = await licenses.get(key, { type: 'json' });
  if (!license || license.status !== 'active') {
    return new Response(JSON.stringify({ error: 'invalid_license' }), { status: 401 });
  }

  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!anonKey) {
    return new Response(JSON.stringify({ error: 'server_error', message: 'Database benchmark non configurato.' }), { status: 500 });
  }

  try {
    if (body.mode === 'estimate') {
      const result = await estimate(anonKey, body);
      if (result.error) {
        return new Response(JSON.stringify(result), { status: 400 });
      }
      return new Response(JSON.stringify(result), { status: 200 });
    }

    if (body.mode === 'summary') {
      const result = await summary(anonKey, body);
      return new Response(JSON.stringify(result), { status: 200 });
    }

    if (body.mode === 'contribute') {
      const result = await contribute(anonKey, body);
      if (result.error) {
        return new Response(JSON.stringify(result), { status: 400 });
      }
      return new Response(JSON.stringify(result), { status: 200 });
    }

    return new Response(JSON.stringify({ error: 'unknown_mode' }), { status: 400 });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'server_error', message: String(err.message || err) }), { status: 500 });
  }
};
