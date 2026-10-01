import { getStore } from '@netlify/blobs';

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
    return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });
  }

  const licenses = getStore('licenses');
  const license = await licenses.get(key, { type: 'json' });
  if (!license || license.status !== 'active') {
    return new Response(JSON.stringify({ error: 'invalid_license' }), { status: 401 });
  }

  const dataStore = getStore('studio-data');
  const studioData = await dataStore.get(key, { type: 'json', consistency: 'strong' });
  const settings = (studioData && studioData.studioSettings) || {};
  const resendApiKey = settings.resendApiKey;
  if (!resendApiKey) {
    return new Response(JSON.stringify({ error: 'resend_not_configured' }), { status: 400 });
  }

  const emailId = payload.data && payload.data.email_id;
  if (!emailId) {
    return new Response(JSON.stringify({ error: 'missing_email_id' }), { status: 400 });
  }

  let email;
  try {
    email = await fetchReceivedEmail(resendApiKey, emailId);
  } catch (err) {
    return new Response(JSON.stringify({ error: 'resend_fetch_failed', message: String(err.message || err) }), { status: 502 });
  }

  const subject = email.subject || '';
  const bodyText = (email.text && email.text.trim()) ? email.text.trim() : stripHtml(email.html);
  const mittenteInfo = parseMittente(email.from);

  const leadsStore = getStore('leads');
  const list = (await leadsStore.get(key, { type: 'json' })) || [];
  const entry = {
    id: 'lead_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    ricevutoAt: new Date().toISOString(),
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

  return new Response(JSON.stringify({ ok: true, lead: entry }), { status: 200 });
};
