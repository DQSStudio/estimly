import { getStore } from '@netlify/blobs';

// ===================== Pagina pubblica del preventivo (Estimly 2.0) =====================
// Espone un preventivo tramite un token opaco (non indovinabile), senza richiedere login al
// cliente finale. Usata per: mostrare il preventivo, raccogliere la firma elettronica semplice
// (SES, valida ai sensi dell'art. 25 eIDAS) e, in seguito, avviare il pagamento online.
//
// Store separati dagli altri per non mescolare responsabilità:
// - 'public-links'  : token -> { key (licenza), quoteId, createdAt }
// - 'studio-data'   : stesso store già usato da sync-data.js (savedQuotes vive lì dentro)

function randomToken(){
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text){
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function getClientIp(req){
  try{
    return req.headers.get('x-nf-client-connection-ip')
      || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
      || null;
  }catch(e){ return null; }
}

// Contenuto "canonico" del preventivo su cui calcolare l'impronta (hash) firmata dal cliente:
// se anche un solo importo/voce cambia dopo la firma, l'hash non corrisponde più.
function canonicalQuoteContent(quote){
  return JSON.stringify({
    numero: quote.client?.numero || '',
    revisione: quote.client?.revisione || '',
    cliente: quote.client?.cliente || '',
    progetto: quote.client?.progetto || '',
    sconto: quote.client?.sconto || 0,
    contributoPct: quote.client?.contributoPct || 0,
    regime: quote.client?.regime || '',
    aliquotaCustom: quote.client?.aliquotaCustom || 0,
    cart: (quote.cart || []).map(l => ({ codice: l.codice, nome: l.nome, qty: l.qty, prezzo: l.prezzo, ore: l.ore, tariffa: l.tariffa, modalita: l.modalita }))
  });
}

async function loadStudioRecord(dataStore, key){
  return (await dataStore.get(key, { type: 'json' })) || null;
}

async function saveStudioRecord(dataStore, key, record){
  await dataStore.setJSON(key, { ...record, updatedAt: new Date().toISOString() });
}

function sanitizeStudio(settings){
  if(!settings) return {};
  return {
    nome: settings.nome || 'Studio',
    logo: settings.logo || '',
    colorPrimary: settings.colorPrimary || '#4338CA',
    indirizzo: settings.indirizzo || '',
    piva: settings.piva || '',
    telefono: settings.telefono || '',
    email: settings.email || '',
    iban: settings.iban || '',
    intestatario: settings.intestatario || '',
    banca: settings.banca || ''
  };
}

function sanitizeQuote(q){
  return {
    id: q.id,
    numero: q.client?.numero || '',
    revisione: q.client?.revisione || '',
    cliente: q.client?.cliente || '',
    tipoCliente: q.client?.tipoCliente || 'Privato',
    progetto: q.client?.progetto || '',
    data: q.client?.data || '',
    validita: q.client?.validita || 30,
    notePagamento: q.client?.notePagamento || '',
    sconto: q.client?.sconto || 0,
    contributoLabel: q.client?.contributoLabel || '',
    contributoPct: q.client?.contributoPct || 0,
    regime: q.client?.regime || 'ord22',
    aliquotaCustom: q.client?.aliquotaCustom || 22,
    hidePrices: !!q.client?.hidePrices,
    concluso: !!q.concluso,
    firma: q.client?.firma ? {
      firmato: true,
      firmatoAt: q.client.firma.firmatoAt,
      firmatarioNome: q.client.firma.firmatarioNome,
      metodo: q.client.firma.metodo
    } : { firmato: false },
    // Richieste di pagamento (SAL) create dallo studio dopo la firma: qui esponiamo solo
    // i campi utili al cliente, mai gli identificativi interni di Stripe.
    pagamenti: (Array.isArray(q.client?.pagamenti) ? q.client.pagamenti : []).map(p => ({
      id: p.id, label: p.label, importoCent: p.importoCent, stato: p.stato, createdAt: p.createdAt, paidAt: p.paidAt || null
    })),
    cart: (q.cart || []).map(l => ({
      nome: l.nome, um: l.um, modalita: l.modalita, qty: l.qty, prezzo: l.prezzo,
      ore: l.ore, tariffa: l.tariffa, categoria: l.categoria, descrizione: l.descrizione || '', nota: l.nota || ''
    }))
  };
}

async function createLink(licenses, dataStore, body){
  const key = (body.key || '').trim().toUpperCase();
  const quoteId = body.quoteId;
  if(!key || !quoteId) return { error: 'missing_fields' };

  const license = await licenses.get(key, { type: 'json' });
  if(!license || license.status !== 'active') return { error: 'invalid_license' };
  if(!license.followupEnabled) return { error: 'not_estimly2' };

  const record = await loadStudioRecord(dataStore, key);
  const savedQuotes = (record && Array.isArray(record.savedQuotes)) ? record.savedQuotes : [];
  const idx = savedQuotes.findIndex(q => q.id === quoteId);
  if(idx === -1) return { error: 'not_found' };

  const quote = savedQuotes[idx];
  const existingToken = quote.client && quote.client.publicToken;
  if(existingToken){
    return { ok: true, token: existingToken };
  }

  const token = randomToken();
  const linksStore = getLinksStore();
  await linksStore.setJSON(token, { key, quoteId, createdAt: new Date().toISOString() });

  quote.client = { ...quote.client, publicToken: token };
  savedQuotes[idx] = quote;
  await saveStudioRecord(dataStore, key, { ...record, savedQuotes });

  return { ok: true, token };
}

async function getPublicQuote(licenses, dataStore, body){
  const token = (body.token || '').trim();
  if(!token) return { error: 'missing_token' };

  const linksStore = getLinksStore();
  const link = await linksStore.get(token, { type: 'json' });
  if(!link) return { error: 'not_found' };

  const license = await licenses.get(link.key, { type: 'json' });
  if(!license || license.status !== 'active') return { error: 'not_found' };

  const record = await loadStudioRecord(dataStore, link.key);
  const savedQuotes = (record && Array.isArray(record.savedQuotes)) ? record.savedQuotes : [];
  const quote = savedQuotes.find(q => q.id === link.quoteId);
  if(!quote) return { error: 'not_found' };

  return {
    ok: true,
    studio: sanitizeStudio(record && record.studioSettings),
    quote: sanitizeQuote(quote)
  };
}

async function signPublicQuote(licenses, dataStore, body, req){
  const token = (body.token || '').trim();
  const firmatarioNome = (body.firmatarioNome || '').trim().slice(0, 200);
  const metodo = body.metodo === 'disegnata' ? 'disegnata' : 'nome_digitato';
  const accettaCondizioni = !!body.accettaCondizioni;
  if(!token || !firmatarioNome) return { error: 'missing_fields' };
  if(!accettaCondizioni) return { error: 'condizioni_non_accettate' };

  const linksStore = getLinksStore();
  const link = await linksStore.get(token, { type: 'json' });
  if(!link) return { error: 'not_found' };

  const license = await licenses.get(link.key, { type: 'json' });
  if(!license || license.status !== 'active') return { error: 'not_found' };

  const record = await loadStudioRecord(dataStore, link.key);
  const savedQuotes = (record && Array.isArray(record.savedQuotes)) ? record.savedQuotes : [];
  const idx = savedQuotes.findIndex(q => q.id === link.quoteId);
  if(idx === -1) return { error: 'not_found' };

  const quote = savedQuotes[idx];
  if(quote.client && quote.client.firma && quote.client.firma.firmato !== false){
    // Già firmato: non si può firmare due volte lo stesso preventivo.
    return { error: 'already_signed' };
  }

  const hashDocumento = await sha256Hex(canonicalQuoteContent(quote));
  const firma = {
    firmato: true,
    firmatarioNome,
    metodo,
    firmaImage: metodo === 'disegnata' ? (body.firmaImage || '').slice(0, 200000) : '',
    firmatoAt: new Date().toISOString(),
    ip: getClientIp(req),
    hashDocumento
  };

  quote.client = { ...quote.client, firma };
  savedQuotes[idx] = quote;
  await saveStudioRecord(dataStore, link.key, { ...record, savedQuotes });

  return { ok: true, firmatoAt: firma.firmatoAt };
}

function getLinksStore(){
  return getStore('public-links');
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

  const licenses = getStore('licenses');
  const dataStore = getStore('studio-data');

  try {
    if (body.mode === 'create-link') {
      const result = await createLink(licenses, dataStore, body);
      return new Response(JSON.stringify(result), { status: result.error ? 400 : 200 });
    }
    if (body.mode === 'get') {
      const result = await getPublicQuote(licenses, dataStore, body);
      return new Response(JSON.stringify(result), { status: result.error ? 404 : 200 });
    }
    if (body.mode === 'sign') {
      const result = await signPublicQuote(licenses, dataStore, body, req);
      return new Response(JSON.stringify(result), { status: result.error ? 400 : 200 });
    }
    return new Response(JSON.stringify({ error: 'unknown_mode' }), { status: 400 });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'server_error', message: String(err.message || err) }), { status: 500 });
  }
};
