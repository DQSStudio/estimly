import { getStore } from '@netlify/blobs';

const MAX_SAVED_QUOTES = 10;

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
    return new Response(JSON.stringify({ error: 'invalid license' }), { status: 401 });
  }

  const dataStore = getStore('studio-data');

  if (body.action === 'load') {
    const record = await dataStore.get(key, { type: 'json' });
    if (!record) {
      return new Response(JSON.stringify({ found: false, savedQuotes: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      found: true,
      catalog: record.catalog,
      studioSettings: record.studioSettings,
      categoryOrder: record.categoryOrder,
      savedQuotes: Array.isArray(record.savedQuotes) ? record.savedQuotes : []
    }), { status: 200 });
  }

  if (body.action === 'save') {
    const existing = await dataStore.get(key, { type: 'json' });
    const record = {
      catalog: Array.isArray(body.catalog) ? body.catalog : [],
      studioSettings: body.studioSettings || {},
      categoryOrder: Array.isArray(body.categoryOrder) ? body.categoryOrder : [],
      savedQuotes: existing && Array.isArray(existing.savedQuotes) ? existing.savedQuotes : [],
      updatedAt: new Date().toISOString()
    };
    await dataStore.setJSON(key, record);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  if (body.action === 'saveQuote') {
    if (!body.quote || typeof body.quote !== 'object') {
      return new Response(JSON.stringify({ error: 'missing quote' }), { status: 400 });
    }
    const existing = (await dataStore.get(key, { type: 'json' })) || {};
    const savedQuotes = Array.isArray(existing.savedQuotes) ? existing.savedQuotes : [];
    const entry = {
      id: 'q_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      savedAt: new Date().toISOString(),
      cart: Array.isArray(body.quote.cart) ? body.quote.cart : [],
      idCounter: body.quote.idCounter || 1,
      client: body.quote.client || {}
    };
    const updated = [entry, ...savedQuotes].slice(0, MAX_SAVED_QUOTES);
    const record = {
      catalog: existing.catalog || [],
      studioSettings: existing.studioSettings || {},
      categoryOrder: existing.categoryOrder || [],
      savedQuotes: updated,
      updatedAt: new Date().toISOString()
    };
    await dataStore.setJSON(key, record);
    return new Response(JSON.stringify({ ok: true, savedQuotes: updated }), { status: 200 });
  }

  if (body.action === 'deleteQuote') {
    if (!body.id) {
      return new Response(JSON.stringify({ error: 'missing id' }), { status: 400 });
    }
    const existing = (await dataStore.get(key, { type: 'json' })) || {};
    const savedQuotes = Array.isArray(existing.savedQuotes) ? existing.savedQuotes : [];
    const updated = savedQuotes.filter((q) => q.id !== body.id);
    const record = {
      catalog: existing.catalog || [],
      studioSettings: existing.studioSettings || {},
      categoryOrder: existing.categoryOrder || [],
      savedQuotes: updated,
      updatedAt: new Date().toISOString()
    };
    await dataStore.setJSON(key, record);
    return new Response(JSON.stringify({ ok: true, savedQuotes: updated }), { status: 200 });
  }

  return new Response(JSON.stringify({ error: 'unknown action' }), { status: 400 });
};
