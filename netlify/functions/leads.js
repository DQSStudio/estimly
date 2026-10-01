import { getStore } from '@netlify/blobs';

// ===================== Lettura e gestione lead (Estimly 2.0) =====================
// I lead vengono creati da inbound-lead.js (webhook Resend -> estrazione AI) e salvati nello
// store 'leads' (array per licenza, più recenti in testa). Questa function serve il frontend:
// elenco, cambio fase nella pipeline, eliminazione.

const VALID_FASI = ['nuova', 'contattato', 'preventivo_inviato', 'vinto', 'perso'];

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 });
  }

  const key = (body.key || '').trim().toUpperCase();
  if (!key) {
    return new Response(JSON.stringify({ error: 'missing_key' }), { status: 400 });
  }

  const licenses = getStore('licenses');
  const license = await licenses.get(key, { type: 'json' });
  if (!license || license.status !== 'active') {
    return new Response(JSON.stringify({ error: 'invalid_license' }), { status: 401 });
  }

  const leadsStore = getStore('leads');
  const action = body.action;

  if (action === 'list') {
    const list = (await leadsStore.get(key, { type: 'json' })) || [];
    return new Response(JSON.stringify({ leads: list }), { status: 200 });
  }

  if (action === 'updateStage') {
    const { leadId, fase } = body;
    if (!leadId || !VALID_FASI.includes(fase)) {
      return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400 });
    }
    const list = (await leadsStore.get(key, { type: 'json' })) || [];
    const entry = list.find((l) => l.id === leadId);
    if (!entry) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }
    entry.fase = fase;
    entry.aggiornatoAt = new Date().toISOString();
    await leadsStore.setJSON(key, list);
    return new Response(JSON.stringify({ ok: true, lead: entry }), { status: 200 });
  }

  if (action === 'delete') {
    const { leadId } = body;
    if (!leadId) {
      return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400 });
    }
    const list = (await leadsStore.get(key, { type: 'json' })) || [];
    const filtered = list.filter((l) => l.id !== leadId);
    await leadsStore.setJSON(key, filtered);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  return new Response(JSON.stringify({ error: 'unknown_action' }), { status: 400 });
};
