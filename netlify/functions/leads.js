import { authorize } from './lib/auth.js';
import { getStore } from '@netlify/blobs';

// ===================== Lettura e gestione lead (Estimly 2.0) =====================
// I lead vengono creati da inbound-lead.js (webhook Resend, nome/email letti dall'intestazione
// della mail) e salvati nello store 'leads' (array per licenza, più recenti in testa). Questa
// function serve il frontend: elenco, cambio fase/provenienza, modifica manuale dei campi,
// eliminazione.

const VALID_FASI = ['nuova', 'contattato', 'presentazione_inviata', 'preventivo_inviato', 'vinto', 'perso'];
// La provenienza non è più vincolata a un elenco fisso: oltre ai pulsanti rapidi (Sito web,
// Google, Instagram, ecc.) lo studio può scrivere un valore libero (es. il nome di una
// campagna pubblicitaria), per poter testare esattamente da dove arrivano i contatti.
const FONTE_MAX_LEN = 80;
// Campi della richiesta modificabili a mano dalla scheda lead (niente estrazione AI:
// nome/email vengono riconosciuti dall'intestazione della mail, il resto si compila a mano).
// Motivi di perdita predefiniti (per le statistiche); è ammesso anche un testo libero breve.
const MOTIVI_PERSO = ['Prezzo troppo alto', 'Ha scelto un altro professionista', 'Tempistiche non compatibili', 'Budget insufficiente', 'Progetto rimandato o annullato', 'Non risponde più', 'Fuori zona', 'Servizio non offerto', 'Altro'];
const MOTIVO_MAX_LEN = 80;
const NOTA_MAX_LEN = 500;
const EDITABLE_FIELDS = ['nome', 'email', 'telefono', 'tipoProgetto', 'indirizzoIntervento', 'note'];

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

  // Accesso: sessione (email + password) o, finché lo studio non attiva i login, chiave di licenza.
  const auth = await authorize(body, 'leads');
  if (auth.error) return auth.error;
  body.key = auth.key;

  const key = (body.key || '').trim().toUpperCase();
  if (!key) {
    return new Response(JSON.stringify({ error: 'missing_key' }), { status: 400 });
  }

  const licenses = getStore('licenses');
  const license = await licenses.get(key, { type: 'json' });
  if (!license || license.status !== 'active') {
    return new Response(JSON.stringify({ error: 'invalid_license' }), { status: 401 });
  }

  const leadsStore = getStore('leads');
  const action = body.action;

  if (action === 'list') {
    const list = (await leadsStore.get(key, { type: 'json', consistency: 'strong' })) || [];
    return new Response(JSON.stringify({ leads: list }), { status: 200 });
  }

  if (action === 'updateStage') {
    const { leadId, fase } = body;
    if (!leadId || !VALID_FASI.includes(fase)) {
      return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400 });
    }
    const list = (await leadsStore.get(key, { type: 'json', consistency: 'strong' })) || [];
    const entry = list.find((l) => l.id === leadId);
    if (!entry) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }
    const nowIso = new Date().toISOString();
    const prev = entry.fase;
    if (prev !== fase) {
      // Storico dei passaggi di fase: serve alle statistiche per capire dove le richieste si fermano.
      entry.storia = Array.isArray(entry.storia) ? entry.storia : [];
      if (!entry.storia.length && prev) entry.storia.push({ fase: prev, at: entry.ricevutoAt || nowIso });
      entry.storia.push({ fase, at: nowIso });
      if (fase === 'perso') { entry.persoAt = nowIso; entry.faseAlPerso = prev; }
      if (fase === 'vinto') entry.vintoAt = nowIso;
      if (prev === 'perso' && fase !== 'perso') { delete entry.persoAt; delete entry.faseAlPerso; delete entry.motivoPerso; delete entry.motivoPersoNota; }
    }
    entry.fase = fase;
    entry.aggiornatoAt = nowIso;
    await leadsStore.setJSON(key, list);
    return new Response(JSON.stringify({ ok: true, lead: entry }), { status: 200 });
  }

  // Motivo per cui la richiesta è stata persa (elenco predefinito o testo libero) + nota facoltativa.
  if (action === 'updateLoss') {
    const { leadId } = body;
    const motivo = String(body.motivo || '').trim().slice(0, MOTIVO_MAX_LEN);
    const nota = String(body.nota || '').trim().slice(0, NOTA_MAX_LEN);
    if (!leadId) {
      return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400 });
    }
    const list = (await leadsStore.get(key, { type: 'json', consistency: 'strong' })) || [];
    const entry = list.find((l) => l.id === leadId);
    if (!entry) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }
    entry.motivoPerso = motivo;
    entry.motivoPersoNota = nota;
    entry.aggiornatoAt = new Date().toISOString();
    await leadsStore.setJSON(key, list);
    return new Response(JSON.stringify({ ok: true, lead: entry }), { status: 200 });
  }

  if (action === 'updateFonte') {
    const { leadId } = body;
    const fonte = String(body.fonte || '').trim().slice(0, FONTE_MAX_LEN);
    if (!leadId) {
      return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400 });
    }
    const list = (await leadsStore.get(key, { type: 'json', consistency: 'strong' })) || [];
    const entry = list.find((l) => l.id === leadId);
    if (!entry) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }
    entry.fonte = fonte;
    entry.aggiornatoAt = new Date().toISOString();
    await leadsStore.setJSON(key, list);
    return new Response(JSON.stringify({ ok: true, lead: entry }), { status: 200 });
  }

  if (action === 'updateFields') {
    const { leadId, fields } = body;
    if (!leadId || !fields || typeof fields !== 'object') {
      return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400 });
    }
    const list = (await leadsStore.get(key, { type: 'json', consistency: 'strong' })) || [];
    const entry = list.find((l) => l.id === leadId);
    if (!entry) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }
    EDITABLE_FIELDS.forEach((f) => {
      if (Object.prototype.hasOwnProperty.call(fields, f)) {
        entry[f] = String(fields[f] || '').trim();
      }
    });
    entry.aggiornatoAt = new Date().toISOString();
    await leadsStore.setJSON(key, list);
    return new Response(JSON.stringify({ ok: true, lead: entry }), { status: 200 });
  }

  // La presentazione (link Canva) è stata inviata al cliente: salva la data e, se la richiesta è
  // ancora "nuova"/"contattato", la porta alla fase "Presentazione inviata".
  if (action === 'markPresentationSent') {
    const { leadId } = body;
    if (!leadId) {
      return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400 });
    }
    const list = (await leadsStore.get(key, { type: 'json', consistency: 'strong' })) || [];
    const entry = list.find((l) => l.id === leadId);
    if (!entry) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }
    const now = new Date().toISOString();
    entry.presentazioneInviataAt = now;
    if (entry.fase === 'nuova' || entry.fase === 'contattato') entry.fase = 'presentazione_inviata';
    entry.aggiornatoAt = now;
    await leadsStore.setJSON(key, list);
    return new Response(JSON.stringify({ ok: true, lead: entry }), { status: 200 });
  }

  // Collega la richiesta al cliente creato in Rubrica (quando parte il preventivo).
  if (action === 'linkClient') {
    const { leadId, clientId } = body;
    if (!leadId || !clientId) {
      return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400 });
    }
    const list = (await leadsStore.get(key, { type: 'json', consistency: 'strong' })) || [];
    const entry = list.find((l) => l.id === leadId);
    if (!entry) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }
    entry.clientId = String(clientId);
    entry.aggiornatoAt = new Date().toISOString();
    await leadsStore.setJSON(key, list);
    return new Response(JSON.stringify({ ok: true, lead: entry }), { status: 200 });
  }

  if (action === 'delete') {
    const { leadId } = body;
    if (!leadId) {
      return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400 });
    }
    const list = (await leadsStore.get(key, { type: 'json', consistency: 'strong' })) || [];
    const filtered = list.filter((l) => l.id !== leadId);
    await leadsStore.setJSON(key, filtered);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  return new Response(JSON.stringify({ error: 'unknown_action' }), { status: 400 });
};
