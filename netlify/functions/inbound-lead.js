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
// Estimly globale). L'estrazione dei campi strutturati usa invece una chiave Anthropic
// dedicata a questa funzione (variabile d'ambiente LEAD_AI_API_KEY), separata sia dalla
// chiave di EstimlyAI (estimlyai.js) sia dalle chiavi Resend dei singoli studi, per poter
// monitorare i consumi di questa funzione in modo isolato.

const MODEL = 'claude-haiku-4-5-20251001';

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

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function extractLeadWithAI(subject, bodyText) {
  const apiKey = process.env.LEAD_AI_API_KEY;
  if (!apiKey) throw new Error('missing_lead_ai_key');

  const system = 'Sei un assistente che legge le mail di richiesta ricevute da uno studio di architettura/interior design e ne estrae i dati in un formato strutturato. ' +
    'Rispondi SOLO con un oggetto JSON valido, senza testo aggiuntivo, con esattamente questi campi: ' +
    '{"nome":"","email":"","telefono":"","tipoProgetto":"","indirizzoIntervento":"","note":""}. ' +
    '"tipoProgetto" è una sintesi brevissima (max 6-7 parole) di cosa viene richiesto (es. "Progettazione bagno", "Ristrutturazione appartamento 80mq"). ' +
    '"indirizzoIntervento" è l\'indirizzo o la zona del luogo dove si svolgerà il lavoro (via, città), se indicato — diverso dall\'indirizzo del mittente. ' +
    '"note" raccoglie in 1-2 frasi altri dettagli utili (budget, tempistiche) se presenti. ' +
    'Se un campo non è presente nella mail, lascialo come stringa vuota. Non inventare informazioni non presenti nel testo.';

  const userContent = `OGGETTO: ${subject}\n\nTESTO:\n${bodyText}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system,
      messages: [{ role: 'user', content: userContent }]
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('ai_error: ' + errText.slice(0, 300));
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  const raw = textBlock ? textBlock.text : '{}';
  const cleaned = raw.trim().replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    return {
      nome: parsed.nome || '',
      email: parsed.email || '',
      telefono: parsed.telefono || '',
      tipoProgetto: parsed.tipoProgetto || '',
      indirizzoIntervento: parsed.indirizzoIntervento || '',
      note: parsed.note || ''
    };
  } catch (e) {
    return { nome: '', email: '', telefono: '', tipoProgetto: '', indirizzoIntervento: '', note: '' };
  }
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

  let extracted;
  try {
    extracted = await extractLeadWithAI(subject, bodyText.slice(0, 6000));
  } catch (err) {
    // L'estrazione AI non deve mai far perdere la richiesta: se fallisce, salviamo comunque
    // la mail grezza (mittente/oggetto/testo) così Nicola la vede e la gestisce a mano.
    extracted = { nome: '', email: '', telefono: '', tipoProgetto: '', note: '' };
  }

  const leadsStore = getStore('leads');
  const list = (await leadsStore.get(key, { type: 'json' })) || [];
  const entry = {
    id: 'lead_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    ricevutoAt: new Date().toISOString(),
    mittente: email.from || '',
    oggetto: subject,
    testo: bodyText.slice(0, 4000),
    nome: extracted.nome || '',
    email: extracted.email || email.from || '',
    telefono: extracted.telefono || '',
    tipoProgetto: extracted.tipoProgetto || '',
    indirizzoIntervento: extracted.indirizzoIntervento || '',
    note: extracted.note || '',
    fase: 'nuova'
  };
  list.unshift(entry);
  await leadsStore.setJSON(key, list);

  return new Response(JSON.stringify({ ok: true, lead: entry }), { status: 200 });
};
