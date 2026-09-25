import { getStore } from '@netlify/blobs';
import { markPaymentPaid } from './stripe-connect.js';

// ===================== Webhook Stripe (conferma pagamenti, Estimly 2.0) =====================
// Perché serve: senza webhook, un pagamento viene segnato "pagato" solo quando il cliente
// torna sulla pagina del preventivo dopo aver pagato (vedi mode:'confirm-payment' in
// stripe-connect.js). Se chiude la scheda prima di tornare, quel percorso non scatta.
// Questo endpoint riceve invece l'evento direttamente da Stripe, appena il pagamento va a
// buon fine, indipendentemente da cosa fa il cliente nel browser.
//
// Configurazione richiesta una tantum su Stripe (fatta una volta sola per tutta la
// piattaforma, non per singolo studio):
//   1. Dashboard Stripe > Sviluppatori > Webhook > Aggiungi endpoint
//   2. Tipo di endpoint: "eventi Connect" (Connect events), NON un endpoint account-level —
//      deve ricevere gli eventi di TUTTI gli account collegati (uno per studio).
//   3. URL: https://<dominio-estimly>/.netlify/functions/stripe-webhook
//   4. Evento da ascoltare: checkout.session.completed
//   5. Copiare il "Signing secret" (whsec_...) e impostarlo su Netlify come variabile
//      d'ambiente STRIPE_CONNECT_WEBHOOK_SECRET (mai esposta al client).
//
// Sicurezza: verifica la firma Stripe-Signature (HMAC-SHA256) prima di fidarsi del corpo
// della richiesta — vedi https://docs.stripe.com/webhooks#verify-manually — e controlla che
// i metadata della sessione corrispondano a una richiesta di pagamento reale prima di
// segnarla come pagata (stessa protezione già usata nel percorso "ritorno cliente").

const TOLERANCE_SECONDS = 5 * 60; // scarta eventi con timestamp troppo vecchio (possibile replay)

function timingSafeEqualHex(a, b){
  if(a.length !== b.length) return false;
  let diff = 0;
  for(let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret, message){
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyStripeSignature(rawBody, signatureHeader, secret){
  if(!signatureHeader) return { valid: false, reason: 'missing_header' };
  const parts = Object.fromEntries(
    signatureHeader.split(',').map(p => p.split('=')).filter(p => p.length === 2)
  );
  const timestamp = parts.t;
  const v1 = parts.v1;
  if(!timestamp || !v1) return { valid: false, reason: 'malformed_header' };

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if(!Number.isFinite(ageSeconds) || ageSeconds > TOLERANCE_SECONDS){
    return { valid: false, reason: 'timestamp_out_of_tolerance' };
  }

  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  if(!timingSafeEqualHex(expected, v1)) return { valid: false, reason: 'signature_mismatch' };
  return { valid: true };
}

export default async (req) => {
  if(req.method !== 'POST'){
    return new Response('method not allowed', { status: 405 });
  }

  const webhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if(!webhookSecret){
    // Non ancora configurato: rispondiamo 200 per non far accumulare retry a Stripe finché
    // non viene impostata la variabile d'ambiente, ma logghiamo per accorgersene.
    console.error('STRIPE_CONNECT_WEBHOOK_SECRET non configurata: webhook Stripe ignorato.');
    return new Response(JSON.stringify({ received: true, ignored: 'not_configured' }), { status: 200 });
  }

  const rawBody = await req.text();
  const signatureHeader = req.headers.get('stripe-signature');
  const verification = await verifyStripeSignature(rawBody, signatureHeader, webhookSecret);
  if(!verification.valid){
    console.error('Firma webhook Stripe non valida:', verification.reason);
    return new Response(JSON.stringify({ error: 'invalid_signature' }), { status: 400 });
  }

  let event;
  try{
    event = JSON.parse(rawBody);
  }catch(err){
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 });
  }

  // Rispondiamo comunque 200 per gli eventi che non ci interessano, così Stripe non li ritenta.
  if(event.type !== 'checkout.session.completed'){
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  }

  const session = event.data && event.data.object;
  const meta = (session && session.metadata) || {};
  const licenseKey = (meta.licenseKey || '').trim().toUpperCase();
  const quoteId = meta.quoteId;
  const paymentId = meta.paymentId;

  if(!licenseKey || !quoteId || !paymentId || session.payment_status !== 'paid'){
    // Evento non pertinente ai pagamenti a rate di Estimly (o non ancora pagato per davvero):
    // 200 comunque, non è un errore da far ritentare.
    return new Response(JSON.stringify({ received: true, skipped: true }), { status: 200 });
  }

  const dataStore = getStore('studio-data');
  const licenses = getStore('licenses');
  try{
    await markPaymentPaid(dataStore, licenseKey, quoteId, paymentId, licenses);
  }catch(err){
    console.error('Errore aggiornamento pagamento da webhook Stripe', err);
    return new Response(JSON.stringify({ error: 'server_error' }), { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 });
};
