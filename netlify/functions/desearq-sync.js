// ===================== Sincronizzazione con Desearq Studio Manager (Estimly 2.0) =====================
// Modulo di supporto (nessun export default -> non è un endpoint Netlify a sé, solo funzioni
// importate da altri file della cartella functions, come già fatto per markPaymentPaid in
// stripe-connect.js).
//
// Spinge i preventivi firmati su Estimly nella tabella public.estimly_quotes del progetto
// Supabase "Desearq Studio Manager" (qgeiehavpnqdxqnggfzq) — stesso progetto già usato da
// estimly-benchmarks.js. Tabella e policy RLS sono già predisposte lato Desearq Studio Manager:
// il ruolo anon può fare INSERT/UPDATE solo su righe con external_id valorizzato (INSERT, poi
// PATCH per external_id se esiste già), quindi Estimly non può toccare le righe gestite da altri strumenti.
//
// Due momenti di sincronizzazione, stessa funzione:
//   - alla firma del cliente: markNuovo=true -> imposta anche stato:'Nuovo' (il preventivo
//     compare come nuovo arrivo nella sezione Preventivi di Desearq Studio Manager)
//   - a ogni pagamento confermato: markNuovo=false -> aggiorna importo/pagamenti nel payload
//     SENZA toccare 'stato', per non sovrascrivere lo stato che lo studio ha eventualmente
//     già cambiato manualmente dentro Desearq Studio Manager (es. 'Confermato')
//
// Richiede la variabile d'ambiente SUPABASE_ANON_KEY (già impostata per estimly-benchmarks.js).
// Se assente, la sincronizzazione viene saltata silenziosamente: non deve mai bloccare firma
// o pagamento, che sono il percorso critico per il cliente finale.

import { createHash } from 'node:crypto';

const SUITE_URL = 'https://qudoygcfphqhhyenpwlr.supabase.co';

const REGIMI_RATE = {
  ord22: 0.22, rid10: 0.10, rid4: 0.04, esente: 0, forfettario: 0, reverse: 0
};

function lineTotal(l){
  return l.modalita === 'orario' ? (l.ore || 0) * (l.tariffa || 0) : (l.qty || 0) * (l.prezzo || 0);
}

function computeTotale(quote){
  const client = quote.client || {};
  const cart = Array.isArray(quote.cart) ? quote.cart : [];
  const imponibile = cart.reduce((s, l) => s + lineTotal(l), 0);
  const sconto = imponibile * (client.sconto || 0) / 100;
  const netto = imponibile - sconto;
  const contributo = netto * (client.contributoPct || 0) / 100;
  const baseIva = netto + contributo;
  const rate = client.regime === 'custom'
    ? (client.aliquotaCustom || 0) / 100
    : (Object.prototype.hasOwnProperty.call(REGIMI_RATE, client.regime) ? REGIMI_RATE[client.regime] : 0.22);
  const iva = baseIva * (rate || 0);
  return Math.round((baseIva + iva) * 100) / 100;
}

export async function syncQuoteToDesearqManager(quote, opts){
  // I preventivi vanno al Manager della suite tramite la licenza (impronta SHA-256), con la chiave segreta del server.
  const secret = process.env.SUITE_SUPABASE_SECRET_KEY;
  const key = opts && opts.key ? String(opts.key).trim().toUpperCase() : '';
  if(!secret || !key || !quote || !quote.id) return false;
  const suiteUrl = process.env.SUITE_SUPABASE_URL || SUITE_URL;

  const client = quote.client || {};
  const row = {
    id: quote.id,
    numero: client.numero || null,
    revisione: client.revisione || null,
    data: client.data || null,
    cliente_nome: client.cliente || null,
    cliente_email: client.clienteEmail || null,
    progetto_label: client.progetto || null,
    totale: computeTotale(quote),
    payload: {
      // Il Manager cerca "payload.client.email": alias del campo "clienteEmail" di Estimly.
      client: { ...client, email: client.clienteEmail || client.email || '' },
      cart: Array.isArray(quote.cart) ? quote.cart : []
    }
  };
  try{
    const hash = createHash('sha256').update(key).digest('hex');
    const res = await fetch(`${suiteUrl}/rest/v1/rpc/estimly_sincronizza_preventivo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: secret, Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ p_chiave_hash: hash, p_riga: row, p_nuovo: !!(opts && opts.markNuovo) })
    });
    const out = await res.json().catch(() => ({}));
    if(!res.ok || out.ok === false){
      console.error('Sincronizzazione con il Manager della suite rifiutata', res.status, JSON.stringify(out).slice(0, 300));
      return false;
    }
    return true;
  }catch(err){
    // Non critico: firma e pagamento devono comunque andare a buon fine anche se la sincronizzazione fallisce.
    console.error('Sincronizzazione con il Manager della suite fallita', err);
    return false;
  }
}
