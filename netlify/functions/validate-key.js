import { getStore } from '@netlify/blobs';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ valid: false, error: 'method not allowed' }), { status: 405 });
  }

  let key;
  try {
    const body = await req.json();
    key = (body.key || '').trim().toUpperCase();
  } catch (err) {
    return new Response(JSON.stringify({ valid: false }), { status: 400 });
  }

  if (!key) {
    return new Response(JSON.stringify({ valid: false }), { status: 400 });
  }

  try {
    const store = getStore('licenses');
    const record = await store.get(key, { type: 'json' });

    if (!record || record.status !== 'active') {
      return new Response(JSON.stringify({ valid: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    record.lastValidatedAt = new Date().toISOString();
    record.validationCount = (record.validationCount || 0) + 1;
    await store.setJSON(key, record);

    return new Response(JSON.stringify({ valid: true, customer: record.customer }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ valid: false, error: 'server error' }), { status: 500 });
  }
};
