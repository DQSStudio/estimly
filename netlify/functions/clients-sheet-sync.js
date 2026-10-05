import { getStore } from '@netlify/blobs';
import crypto from 'crypto';

// ===================== Import clienti da Google Sheet (Estimly 2.0) =====================
// Legge le risposte di un Google Form (raccolte in un Google Sheet) e le importa come
// richieste (sezione Richieste, canale "modulo"), con lo stesso meccanismo già usato in DSQ Manager: un Service Account Google
// condiviso come Visualizzatore sul foglio, autenticato via JWT (nessun login utente, nessuna
// condivisione pubblica del foglio).
//
// Chiamata da tre punti:
// - Il pulsante "Importa dal foglio" in Richieste (sincronizzazione manuale)
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

// Trasforma le righe grezze del foglio (prima riga = intestazioni) in "richieste" (lead) con
// tutte le risposte del modulo. Ogni riga ha una chiave stabile (sheetKey, ricavata da
// data/ora di invio + email + nome) per non importarla due volte.
const TIMESTAMP_HEADERS = ['Informazioni cronologiche', 'Timestamp', 'Data e ora'];

function parseSheetTimestamp(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  // Formato italiano dei Moduli Google: 05/10/2026 11:08:32
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function sheetKeyFor(timestamp, email, nome) {
  return crypto
    .createHash('sha1')
    .update([normalize(timestamp), normalize(email), normalize(nome)].join('|'))
    .digest('hex')
    .slice(0, 20);
}

function rowsToLeadRecords(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h || '').trim());
  const records = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const byHeader = {};
    headers.forEach((h, idx) => { byHeader[h] = (row[idx] || '').toString().trim(); });

    const rec = { nome: '', email: '', telefono: '', indirizzoIntervento: '' };
    Object.entries(FIELD_MAP).forEach(([header, field]) => {
      if (byHeader[header]) rec[field === 'cliente' ? 'nome' : field] = byHeader[header];
    });

    // Una riga senza nome né email non è un contatto utilizzabile: la saltiamo.
    if (!rec.nome && !rec.email) continue;

    const labelOf = {};
    const lines = [];
    NOTE_LABELS.forEach(([header, label]) => {
      const val = byHeader[header.trim()];
      if (val) { lines.push(`${label}: ${val}`); labelOf[label] = val; }
    });
    rec.testo = lines.join('\n');
    rec.tipoProgetto = labelOf['Tipo progetto'] || labelOf['Tipo di servizio'] || '';
    rec.fonte = (labelOf['Provenienza'] || '').slice(0, 80);

    const tsHeader = TIMESTAMP_HEADERS.find((h) => byHeader[h]);
    const tsRaw = tsHeader ? byHeader[tsHeader] : '';
    rec.ricevutoAt = parseSheetTimestamp(tsRaw);
    rec.sheetKey = sheetKeyFor(tsRaw || ('riga' + i), rec.email, rec.nome);
    records.push(rec);
  }
  return records;
}

// Un cliente è "già in lavorazione" se esiste un preventivo salvato a suo nome/email.
function hasQuoteFor(savedQuotes, email, nome) {
  const e = normalize(email);
  const n = normalize(nome);
  return savedQuotes.some((q) => {
    const c = (q && q.client) || {};
    if (e && normalize(c.clienteEmail || c.email) === e) return true;
    if (n && normalize(c.cliente) === n) return true;
    return false;
  });
}

function findClient(clients, email, nome) {
  const e = normalize(email);
  const n = normalize(nome);
  return clients.find((c) => (e && normalize(c.email) === e) || (n && normalize(c.cliente) === n));
}

// Migrazione conservativa: i clienti importati in passato dal foglio finivano tutti in Rubrica.
// Ora la Rubrica contiene solo clienti con preventivo, quindi togliamo quelli che sono ancora
// "intatti": nessun preventivo e nessun dato anagrafico aggiunto a mano. Le loro risposte non
// si perdono perché la stessa riga del foglio viene importata come richiesta.
function pruneUntouchedSheetClients(clients, savedQuotes) {
  const kept = [];
  let removed = 0;
  clients.forEach((c) => {
    const untouched = c.sourceSheet && !c.cf && !c.indirizzo && !c.piva && !c.pec &&
      (!c.tipoCliente || c.tipoCliente === 'Privato') &&
      !hasQuoteFor(savedQuotes, c.email, c.cliente);
    if (untouched) removed++; else kept.push(c);
  });
  return { clients: kept, removed };
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

  const records = rowsToLeadRecords(rows);

  const dataStore = getStore('studio-data');
  const existing = (await dataStore.get(key, { type: 'json', consistency: 'strong' })) || {};
  const savedQuotes = Array.isArray(existing.savedQuotes) ? existing.savedQuotes : [];
  const existingClients = Array.isArray(existing.clients) ? existing.clients : [];

  // Chiavi già importate (anche se poi la richiesta è stata eliminata): evitano che una
  // richiesta cancellata ricompaia ad ogni sincronizzazione.
  const seenStore = getStore('leads-sheet-seen');
  const seen = new Set((await seenStore.get(key, { type: 'json', consistency: 'strong' })) || []);

  const leadsStore = getStore('leads');
  const list = (await leadsStore.get(key, { type: 'json', consistency: 'strong' })) || [];
  list.forEach((l) => { if (l.sheetKey) seen.add(l.sheetKey); });

  const pruned = pruneUntouchedSheetClients(existingClients, savedQuotes);
  const fresh = records.filter((r) => !seen.has(r.sheetKey));
  const now = new Date().toISOString();
  fresh.forEach((r) => {
    const client = findClient(pruned.clients, r.email, r.nome);
    const quoted = hasQuoteFor(savedQuotes, r.email, r.nome);
    const entry = {
      id: 'lead_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      canale: 'modulo',
      sheetKey: r.sheetKey,
      ricevutoAt: r.ricevutoAt || now,
      mittente: r.email || r.nome,
      oggetto: r.tipoProgetto ? 'Modulo: ' + r.tipoProgetto : 'Modulo di contatto',
      testo: r.testo.slice(0, 4000),
      nome: r.nome,
      email: r.email,
      telefono: r.telefono,
      tipoProgetto: r.tipoProgetto,
      indirizzoIntervento: r.indirizzoIntervento,
      fonte: r.fonte,
      note: '',
      // Se c'è già un preventivo per questa persona la richiesta non è "nuova".
      fase: quoted ? 'preventivo_inviato' : 'nuova'
    };
    if (client) entry.clientId = client.id;
    list.push(entry);
    seen.add(r.sheetKey);
  });

  if (fresh.length) {
    list.sort((a, b) => String(b.ricevutoAt || '').localeCompare(String(a.ricevutoAt || '')));
    await leadsStore.setJSON(key, list);
    await seenStore.setJSON(key, Array.from(seen));
  }

  // Migrazione clienti storici del foglio (una tantum, con backup).
  let clients = existingClients;
  if (pruned.removed > 0) {
    const backupsStore = getStore('studio-data-backups');
    const backupKey = key + '__pre-rubrica-richieste';
    const already = await backupsStore.get(backupKey, { type: 'json' });
    if (!already) await backupsStore.setJSON(backupKey, { savedAt: now, data: existing });
    clients = pruned.clients;
    await dataStore.setJSON(key, { ...existing, clients, updatedAt: now });
  }

  console.log(`[clients-sheet-sync] key=${key} righe_foglio=${rows.length - 1} richieste_nuove=${fresh.length} clienti_rimossi_da_rubrica=${pruned.removed}`);

  return new Response(JSON.stringify({
    ok: true,
    created: fresh.length,
    removedFromRubrica: pruned.removed,
    total: list.length,
    leads: list,
    clients
  }), { status: 200 });
};
