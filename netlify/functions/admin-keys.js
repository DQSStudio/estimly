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

  return new Response(JSON.stringify({ error: 'unknown action' }), { status: 400 });
};
