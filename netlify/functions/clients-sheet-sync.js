import { getStore } from '@netlify/blobs';
import crypto from 'crypto';

// ===================== Import clienti da Google Sheet (Estimly 2.0) =====================
// Legge le risposte di un Google Form (raccolte in un Google Sheet) e le importa/aggiorna
// in Rubrica, con lo stesso meccanismo già usato in DSQ Manager: un Service Account Google
// condiviso come Visualizzatore sul foglio, autenticato via JWT (nessun login utente, nessuna
// condivisione pubblica del foglio).
//
// Chiamata da tre punti:
// - Il pulsante "Importa ora" in Rubrica (sincronizzazione manuale)
// - Un piccolo Google Apps Script agganciato al foglio stesso, che fa una chiamata ad ogni
//   invio del modulo (sincronizzazione quasi istantanea)
// - Una funzione programmata (clients-sheet-cron.js) ogni 15 minuti, come rete di sicurezza
//   nel caso il ping dello script non arrivasse
//
// Variabili d'ambiente richieste: CLIENTS_SHEET_SA_EMAIL, CLIENTS_SHEET_SA_PRIVATE_KEY,
// CLIENTS_SHEET_ID, CLIENTS_SHEET_NAME (nome della tab, es. "Risposte del modulo 1").

// Intestazioni del foglio -> campo cliente dedicato in Rubrica (gli altri campi confluiscono
// tutti in "note", con un'etichetta breve, così nessuna risposta del modulo va persa).
const FIELD_MAP = {
  'Nome e Cognome': 'cliente',
  'Indirizzo email': 'email',
  'Numero di telefono': 'telefono',
  "Città e zona dell'immobile": 'indirizzoIntervento'
};

// Intestazioni -> etichetta breve per il blocco note (ordine di visualizzazione).
const NOTE_LABELS = [
  ['Di che tipo di progetto vuoi realizzare?', 'Tipo progetto'],
  ['Superficie immobile (in mq)', 'Superficie'],
  ['Hai già una planimetria o foto da condividere?', 'Planimetria/foto disponibili'],
  ['Se hai risposto sì alla domanda precedente, carica qui i tuoi file', 'File caricati'],
  ['Quando presto vuoi partire con l\'intervento ?', 'Tempistiche'],
  ['Budget stimato per l\'intervento ?', 'Budget'],
  ['Qual\'è il problema principale della tua casa oggi?', 'Problema principale'],
  ['Chi, oltre a te, prenderà le decisioni in merito ?', 'Altri decisori'],
  ['Dove ci hai conosciuto ?', 'Provenienza'],
  ['Quale tra i nostri progetti realizzati (che trovi sul sito) è quello che più ti rappresenta ? ', 'Progetto di riferimento'],
  ['Quali sono le tue/vostre aspettativa principali sull\'intervento e sul nostro operato ?', 'Aspettative'],
  ['Hai già avuto in passato esperienza con altri professionisti ?', 'Esperienze precedenti'],
  ['Nel caso di risposta affermativa, quali sono stati gli aspetti positivi e quali invece quelli negativi ? (nel caso di risposta negativa, scrivi NULLA)', 'Dettagli esperienze precedenti'],
  ['Che tipo di servizio stai cercando?', 'Tipo di servizio'],
  ['Stato attuale dell\'immobile', 'Stato attuale immobile']
];

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken() {
  const email = process.env.CLIENTS_SHEET_SA_EMAIL;
  const privateKey = (process.env.CLIENTS_SHEET_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !privateKey) throw new Error('missing_service_account_env');

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const unsigned = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claim));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(privateKey).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${unsigned}.${signature}`
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('google_auth_failed: ' + errText.slice(0, 300));
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('google_auth_no_token');
  return data.access_token;
}

async function fetchSheetRows() {
  const sheetId = process.env.CLIENTS_SHEET_ID;
  const sheetName = process.env.CLIENTS_SHEET_NAME;
  if (!sheetId || !sheetName) throw new Error('missing_sheet_env');

  const accessToken = await getAccessToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetName)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('sheets_fetch_failed: ' + errText.slice(0, 300));
  }
  const data = await res.json();
  return data.values || [];
}

function normalize(str) {
  return String(str || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Trasforma le righe grezze del foglio (prima riga = intestazioni) in record cliente pronti
// per la Rubrica, con tutte le risposte secondarie raccolte in un unico blocco note.
function rowsToClientRecords(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h || '').trim());
  const records = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const byHeader = {};
    headers.forEach((h, idx) => { byHeader[h] = (row[idx] || '').toString().trim(); });

    const record = { cliente: '', email: '', telefono: '', indirizzoIntervento: '' };
    Object.entries(FIELD_MAP).forEach(([header, field]) => {
      if (byHeader[header]) record[field] = byHeader[header];
    });

    // Una riga senza nome né email non è un contatto utilizzabile: la saltiamo.
    if (!record.cliente && !record.email) continue;

    const noteLines = [];
    NOTE_LABELS.forEach(([header, label]) => {
      const val = byHeader[header.trim()];
      if (val) noteLines.push(`${label}: ${val}`);
    });
    record.note = noteLines.join('\n');
    record.sourceSheet = true;
    records.push(record);
  }
  return records;
}

// Importa i record nella Rubrica dello studio: stesso nome+cognome e/o stessa email ->
// aggiorna la scheda cliente esistente invece di crearne una nuova. I record vengono
// processati nell'ordine del foglio, così se la stessa persona ha inviato il modulo più
// volte vince sempre la risposta più recente (l'ultima riga del foglio per quella persona).
function mergeClients(existingClients, records) {
  const clients = existingClients.map((c) => ({ ...c }));
  let created = 0;
  let updated = 0;

  records.forEach((rec) => {
    const emailKey = normalize(rec.email);
    const nomeKey = normalize(rec.cliente);
    const idx = clients.findIndex((c) => {
      const cEmail = normalize(c.email);
      const cNome = normalize(c.cliente);
      if (emailKey && cEmail && cEmail === emailKey) return true;
      if (nomeKey && cNome && cNome === nomeKey) return true;
      return false;
    });

    if (idx !== -1) {
      clients[idx] = {
        ...clients[idx],
        cliente: rec.cliente || clients[idx].cliente,
        email: rec.email || clients[idx].email,
        telefono: rec.telefono || clients[idx].telefono,
        indirizzoIntervento: rec.indirizzoIntervento || clients[idx].indirizzoIntervento,
        note: rec.note || clients[idx].note,
        sourceSheet: true,
        updatedAt: new Date().toISOString()
      };
      updated++;
    } else {
      clients.unshift({
        id: 'c_sheet_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
        cliente: rec.cliente || '',
        tipoCliente: 'Privato',
        cf: '',
        indirizzo: '',
        piva: '',
        email: rec.email || '',
        telefono: rec.telefono || '',
        pec: '',
        indirizzoIntervento: rec.indirizzoIntervento || '',
        note: rec.note || '',
        sourceSheet: true,
        createdAt: new Date().toISOString()
      });
      created++;
    }
  });

  return { clients, created, updated };
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 });
  }

  const key = (body.key || '').trim().toUpperCase();
  if (!key) {
    return new Response(JSON.stringify({ error: 'missing_key' }), { status: 400 });
  }

  const licenses = getStore('licenses');
  const license = await licenses.get(key, { type: 'json' });
  if (!license || license.status !== 'active') {
    return new Response(JSON.stringify({ error: 'invalid_license' }), { status: 401 });
  }

  let rows;
  try {
    rows = await fetchSheetRows();
  } catch (err) {
    console.error('[clients-sheet-sync] errore lettura foglio:', String(err.message || err));
    return new Response(JSON.stringify({ error: 'sheet_fetch_failed', message: String(err.message || err) }), { status: 502 });
  }

  const records = rowsToClientRecords(rows);

  const dataStore = getStore('studio-data');
  const existing = (await dataStore.get(key, { type: 'json' })) || {};
  const existingClients = Array.isArray(existing.clients) ? existing.clients : [];
  const { clients, created, updated } = mergeClients(existingClients, records);

  const record = {
    catalog: existing.catalog || [],
    studioSettings: existing.studioSettings || {},
    categoryOrder: existing.categoryOrder || [],
    savedQuotes: Array.isArray(existing.savedQuotes) ? existing.savedQuotes : [],
    clients,
    updatedAt: new Date().toISOString()
  };
  await dataStore.setJSON(key, record);

  console.log(`[clients-sheet-sync] key=${key} righe_foglio=${rows.length - 1} creati=${created} aggiornati=${updated}`);

  return new Response(JSON.stringify({ ok: true, created, updated, total: clients.length, clients }), { status: 200 });
};
