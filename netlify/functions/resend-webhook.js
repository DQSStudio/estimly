import { getStore } from '@netlify/blobs';

// Soglie per gli stati colorati (v1: nessun punteggio numerico, solo stati).
function computeStatus(entry) {
  const opens = entry.events.filter(e => e.type === 'aperto').length;
  const clicks = entry.events.filter(e => e.type === 'cliccato').length;
  if (['convertito', 'risposto', 'accettato', 'rifiutato', 'non_interessato'].includes(entry.status)) {
    return entry.status;
  }
  if (clicks >= 2 || opens >= 3) return 'caldo';
  if (clicks >= 1) return 'attivo';
  if (opens >= 1) return 'interessato';
  return 'freddo';
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  let payload;
  try {
    payload = await req.json();
  } catch (e) {
    return new Response('invalid body', { status: 400 });
  }

  const eventType = payload.type; // es. 'email.opened', 'email.clicked'
  const tags = (payload.data && payload.data.tags) || [];
  const tagMap = {};
  tags.forEach(t => { tagMap[t.name] = t.value; });

  const followupId = tagMap.followup_id;
  const licenseKey = (tagMap.license_key || '').toUpperCase();
  if (!followupId || !licenseKey) {
    // Non è un'email legata a un follow-up Estimly: ignoriamo senza errore.
    return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });
  }

  const followupsStore = getStore('followups');
  const list = (await followupsStore.get(licenseKey, { type: 'json' })) || [];
  const entry = list.find(f => f.id === followupId);
  if (!entry) {
    return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });
  }

  const eventMap = {
    'email.opened': 'aperto',
    'email.clicked': 'cliccato',
    'email.bounced': 'non_recapitato',
    'email.complained': 'segnalato_spam'
  };
  const mapped = eventMap[eventType];
  if (mapped) {
    entry.events.push({ type: mapped, at: new Date().toISOString() });
    entry.status = computeStatus(entry);
    await followupsStore.setJSON(licenseKey, list);
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};
