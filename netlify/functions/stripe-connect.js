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

async function stripeRequest(method, path, params){
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if(!secretKey) throw Object.assign(new Error('stripe_not_configured'), { code: 'stripe_not_configured' });
  const isGet = method === 'GET';
  const url = isGet && params ? `${STRIPE_API}${path}?${toFormParams(params).toString()}` : `${STRIPE_API}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      ...(isGet ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' })
    },
    body: isGet ? undefined : toFormParams(params || {})
  });
  const data = await res.json();
  if(!res.ok){
    throw Object.assign(new Error((data.error && data.error.message) || 'stripe_error'), { code: (data.error && data.error.code) || 'stripe_error' });
  }
  return data;
}

async function loadStudioRecord(dataStore, key){
  return (await dataStore.get(key, { type: 'json' })) || null;
}

async function saveStudioRecord(dataStore, key, record){
  await dataStore.setJSON(key, { ...record, updatedAt: new Date().toISOString() });
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
    return new Response(JSON.stringify({ error: 'unknown_mode' }), { status: 400 });
  }catch(err){
    const code = err && err.code === 'stripe_not_configured' ? 'stripe_not_configured' : 'server_error';
    return new Response(JSON.stringify({ error: code, message: String(err.message || err) }), { status: code === 'stripe_not_configured' ? 503 : 500 });
  }
};
