// Amministrazione: domini extra ammessi per i link di presentazione (oltre a Canva, View e all'elenco fisso).
// Protetta come admin-keys (x-admin-password). Azioni: list | add {dominio} | remove {dominio}.
import { getStore } from '@netlify/blobs';
import { HOSTS_STORE, HOSTS_KEY, dominioValido } from './canva-url.js';

export default async (req) => {
  const out = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return out({ error: 'method not allowed' }, 405);
  const auth = req.headers.get('x-admin-password');
  if (!auth || auth !== process.env.ADMIN_PASSWORD) return out({ error: 'unauthorized' }, 401);
  let body; try { body = await req.json(); } catch (e) { return out({ error: 'invalid body' }, 400); }
  const store = getStore(HOSTS_STORE);
  let list = (await store.get(HOSTS_KEY, { type: 'json', consistency: 'strong' })) || [];
  if (!Array.isArray(list)) list = [];
  if (body.action === 'list') return out({ ok: true, domini: list });
  const d = dominioValido(body.dominio);
  if (!d) return out({ error: 'dominio non valido (es. esempio.it, senza https:// e senza percorso)' }, 400);
  if (body.action === 'add') { if (!list.includes(d)) list.push(d); }
  else if (body.action === 'remove') list = list.filter((x) => x !== d);
  else return out({ error: 'azione sconosciuta' }, 400);
  await store.setJSON(HOSTS_KEY, list);
  return out({ ok: true, domini: list });
};
