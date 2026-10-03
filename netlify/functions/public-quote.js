import { getStore } from '@netlify/blobs';
import { syncQuoteToDesearqManager } from './desearq-sync.js';

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
  // Consistenza forte: create-link viene chiamato subito dopo che il client ha salvato il
  // preventivo tramite sync-data.js (invocazione separata della function). Con la lettura
  // "eventual" di default, la scrittura appena fatta può non essere ancora visibile qui,
  // facendo fallire la findIndex() con 'not_found' anche se il preventivo esiste davvero.
  return (await dataStore.get(key, { type: 'json', consistency: 'strong' })) || null;
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
    banca: settings.banca || '',
    sdi: settings.sdi || ''
  };
}

function sanitizeQuote(q){
  return {
    id: q.id,
    numero: q.client?.numero || '',
    revisione: q.client?.revisione || '',
    cliente: q.client?.cliente || '',
    tipoCliente: q.client?.tipoCliente || 'Privato',
    // Indirizzo/CF/PIVA del cliente: servono al blocco "Cliente" del documento, con lo stesso
    // formato del PDF (buildPrintDoc in index.html) — in precedenza non esposti qui perché la
    // pagina pubblica mostrava solo un riepilogo minimo, non il documento completo.
    indirizzo: q.client?.indirizzo || '',
    cf: q.client?.cf || '',
    piva: q.client?.piva || '',
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
      // codice/custom servono alla colonna "Codice" del documento, nello stesso formato del PDF
      // (dove una voce libera/custom mostra "—" invece di un codice di listino).
      codice: l.custom ? '' : (l.codice || ''), custom: !!l.custom,
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

  // Il cliente che apre questo link ha di fatto letto il preventivo: registriamo l'evento
  // direttamente qui, invece di dipendere solo dal pixel di apertura email di Resend (che
  // richiede la configurazione di un webhook lato dashboard Resend e comunque molti client di
  // posta bloccano il caricamento delle immagini, quindi il pixel spesso non scatta mai anche
  // quando il cliente ha letto ed è anche entrato nel preventivo). Un solo evento 'aperto' per
  // follow-up: le visite successive alla stessa pagina non ne aggiungono altri. Non deve mai far
  // fallire il caricamento del preventivo: eventuali errori restano silenziosi, come per la firma.
  try{
    const numero = quote.client && quote.client.numero;
    if(numero){
      const followupsStore = getStore('followups');
      const followupsList = (await followupsStore.get(link.key, { type: 'json', consistency: 'strong' })) || [];
      const fu = followupsList.find(f => f.quoteRef === numero);
      if(fu && !fu.events.some(e => e.type === 'aperto')){
        fu.events.push({ type: 'aperto', at: new Date().toISOString() });
        await followupsStore.setJSON(link.key, followupsList);
      }
    }
  }catch(err){ /* l'apertura del preventivo non deve mai fallire per questo */ }

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
  // La firma del cliente è di per sé un'accettazione: segna il preventivo come "Vinto" in
  // automatico, così lo studio non deve anche spuntarlo a mano (il flag manuale resta comunque
  // disponibile in Preventivi salvati per tutti i casi accettati fuori da questo link, es. a
  // voce o via email).
  quote.vinto = true;
  savedQuotes[idx] = quote;
  await saveStudioRecord(dataStore, link.key, { ...record, savedQuotes });

  // Preventivo firmato -> compare come nuovo arrivo in Desearq Studio Manager (solo per gli
  // studi col pacchetto completo, flag indipendente da Estimly 2.0/followupEnabled). Non deve
  // mai bloccare la firma del cliente: eventuali errori sono già gestiti (silenziosamente)
  // dentro syncQuoteToDesearqManager.
  if(license.suiteEnabled){
    await syncQuoteToDesearqManager(quote, { markNuovo: true });
  }

  // Preventivo firmato -> aggiorna anche il follow-up collegato (se il preventivo era stato
  // inviato con "Invia preventivo via email"), altrimenti la firma del cliente non compariva
  // mai nel pannello follow-up: lì restava per sempre "Freddo"/qualunque fosse lo stato di
  // apertura/click, perché firma e follow-up sono due store separati che prima non si
  // parlavano affatto. Non deve mai bloccare la firma del cliente: eventuali errori restano
  // silenziosi, esattamente come per syncQuoteToDesearqManager sopra.
  try{
    const numero = quote.client && quote.client.numero;
    if(numero){
      const followupsStore = getStore('followups');
      const followupsList = (await followupsStore.get(link.key, { type: 'json', consistency: 'strong' })) || [];
      const fu = followupsList.find(f => f.quoteRef === numero);
      if(fu){
        fu.events.push({ type: 'firmato', at: firma.firmatoAt });
        fu.status = 'convertito';
        fu.active = false;
        await followupsStore.setJSON(link.key, followupsList);
      }
    }
  }catch(err){ /* la firma del cliente non deve mai fallire per questo */ }

  // ip e hashDocumento tornano al client per essere stampati nel documento di accettazione
  // firmato (PDF) che preventivo.html genera subito dopo e carica con 'store-signed-document'.
  return { ok: true, firmatoAt: firma.firmatoAt, ip: firma.ip, hashDocumento: firma.hashDocumento };
}

function getSignedDocsStore(){
  return getStore('signed-documents');
}

function signedDocKey(key, quoteId){
  return `${key}__${quoteId}`;
}

// Salva il PDF del "documento di accettazione firmato" generato lato client (preventivo.html,
// subito dopo la firma, con lo stesso approccio html2canvas+jsPDF usato in Estimly per il PDF
// del preventivo). Salvato come bytes grezzi in uno store dedicato ('signed-documents'), separato
// da 'studio-data', per non appesantire il record condiviso dello studio con allegati PDF.
async function storeSignedDocument(licenses, dataStore, body){
  const token = (body.token || '').trim();
  const pdfBase64 = body.pdfBase64;
  if(!token || !pdfBase64) return { error: 'missing_fields' };
  // ~15MB in base64 come limite prudenziale (un documento firmato è tipicamente 1-2 pagine).
  if(pdfBase64.length > 20 * 1024 * 1024) return { error: 'file_troppo_grande' };

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
  if(!quote.client || !quote.client.firma || !quote.client.firma.firmato){
    // Si può conservare un documento firmato solo per un preventivo che risulta davvero firmato.
    return { error: 'non_firmato' };
  }

  let bytes;
  try{
    bytes = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));
  }catch(err){
    return { error: 'file_non_valido' };
  }

  await getSignedDocsStore().set(signedDocKey(link.key, link.quoteId), bytes, { metadata: { contentType: 'application/pdf' } });

  quote.client = { ...quote.client, firma: { ...quote.client.firma, documentoConservato: true } };
  savedQuotes[idx] = quote;
  await saveStudioRecord(dataStore, link.key, { ...record, savedQuotes });

  return { ok: true };
}

// Consente allo studio (autenticato con la propria chiave di licenza, non con il token pubblico
// del cliente) di riscaricare in qualsiasi momento il documento di accettazione firmato,
// conservato da Estimly come prova della firma del preventivo.
async function downloadSignedDocument(licenses, dataStore, body){
  let key = (body.key || '').trim().toUpperCase();
  let quoteId = body.quoteId;

  // Il cliente stesso può riscaricare la propria copia usando il link pubblico (senza chiave
  // di licenza): usato da preventivo.html, dove non c'è alcuna autenticazione dello studio.
  if(!key && body.token){
    const linksStore = getLinksStore();
    const link = await linksStore.get((body.token || '').trim(), { type: 'json' });
    if(!link) return { error: 'not_found' };
    key = link.key;
    quoteId = link.quoteId;
  }

  if(!key || !quoteId) return { error: 'missing_fields' };

  const license = await licenses.get(key, { type: 'json' });
  if(!license || license.status !== 'active') return { error: 'invalid_license' };

  const record = await loadStudioRecord(dataStore, key);
  const savedQuotes = (record && Array.isArray(record.savedQuotes)) ? record.savedQuotes : [];
  const quote = savedQuotes.find(q => q.id === quoteId);
  if(!quote || !quote.client || !quote.client.firma || !quote.client.firma.documentoConservato){
    return { error: 'not_found' };
  }

  const bytes = await getSignedDocsStore().get(signedDocKey(key, quoteId), { type: 'arrayBuffer' });
  if(!bytes) return { error: 'not_found' };

  const numero = (quote.client.numero || 'documento').replace(/[^a-zA-Z0-9_-]+/g, '_');
  return { ok: true, bytes, filename: `Accettazione_firmata_${numero}.pdf` };
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
    if (body.mode === 'store-signed-document') {
      const result = await storeSignedDocument(licenses, dataStore, body);
      return new Response(JSON.stringify(result), { status: result.error ? 400 : 200 });
    }
    if (body.mode === 'download-signed-document') {
      const result = await downloadSignedDocument(licenses, dataStore, body);
      if (result.error) {
        return new Response(JSON.stringify(result), { status: 404 });
      }
      return new Response(result.bytes, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${result.filename}"`
        }
      });
    }
    return new Response(JSON.stringify({ error: 'unknown_mode' }), { status: 400 });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'server_error', message: String(err.message || err) }), { status: 500 });
  }
};
