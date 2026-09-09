import { getStore } from '@netlify/blobs';

// Modello economico: adatto a compiti brevi e mirati come questi (non serve un modello più potente/costoso).
const MODEL = 'claude-haiku-4-5-20251001';
const MONTHLY_LIMIT = 50;

function currentMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function callClaude(system, userContent, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('missing_api_key');
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userContent }]
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('api_error: ' + errText.slice(0, 300));
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  return textBlock ? textBlock.text : '';
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

  // 1) La licenza deve essere valida e avere EstimlyAI abilitato
  const licenses = getStore('licenses');
  const license = await licenses.get(key, { type: 'json' });
  if (!license || license.status !== 'active') {
    return new Response(JSON.stringify({ error: 'invalid_license' }), { status: 401 });
  }
  if (!license.aiEnabled) {
    return new Response(JSON.stringify({ error: 'ai_not_enabled' }), { status: 403 });
  }

  // 2) Tetto mensile rigido, indipendente dalla logica applicativa
  const usageStore = getStore('ai-usage');
  const usageKey = `${key}:${currentMonthKey()}`;
  const usage = (await usageStore.get(usageKey, { type: 'json' })) || { count: 0 };

  if (usage.count >= MONTHLY_LIMIT) {
    return new Response(JSON.stringify({
      error: 'limit_reached',
      used: usage.count,
      limit: MONTHLY_LIMIT
    }), { status: 429 });
  }

  const mode = body.mode;

  try {
    if (mode === 'generate') {
      const description = (body.description || '').trim();
      const catalog = Array.isArray(body.catalog) ? body.catalog : [];
      if (!description || catalog.length === 0) {
        return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400 });
      }

      const catalogText = catalog
        .map((c) => `${c.codice} | ${c.nome} | categoria: ${c.categoria}`)
        .join('\n');

      const system = `Sei un assistente che aiuta uno studio di architettura/interior design a comporre un preventivo. ` +
        `Ricevi la descrizione del lavoro e l'elenco del catalogo voci disponibili. ` +
        `Rispondi SOLO con un array JSON valido, senza testo aggiuntivo, nel formato: ` +
        `[{"codice":"A01","quantita":1}, ...]. ` +
        `Usa ESCLUSIVAMENTE codici presenti nel catalogo fornito. Non inventare codici. ` +
        `Se non sei sicuro di una voce, non includerla. Massimo 12 voci.`;

      const userContent = `CATALOGO:\n${catalogText}\n\nDESCRIZIONE DEL LAVORO:\n${description}`;

      const raw = await callClaude(system, userContent, 800);
      let items;
      try {
        const cleaned = raw.trim().replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '');
        items = JSON.parse(cleaned);
      } catch (e) {
        return new Response(JSON.stringify({ error: 'parse_error', raw }), { status: 502 });
      }

      // Filtro di sicurezza: accetta solo codici realmente presenti nel catalogo inviato
      const validCodes = new Set(catalog.map((c) => c.codice));
      items = (Array.isArray(items) ? items : []).filter((it) => it && validCodes.has(it.codice));

      usage.count += 1;
      await usageStore.setJSON(usageKey, usage);

      return new Response(JSON.stringify({ items, used: usage.count, limit: MONTHLY_LIMIT }), { status: 200 });
    }

    if (mode === 'improve_text') {
      const text = (body.text || '').trim();
      if (!text) {
        return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400 });
      }
      const context = body.context || 'testo del preventivo';

      const system = `Sei un assistente di scrittura per un preventivo professionale di uno studio di architettura/interior design. ` +
        `Riscrivi il testo fornito (${context}) in italiano professionale, chiaro e conciso. ` +
        `Non aggiungere informazioni non presenti nel testo originale. ` +
        `Rispondi SOLO con il testo riscritto, senza spiegazioni, virgolette o testo aggiuntivo.`;

      const improved = await callClaude(system, text, 300);

      usage.count += 1;
      await usageStore.setJSON(usageKey, usage);

      return new Response(JSON.stringify({ improved: improved.trim(), used: usage.count, limit: MONTHLY_LIMIT }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: 'unknown_mode' }), { status: 400 });
  } catch (err) {
    const msg = err && err.message === 'missing_api_key'
      ? 'EstimlyAI non è configurato (manca la chiave API sul server).'
      : 'Errore nella richiesta AI.';
    return new Response(JSON.stringify({ error: 'server_error', message: msg }), { status: 500 });
  }
};
