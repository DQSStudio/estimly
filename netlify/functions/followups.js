import { getStore } from '@netlify/blobs';

// Sequenza fissa per la v1: promemoria dopo 3, 7 e 14 giorni dall'attivazione.
const SEQUENCE_DAYS = [3, 7, 14];

function addDaysIso(fromIso, days) {
  const d = new Date(fromIso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
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

  const followupsStore = getStore('followups');
  const list = (await followupsStore.get(key, { type: 'json' })) || [];

  if (body.action === 'list') {
    return new Response(JSON.stringify({ followups: list }), { status: 200 });
  }

  if (body.action === 'start') {
    const f = body.followup || {};
    if (!f.quoteRef || !f.clienteEmail) {
      return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400 });
    }
    const now = new Date().toISOString();
    const entry = {
      id: 'fu_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      quoteRef: f.quoteRef,
      numero: f.numero || '',
      clienteNome: f.clienteNome || '',
      clienteEmail: f.clienteEmail,
      oggetto: f.oggetto || '',
      totale: f.totale || '',
      status: 'freddo',
      step: 0,
      active: true,
      startedAt: now,
      nextDueAt: addDaysIso(now, SEQUENCE_DAYS[0]),
      events: [{ type: 'attivato', at: now }]
    };
    // Se esisteva già un follow-up per lo stesso preventivo, lo sostituisce (si riparte da zero).
    const filtered = list.filter(x => x.quoteRef !== f.quoteRef);
    filtered.push(entry);
    await followupsStore.setJSON(key, filtered);
    return new Response(JSON.stringify({ ok: true, followup: entry }), { status: 200 });
  }

  if (body.action === 'updateStatus') {
    const { followupId, newStatus } = body;
    const entry = list.find(x => x.id === followupId);
    if (!entry) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }
    const now = new Date().toISOString();
    const stopStatuses = ['risposto', 'accettato', 'rifiutato', 'non_interessato', 'disattivato'];
    entry.events.push({ type: newStatus, at: now });
    if (stopStatuses.includes(newStatus)) {
      entry.active = false;
      entry.status = newStatus === 'accettato' ? 'convertito' : entry.status;
    }
    if (newStatus === 'disattivato') entry.status = entry.status; // resta l'ultimo stato raggiunto
    await followupsStore.setJSON(key, list);
    return new Response(JSON.stringify({ ok: true, followup: entry }), { status: 200 });
  }

  return new Response(JSON.stringify({ error: 'unknown_action' }), { status: 400 });
};
