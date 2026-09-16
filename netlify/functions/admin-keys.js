import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

function generateKey(prefix) {
  const part = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${part()}-${part()}-${part()}`;
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }

  const auth = req.headers.get('x-admin-password');
  if (!auth || auth !== process.env.ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const store = getStore('licenses');
  const action = body.action;

  if (action === 'list') {
    const { blobs } = await store.list();
    const items = await Promise.all(
      blobs.map(async (b) => {
        const record = await store.get(b.key, { type: 'json' });
        return { key: b.key, ...record };
      })
    );
    items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return new Response(JSON.stringify({ items }), { status: 200 });
  }

  if (action === 'add') {
    const customer = (body.customer || '').trim();
    if (!customer) {
      return new Response(JSON.stringify({ error: 'customer required' }), { status: 400 });
    }
    const key = generateKey('DQSS');
    const record = {
      customer,
      status: 'active',
      aiEnabled: !!body.aiEnabled,
      createdAt: new Date().toISOString(),
      validationCount: 0
    };
    await store.setJSON(key, record);
    return new Response(JSON.stringify({ key, ...record }), { status: 200 });
  }

  if (action === 'revoke' || action === 'activate') {
    const key = (body.key || '').trim().toUpperCase();
    const record = await store.get(key, { type: 'json' });
    if (!record) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }
    record.status = action === 'revoke' ? 'revoked' : 'active';
    await store.setJSON(key, record);
    return new Response(JSON.stringify({ key, ...record }), { status: 200 });
  }

  if (action === 'setAi') {
    const key = (body.key || '').trim().toUpperCase();
    const record = await store.get(key, { type: 'json' });
    if (!record) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }
    record.aiEnabled = !!body.aiEnabled;
    await store.setJSON(key, record);
    return new Response(JSON.stringify({ key, ...record }), { status: 200 });
  }

  if (action === 'exportData') {
    const key = (body.key || '').trim().toUpperCase();
    const license = await store.get(key, { type: 'json' });
    if (!license) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }
    const dataStore = getStore('studio-data');
    const data = (await dataStore.get(key, { type: 'json' })) || {};
    return new Response(JSON.stringify({
      key,
      customer: license.customer,
      exportedAt: new Date().toISOString(),
      data
    }), { status: 200 });
  }

  if (action === 'importData') {
    const key = (body.key || '').trim().toUpperCase();
    const license = await store.get(key, { type: 'json' });
    if (!license) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }
    if (!body.data || typeof body.data !== 'object') {
      return new Response(JSON.stringify({ error: 'missing_data' }), { status: 400 });
    }
    const dataStore = getStore('studio-data');
    const backupsStore = getStore('studio-data-backups');
    const current = await dataStore.get(key, { type: 'json' });
    if (current) {
      await backupsStore.setJSON(key, { savedAt: new Date().toISOString(), data: current });
    }
    const record = {
      catalog: Array.isArray(body.data.catalog) ? body.data.catalog : [],
      studioSettings: body.data.studioSettings || {},
      categoryOrder: Array.isArray(body.data.categoryOrder) ? body.data.categoryOrder : [],
      savedQuotes: Array.isArray(body.data.savedQuotes) ? body.data.savedQuotes : [],
      updatedAt: new Date().toISOString()
    };
    await dataStore.setJSON(key, record);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  return new Response(JSON.stringify({ error: 'unknown action' }), { status: 400 });
};
