import { getStore } from '@netlify/blobs';

// ===================== Collegamento Stripe (Estimly 2.0) =====================
// Ogni studio collega il PROPRIO account Stripe (modello "connect your own account"):
// Estimly non incassa nulla e il denaro non passa mai dal conto di Estimly.
// Account collegato = "Standard" equivalente, creato via controller properties
// (vedi https://docs.stripe.com/connect/migrate-to-controller-properties):
//   - stripe_dashboard.type: 'full'   -> lo studio ha accesso alla Dashboard Stripe completa
//   - fees.payer: 'account'           -> lo studio paga le commissioni Stripe con la propria
//                                        tariffa standard (Estimly non ci guadagna sopra)
//   - losses.payments: 'stripe'       -> Stripe è responsabile di eventuali saldi negativi
//   - requirement_collection: 'stripe'-> è Stripe (non Estimly) a raccogliere i dati KYC
// Pagamenti: addebiti diretti (direct charges) sull'account collegato -> lo studio è il
// "merchant of record", i fondi si depositano direttamente sul suo conto.
//
// Richiede la variabile d'ambiente STRIPE_SECRET_KEY (chiave segreta della piattaforma
// Estimly, mai esposta al client) impostata su Netlify.

const STRIPE_API = 'https://api.stripe.com/v1';

function toFormParams(obj){
  const params = new URLSearchParams();
  (function build(o, prefix){
    if(Array.isArray(o)){
      o.forEach((v, i) => build(v, `${prefix}[${i}]`));
    } else if(o && typeof o === 'object'){
      Object.keys(o).forEach(k => build(o[k], prefix ? `${prefix}[${k}]` : k));
    } else if(o !== undefined && o !== null){
      params.append(prefix, o);
    }
  })(obj, '');
  return params;
}

async function stripeRequest(method, path, params, opts){
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if(!secretKey) throw Object.assign(new Error('stripe_not_configured'), { code: 'stripe_not_configured' });
  const isGet = method === 'GET';
  const url = isGet && params ? `${STRIPE_API}${path}?${toFormParams(params).toString()}` : `${STRIPE_API}${path}`;
  const onBehalfOfAccount = opts && opts.account;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      ...(isGet ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
      // Esegue la chiamata "per conto" dell'account collegato dello studio (addebito diretto):
      // i fondi finiscono sul conto Stripe dello studio, non su quello della piattaforma Estimly.
      ...(onBehalfOfAccount ? { 'Stripe-Account': onBehalfOfAccount } : {})
    },
    body: isGet ? undefined : toFormParams(params || {})
  });
  const data = await res.json();
  if(!res.ok){
    throw Object.assign(new Error((data.error && data.error.message) || 'stripe_error'), { code: (data.error && data.error.code) || 'stripe_error' });
  }
  return data;
}

function randomId(){
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export async function loadStudioRecord(dataStore, key){
  return (await dataStore.get(key, { type: 'json' })) || null;
}

export async function saveStudioRecord(dataStore, key, record){
  await dataStore.setJSON(key, { ...record, updatedAt: new Date().toISOString() });
}

// Usata sia dal ritorno del cliente su preventivo.html (confirmPayment) sia dal webhook Stripe
// (stripe-webhook.js): segna una richiesta di pagamento come pagata, in modo idempotente.
export async function markPaymentPaid(dataStore, licenseKeyUpper, quoteId, paymentId){
  const record = await loadStudioRecord(dataStore, licenseKeyUpper);
  const savedQuotes = (record && Array.isArray(record.savedQuotes)) ? record.savedQuotes : [];
  const idx = savedQuotes.findIndex(q => q.id === quoteId);
  if(idx === -1) return { error: 'not_found' };

  const quote = savedQuotes[idx];
  const pagamenti = Array.isArray(quote.client && quote.client.pagamenti) ? quote.client.pagamenti : [];
  const pIdx = pagamenti.findIndex(p => p.id === paymentId);
  if(pIdx === -1) return { error: 'not_found' };

  if(pagamenti[pIdx].stato === 'pagato'){
    return { ok: true, alreadyPaid: true };
  }

  pagamenti[pIdx] = { ...pagamenti[pIdx], stato: 'pagato', paidAt: new Date().toISOString() };
  quote.client = { ...quote.client, pagamenti };
  savedQuotes[idx] = quote;
  await saveStudioRecord(dataStore, licenseKeyUpper, { ...record, savedQuotes });
  return { ok: true, alreadyPaid: false };
}

async function requireEstimly2(licenses, key){
  const license = await licenses.get(key, { type: 'json' });
  if(!license || license.status !== 'active') return { error: 'invalid_license' };
  if(!license.followupEnabled) return { error: 'not_estimly2' };
  return { ok: true, license };
}

async function getOrCreateAccountId(record, key, dataStore){
  const existing = record && record.studioSettings && record.studioSettings.stripeAccountId;
  if(existing) return existing;

  const account = await stripeRequest('POST', '/accounts', {
    country: 'IT',
    controller: {
      losses: { payments: 'stripe' },
      fees: { payer: 'account' },
      requirement_collection: 'stripe',
      stripe_dashboard: { type: 'full' }
    }
  });

  const studioSettings = { ...(record && record.studioSettings), stripeAccountId: account.id };
  await saveStudioRecord(dataStore, key, { ...(record || {}), studioSettings });
  return account.id;
}

async function connectStart(licenses, dataStore, body){
  const key = (body.key || '').trim().toUpperCase();
  const origin = (body.origin || '').replace(/\/$/, '');
  if(!key || !origin) return { error: 'missing_fields' };

  const check = await requireEstimly2(licenses, key);
  if(check.error) return check;

  const record = await loadStudioRecord(dataStore, key);
  const accountId = await getOrCreateAccountId(record, key, dataStore);

  const accountLink = await stripeRequest('POST', '/account_links', {
    account: accountId,
    refresh_url: `${origin}/?stripeRefresh=1`,
    return_url: `${origin}/?stripeReturn=1`,
    type: 'account_onboarding'
  });

  return { ok: true, url: accountLink.url };
}

async function connectStatus(licenses, dataStore, body){
  const key = (body.key || '').trim().toUpperCase();
  if(!key) return { error: 'missing_fields' };

  const check = await requireEstimly2(licenses, key);
  if(check.error) return check;

  const record = await loadStudioRecord(dataStore, key);
  const accountId = record && record.studioSettings && record.studioSettings.stripeAccountId;
  if(!accountId) return { ok: true, connected: false };

  const account = await stripeRequest('GET', `/accounts/${accountId}`);
  return {
    ok: true,
    connected: true,
    chargesEnabled: !!account.charges_enabled,
    detailsSubmitted: !!account.details_submitted
  };
}

function getLinksStore(){
  return getStore('public-links');
}

// ---------- Richieste di pagamento (SAL) sul preventivo firmato ----------
// Lo studio crea più richieste nel tempo (es. "Acconto 20%", "Saldo a 30gg"), tutte legate
// allo stesso preventivo firmato; il cliente le paga per intero, una per volta, dal link
// pubblico già usato per la firma.

async function addPaymentRequest(licenses, dataStore, body){
  const key = (body.key || '').trim().toUpperCase();
  const quoteId = body.quoteId;
  const label = (body.label || '').trim().slice(0, 120);
  const importoCent = Math.round(Number(body.importoCent));
  if(!key || !quoteId || !label || !Number.isFinite(importoCent) || importoCent < 100){
    return { error: 'missing_fields' };
  }

  const check = await requireEstimly2(licenses, key);
  if(check.error) return check;

  const record = await loadStudioRecord(dataStore, key);
  const savedQuotes = (record && Array.isArray(record.savedQuotes)) ? record.savedQuotes : [];
  const idx = savedQuotes.findIndex(q => q.id === quoteId);
  if(idx === -1) return { error: 'not_found' };

  const quote = savedQuotes[idx];
  if(!quote.client || !quote.client.firma || !quote.client.firma.firmato){
    return { error: 'not_signed' };
  }

  const pagamento = {
    id: randomId(), label, importoCent, stato: 'in_attesa',
    createdAt: new Date().toISOString(), paidAt: null
  };
  const pagamenti = Array.isArray(quote.client.pagamenti) ? quote.client.pagamenti : [];
  quote.client = { ...quote.client, pagamenti: [...pagamenti, pagamento] };
  savedQuotes[idx] = quote;
  await saveStudioRecord(dataStore, key, { ...record, savedQuotes });

  return { ok: true, pagamenti: quote.client.pagamenti };
}

async function resolveToken(dataStore, licenses, token){
  const linksStore = getLinksStore();
  const link = await linksStore.get(token, { type: 'json' });
  if(!link) return { error: 'not_found' };
  const license = await licenses.get(link.key, { type: 'json' });
  if(!license || license.status !== 'active') return { error: 'not_found' };
  const record = await loadStudioRecord(dataStore, link.key);
  const savedQuotes = (record && Array.isArray(record.savedQuotes)) ? record.savedQuotes : [];
  const idx = savedQuotes.findIndex(q => q.id === link.quoteId);
  if(idx === -1) return { error: 'not_found' };
  return { ok: true, link, record, savedQuotes, idx, quote: savedQuotes[idx] };
}

async function createPaymentCheckoutSession(licenses, dataStore, body){
  const token = (body.token || '').trim();
  const paymentId = (body.paymentId || '').trim();
  const origin = (body.origin || '').replace(/\/$/, '');
  if(!token || !paymentId || !origin) return { error: 'missing_fields' };

  const resolved = await resolveToken(dataStore, licenses, token);
  if(resolved.error) return resolved;
  const { quote } = resolved;

  const record = resolved.record;
  const stripeAccountId = record && record.studioSettings && record.studioSettings.stripeAccountId;
  if(!stripeAccountId) return { error: 'stripe_not_connected' };

  const pagamenti = Array.isArray(quote.client && quote.client.pagamenti) ? quote.client.pagamenti : [];
  const pagamento = pagamenti.find(p => p.id === paymentId);
  if(!pagamento) return { error: 'not_found' };
  if(pagamento.stato === 'pagato') return { error: 'already_paid' };

  let session;
  try{
    session = await stripeRequest('POST', '/checkout/sessions', {
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: `${pagamento.label} — Preventivo ${quote.client.numero || ''}`.trim() },
          unit_amount: pagamento.importoCent
        },
        quantity: 1
      }],
      payment_intent_data: { description: pagamento.label },
      metadata: { paymentId, quoteId: quote.id, licenseKey: resolved.link.key },
      success_url: `${origin}/preventivo.html?t=${token}&paid=${paymentId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/preventivo.html?t=${token}`
    }, { account: stripeAccountId });
  }catch(err){
    return { error: 'stripe_error', message: err.message };
  }

  return { ok: true, url: session.url };
}

async function confirmPayment(licenses, dataStore, body){
  const token = (body.token || '').trim();
  const paymentId = (body.paymentId || '').trim();
  const sessionId = (body.sessionId || '').trim();
  if(!token || !paymentId || !sessionId) return { error: 'missing_fields' };

  const resolved = await resolveToken(dataStore, licenses, token);
  if(resolved.error) return resolved;
  const { record, savedQuotes, idx, quote } = resolved;

  const stripeAccountId = record && record.studioSettings && record.studioSettings.stripeAccountId;
  if(!stripeAccountId) return { error: 'stripe_not_connected' };

  const pagamenti = Array.isArray(quote.client && quote.client.pagamenti) ? quote.client.pagamenti : [];
  const pIdx = pagamenti.findIndex(p => p.id === paymentId);
  if(pIdx === -1) return { error: 'not_found' };

  if(pagamenti[pIdx].stato === 'pagato'){
    return { ok: true, pagamenti };
  }

  let session;
  try{
    session = await stripeRequest('GET', `/checkout/sessions/${sessionId}`, null, { account: stripeAccountId });
  }catch(err){
    return { error: 'stripe_error', message: err.message };
  }

  // Verifica incrociata: la sessione deve riferirsi proprio a questa richiesta di pagamento
  // ed essere effettivamente pagata, prima di segnarla come tale.
  const meta = session.metadata || {};
  if(meta.paymentId !== paymentId || session.payment_status !== 'paid'){
    return { ok: true, pagamenti, confirmed: false };
  }

  await markPaymentPaid(dataStore, resolved.link.key, quote.id, paymentId);
  const updatedRecord = await loadStudioRecord(dataStore, resolved.link.key);
  const updatedQuote = (updatedRecord.savedQuotes || []).find(q => q.id === quote.id);
  return { ok: true, pagamenti: (updatedQuote && updatedQuote.client && updatedQuote.client.pagamenti) || pagamenti, confirmed: true };
}

async function connectDisconnect(licenses, dataStore, body){
  const key = (body.key || '').trim().toUpperCase();
  if(!key) return { error: 'missing_fields' };

  const check = await requireEstimly2(licenses, key);
  if(check.error) return check;

  const record = await loadStudioRecord(dataStore, key);
  if(record && record.studioSettings && record.studioSettings.stripeAccountId){
    const studioSettings = { ...record.studioSettings, stripeAccountId: '' };
    await saveStudioRecord(dataStore, key, { ...record, studioSettings });
  }
  return { ok: true };
}

export default async (req) => {
  if(req.method !== 'POST'){
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }

  let body;
  try{
    body = await req.json();
  }catch(err){
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const licenses = getStore('licenses');
  const dataStore = getStore('studio-data');

  try{
    if(body.mode === 'connect-start'){
      const result = await connectStart(licenses, dataStore, body);
      return new Response(JSON.stringify(result), { status: result.error ? 400 : 200 });
    }
    if(body.mode === 'status'){
      const result = await connectStatus(licenses, dataStore, body);
      return new Response(JSON.stringify(result), { status: result.error ? 400 : 200 });
    }
    if(body.mode === 'disconnect'){
      const result = await connectDisconnect(licenses, dataStore, body);
      return new Response(JSON.stringify(result), { status: result.error ? 400 : 200 });
    }
    if(body.mode === 'add-payment-request'){
      const result = await addPaymentRequest(licenses, dataStore, body);
      return new Response(JSON.stringify(result), { status: result.error ? 400 : 200 });
    }
    if(body.mode === 'create-checkout-session'){
      const result = await createPaymentCheckoutSession(licenses, dataStore, body);
      return new Response(JSON.stringify(result), { status: result.error ? 400 : 200 });
    }
    if(body.mode === 'confirm-payment'){
      const result = await confirmPayment(licenses, dataStore, body);
      return new Response(JSON.stringify(result), { status: result.error ? 400 : 200 });
    }
    return new Response(JSON.stringify({ error: 'unknown_mode' }), { status: 400 });
  }catch(err){
    const code = err && err.code === 'stripe_not_configured' ? 'stripe_not_configured' : 'server_error';
    return new Response(JSON.stringify({ error: code, message: String(err.message || err) }), { status: code === 'stripe_not_configured' ? 503 : 500 });
  }
};
