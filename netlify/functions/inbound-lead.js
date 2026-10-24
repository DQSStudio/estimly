import { getStore } from '@netlify/blobs';
import { licenseStore } from './lib/licenze.js';

// ===================== Ricezione lead via mail (Estimly 2.0) =====================
// Ogni studio configura la ricezione email sul proprio account Resend (lo stesso già usato
// per l'invio, in studioSettings.resendApiKey/resendFromEmail) e registra un webhook
// 'email.received' puntato a questa function, con la propria chiave di licenza nella query
// string: /.netlify/functions/inbound-lead?key=XXXX. Non serve un account/dominio condiviso:
// ogni studio resta sul proprio Resend, lo stesso account di invio.
//
// Il webhook di Resend NON include il corpo della mail (solo i metadati): va richiesto a
// parte con l'API "Received emails", usando la chiave Resend DELLO STUDIO (non una chiave
// Estimly globale).
//
// Niente estrazione AI: la richiesta arriva "grezza" (mittente/oggetto/testo) nella sezione
// "Richieste" di Estimly 2.0, dove si gestisce a mano la fase della pipeline, la provenienza
// e la creazione del contatto cliente in Rubrica quando si trasforma in preventivo. Il nome
// e l'email del mittente vengono comunque riconosciuti leggendo l'intestazione "From" della
// mail (nessuna chiamata esterna, istantaneo).

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchReceivedEmail(resendApiKey, emailId) {
  const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
    headers: { Authorization: `Bearer ${resendApiKey}` }
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('resend_fetch_failed: ' + errText.slice(0, 300));
  }
  return res.json();
}

// Riconosce nome ed email dall'intestazione "From", nei formati più comuni:
// 'Mario Rossi <mario@rossi.it>' oppure solo 'mario@rossi.it'.
function parseMittente(from) {
  const str = String(from || '').trim();
  const match = str.match(/^"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (match) {
    return { nome: match[1].trim(), email: match[2].trim() };
  }
  return { nome: '', email: str };
}

// Data in cui la richiesta è stata davvero inviata (non quella in cui Estimly l'ha elaborata):
// usa la data della mail restituita da Resend, con ripiego su quella del webhook e, solo in
// mancanza, su adesso.
function originalDate(email, payload) {
  const candidates = [email && email.created_at, email && email.date, payload && payload.data && payload.data.created_at, payload && payload.created_at];
  for (const c of candidates) {
    if (!c) continue;
    const d = new Date(c);
    if (!isNaN(d.getTime()) && d.getTime() <= Date.now() + 3600e3) return d.toISOString();
  }
  return new Date().toISOString();
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const key = (url.searchParams.get('key') || '').trim().toUpperCase();
  if (!key) {
    return new Response(JSON.stringify({ error: 'missing_key' }), { status: 400 });
  }

  let payload;
  try {
    payload = await req.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 });
  }

  // Resend manda anche eventi diversi da 'email.received' (es. un ping di verifica del
  // webhook): li ignoriamo senza segnalare errore, altrimenti Resend potrebbe disattivare
  // il webhook per troppi fallimenti.
  if (payload.type !== 'email.received') {
    console.log(`[inbound-lead] evento ignorato: ${payload.type}`);
    return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });
  }

  console.log(`[inbound-lead] webhook ricevuto per key=${key}, email_id=${payload.data && payload.data.email_id}`);

  const licenses = licenseStore();
  const license = await licenses.get(key, { type: 'json' });
  if (!license || license.status !== 'active') {
    console.log(`[inbound-lead] licenza non valida per key=${key}`);
    return new Response(JSON.stringify({ error: 'invalid_license' }), { status: 401 });
  }

  const dataStore = getStore('studio-data');
  const studioData = await dataStore.get(key, { type: 'json', consistency: 'strong' });
  const settings = (studioData && studioData.studioSettings) || {};
  const resendApiKey = settings.resendApiKey;
  if (!resendApiKey) {
    console.log(`[inbound-lead] nessuna chiave Resend configurata per key=${key}`);
    return new Response(JSON.stringify({ error: 'resend_not_configured' }), { status: 400 });
  }

  const emailId = payload.data && payload.data.email_id;
  if (!emailId) {
    console.log('[inbound-lead] payload senza email_id');
    return new Response(JSON.stringify({ error: 'missing_email_id' }), { status: 400 });
  }

  let email;
  try {
    console.log(`[inbound-lead] recupero email ${emailId} da Resend...`);
    email = await fetchReceivedEmail(resendApiKey, emailId);
    console.log(`[inbound-lead] email recuperata, oggetto="${email.subject}", lunghezza testo=${(email.text||'').length}`);
  } catch (err) {
    console.error('[inbound-lead] errore recupero email da Resend:', String(err.message || err));
    return new Response(JSON.stringify({ error: 'resend_fetch_failed', message: String(err.message || err) }), { status: 502 });
  }

  const subject = email.subject || '';
  const bodyText = (email.text && email.text.trim()) ? email.text.trim() : stripHtml(email.html);
  const mittenteInfo = parseMittente(email.from);

  const leadsStore = getStore('leads');
  const list = (await leadsStore.get(key, { type: 'json', consistency: 'strong' })) || [];

  // Resend puo' reinviare lo stesso webhook (es. se questa function impiega troppo a
  // rispondere) e senza un controllo qui finiremmo per salvare due volte lo stesso lead. L'email_id è stabile
  // tra un invio e un eventuale reinvio dello stesso evento, quindi lo usiamo per capire
  // se questa mail è già stata salvata in precedenza.
  const already = list.find((l) => l.emailId === emailId);
  if (already) {
    console.log(`[inbound-lead] email_id=${emailId} già salvato come lead id=${already.id}, ignoro il reinvio`);
    return new Response(JSON.stringify({ ok: true, lead: already, duplicate: true }), { status: 200 });
  }

  const entry = {
    id: 'lead_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    emailId,
    canale: 'email',
    ricevutoAt: originalDate(email, payload),
    mittente: email.from || '',
    oggetto: subject,
    testo: bodyText.slice(0, 4000),
    nome: mittenteInfo.nome || '',
    email: mittenteInfo.email || email.from || '',
    telefono: '',
    tipoProgetto: '',
    indirizzoIntervento: '',
    fonte: '',
    note: '',
    fase: 'nuova'
  };
  list.unshift(entry);
  await leadsStore.setJSON(key, list);
  console.log(`[inbound-lead] lead salvato: id=${entry.id}, nome="${entry.nome}"`);

  return new Response(JSON.stringify({ ok: true, lead: entry }), { status: 200 });
};
