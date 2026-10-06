import { getStore } from '@netlify/blobs';

// Sequenza di default se lo studio non ne sceglie una diversa per il singolo preventivo
// (vedi sanitizeSequenceDays): promemoria dopo 3, 7 e 14 giorni dall'attivazione.
const DEFAULT_SEQUENCE_DAYS = [3, 7, 14];

function addDaysIso(fromIso, days) {
  const d = new Date(fromIso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// Lo studio può personalizzare, per ogni preventivo/cliente, dopo quanti giorni mandare ogni
// promemoria (o disattivarne alcuni), dal box "Promemoria automatici" nell'editor del
// preventivo. Qui si valida quanto arriva dal client: solo numeri interi tra 1 e 120 giorni,
// in ordine crescente; un array vuoto è valido e significa "nessun promemoria automatico, solo
// tracciamento" (lo studio ha deselezionato tutti e tre). Se il campo manca o non è un array
// (versioni precedenti del client, o chiamata diretta all'API) si usa la sequenza di default.
function sanitizeSequenceDays(input) {
  if (!Array.isArray(input)) return DEFAULT_SEQUENCE_DAYS;
  const days = input
    .map((d) => Math.trunc(Number(d)))
    .filter((d) => Number.isFinite(d) && d > 0 && d <= 120);
  return Array.from(new Set(days)).sort((a, b) => a - b);
}

// null quando la sequenza è vuota (nessun promemoria automatico scelto per questo preventivo):
// il follow-up resta attivo per tracciare apertura/click/firma, ma followup-cron.js non ha
// nulla da inviare (step < sequenceDays.length è già falso con lunghezza 0).
function nextDueForSequence(fromIso, sequenceDays) {
  return sequenceDays.length ? addDaysIso(fromIso, sequenceDays[0]) : null;
}

// Follow-up "di presentazione": parte dalla richiesta (lead) prima che esista un preventivo.
// quoteRef è 'pres_<leadId>', quindi non si scontra mai con i numeri di preventivo. linkUrl è la
// pagina pubblica della presentazione, usata anche nei promemoria automatici (followup-cron.js).
function presentationFields(f) {
  if (f.kind !== 'presentazione') return {};
  let linkUrl = '';
  try { linkUrl = f.linkUrl ? new URL(String(f.linkUrl)).href : ''; } catch (e) { linkUrl = ''; }
  return { kind: 'presentazione', leadId: String(f.leadId || ''), linkUrl };
}

// Quando parte il follow-up del preventivo di una richiesta, quello della presentazione
// precedente si chiude: il cliente non deve ricevere due sequenze di promemoria insieme.
function supersedePresentation(list, f, nowIso) {
  if (f.kind === 'presentazione' || !f.leadId) return;
  list.forEach((x) => {
    if (x.kind === 'presentazione' && x.leadId === String(f.leadId) && x.active) {
      x.active = false;
      x.events.push({ type: 'sostituito_da_preventivo', at: nowIso });
    }
  });
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
    const sequenceDays = sanitizeSequenceDays(f.sequenceDays);
    const entry = {
      id: 'fu_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      quoteRef: f.quoteRef,
      numero: f.numero || '',
      clienteNome: f.clienteNome || '',
      clienteEmail: f.clienteEmail,
      oggetto: f.oggetto || '',
      totale: f.totale || '',
      ...presentationFields(f),
      status: 'freddo',
      step: 0,
      active: true,
      startedAt: now,
      sequenceDays,
      nextDueAt: nextDueForSequence(now, sequenceDays),
      events: [{ type: 'attivato', at: now }]
    };
    supersedePresentation(list, f, now);
    // Se esisteva già un follow-up per lo stesso preventivo, lo sostituisce (si riparte da zero).
    const filtered = list.filter(x => x.quoteRef !== f.quoteRef);
    filtered.push(entry);
    await followupsStore.setJSON(key, filtered);
    return new Response(JSON.stringify({ ok: true, followup: entry }), { status: 200 });
  }

  if (body.action === 'send') {
    const f = body.followup || {};
    if (!f.quoteRef || !f.clienteEmail || !f.html) {
      return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400 });
    }

    const dataStore = getStore('studio-data');
    const studioData = await dataStore.get(key, { type: 'json' });
    const settings = (studioData && studioData.studioSettings) || {};
    const resendKey = settings.resendApiKey;
    const fromEmail = settings.resendFromEmail;
    const fromName = settings.resendFromName || settings.nome || 'Studio';
    if (!resendKey || !fromEmail) {
      return new Response(JSON.stringify({ error: 'email_not_configured' }), { status: 400 });
    }

    const now = new Date().toISOString();
    const sequenceDays = sanitizeSequenceDays(f.sequenceDays);
    let entry = list.find((x) => x.quoteRef === f.quoteRef);
    if (!entry) {
      entry = {
        id: 'fu_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
        quoteRef: f.quoteRef,
        numero: f.numero || '',
        clienteNome: f.clienteNome || '',
        clienteEmail: f.clienteEmail,
        oggetto: f.oggetto || '',
        totale: f.totale || '',
        ...presentationFields(f),
        status: 'freddo',
        step: 0,
        active: true,
        startedAt: now,
        sequenceDays,
        nextDueAt: nextDueForSequence(now, sequenceDays),
        events: []
      };
      list.push(entry);
    } else {
      // Un nuovo invio del preventivo riparte con il conteggio dei promemoria automatici,
      // ma mantiene tutta la cronologia eventi precedente. La sequenza scelta in questo invio
      // (anche se diversa da quella di un'eventuale attivazione precedente) è quella che vale
      // da qui in avanti.
      entry.clienteEmail = f.clienteEmail;
      entry.clienteNome = f.clienteNome || entry.clienteNome;
      entry.numero = f.numero || entry.numero;
      entry.oggetto = f.oggetto || entry.oggetto;
      entry.totale = f.totale || entry.totale;
      Object.assign(entry, presentationFields(f));
      entry.step = 0;
      entry.active = true;
      entry.startedAt = now;
      entry.sequenceDays = sequenceDays;
      entry.nextDueAt = nextDueForSequence(now, sequenceDays);
    }

    supersedePresentation(list, f, now);
    const isPres = f.kind === 'presentazione';
    const subject = f.subject || (isPres ? 'La nostra presentazione' : `Preventivo${f.numero ? ' n. ' + f.numero : ''}`);
    // Allegato PDF opzionale (copia del preventivo da conservare): generato lato client
    // (buildQuotePdfBase64 in index.html) e passato qui come base64 grezzo, nel formato
    // atteso dall'API Resend (`attachments[].content`). La firma resta sempre tramite il
    // link online, mai tramite questo allegato.
    const attachment = body.attachment;
    const attachments = (attachment && attachment.filename && attachment.contentBase64)
      ? [{ filename: attachment.filename, content: attachment.contentBase64 }]
      : undefined;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resendKey}`
        },
        body: JSON.stringify({
          from: `${fromName} <${fromEmail}>`,
          to: f.clienteEmail,
          subject,
          html: f.html,
          ...(attachments ? { attachments } : {}),
          tags: [
            { name: 'followup_id', value: entry.id },
            { name: 'license_key', value: key.toLowerCase() }
          ]
        })
      });
      if (!res.ok) {
        const detail = await res.text();
        return new Response(JSON.stringify({ error: 'send_failed', detail }), { status: 502 });
      }
    } catch (e) {
      return new Response(JSON.stringify({ error: 'send_failed', detail: String(e) }), { status: 502 });
    }

    entry.events.push({ type: isPres ? 'inviato_presentazione' : 'inviato_preventivo', at: now });
    await followupsStore.setJSON(key, list);
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

  // Elimina il follow-up (es. email inviata per sbaglio): spariscono dalla lista e i promemoria
  // automatici si fermano. L'email già partita ovviamente non si può richiamare.
  if (body.action === 'delete') {
    const { followupId } = body;
    if (!followupId) {
      return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400 });
    }
    const fresh = (await followupsStore.get(key, { type: 'json', consistency: 'strong' })) || [];
    const filtered = fresh.filter(x => x.id !== followupId);
    if (filtered.length === fresh.length) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }
    await followupsStore.setJSON(key, filtered);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  // Riporta un follow-up concluso (accettato/rifiutato/disattivato...) in "da seguire".
  if (body.action === 'reopen') {
    const { followupId } = body;
    const fresh = (await followupsStore.get(key, { type: 'json', consistency: 'strong' })) || [];
    const entry = fresh.find(x => x.id === followupId);
    if (!entry) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }
    entry.active = true;
    if (entry.status === 'convertito') entry.status = 'freddo';
    entry.events = entry.events || [];
    entry.events.push({ type: 'riaperto', at: new Date().toISOString() });
    await followupsStore.setJSON(key, fresh);
    return new Response(JSON.stringify({ ok: true, followup: entry }), { status: 200 });
  }

  return new Response(JSON.stringify({ error: 'unknown_action' }), { status: 400 });
};
