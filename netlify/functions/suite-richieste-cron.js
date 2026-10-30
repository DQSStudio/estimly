// Collegamento View <-> Estimly, ogni 5 minuti, per ogni licenza collegata a uno studio della suite:
//  1. copia le richieste (lead) nella suite, così View le vede;
//  2. riceve da View il link della presentazione e porta il lead a "presentazione inviata";
//  3. quando il cliente ha confermato in View ("Voglio lavorare con voi") porta il lead a "vinto"
//     e manda allo studio una mail (con Resend dello studio) per preparare il preventivo definitivo.
// Se la suite non risponde non cambia nulla in Estimly: riprova al giro dopo.
import { getStore } from '@netlify/blobs';
import { licenseStore } from './lib/licenze.js';
import { normalizeCanvaUrl, loadExtraHosts } from './canva-url.js';

export const config = { schedule: '*/5 * * * *' };

const SUITE_URL = process.env.SUITE_SUPABASE_URL || 'https://qudoygcfphqhhyenpwlr.supabase.co';
const SUITE_KEY = process.env.SUITE_SUPABASE_SECRET_KEY || '';

async function rpc(nome, args) {
  const r = await fetch(SUITE_URL + '/rest/v1/rpc/' + nome, {
    method: 'POST',
    headers: { apikey: SUITE_KEY, Authorization: 'Bearer ' + SUITE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  if (!r.ok) throw new Error(nome + ' ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function porta(entry, fase, nowIso) {
  if (entry.fase === fase) return;
  entry.storia = Array.isArray(entry.storia) ? entry.storia : [];
  if (!entry.storia.length && entry.fase) entry.storia.push({ fase: entry.fase, at: entry.ricevutoAt || nowIso });
  entry.storia.push({ fase, at: nowIso });
  if (fase === 'vinto') entry.vintoAt = nowIso;
  if (entry.fase === 'perso') { delete entry.persoAt; delete entry.faseAlPerso; delete entry.motivoPerso; delete entry.motivoPersoNota; }
  entry.fase = fase;
  entry.aggiornatoAt = nowIso;
}

async function mandaMail(settings, r, entry) {
  const resendKey = settings.resendApiKey;
  const fromEmail = settings.resendFromEmail;
  if (!resendKey || !fromEmail) return { ok: false, motivo: 'email_not_configured' };
  const fromName = settings.resendFromName || settings.nome || 'Estimly';
  const a = settings.emailNotifiche || settings.email || fromEmail;
  const nome = esc(r.nome || entry.nome || 'Il cliente');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + resendKey },
    body: JSON.stringify({
      from: `${fromName} <${fromEmail}>`,
      to: a,
      subject: `${r.nome || 'Un cliente'} vuole lavorare con voi: prepara il preventivo`,
      html: `<p><strong>${nome}</strong> ha premuto "Voglio lavorare con voi" nella presentazione.</p>` +
        `<p>La richiesta in Estimly è ora <strong>Vinto</strong>: puoi preparare il preventivo definitivo.</p>` +
        (r.email ? `<p>Email del cliente: ${esc(r.email)}</p>` : '')
    })
  });
  return res.ok ? { ok: true } : { ok: false, motivo: 'resend_' + res.status };
}

export default async () => {
  if (!SUITE_KEY) { console.error('[suite-richieste] manca SUITE_SUPABASE_SECRET_KEY'); return; }
  const { blobs } = await licenseStore().list();
  const leadsStore = getStore('leads');
  const dataStore = getStore('studio-data');
  for (const b of blobs) {
    const key = b.key;
    try {
      const license = await licenseStore().get(key, { type: 'json' });
      if (!license || license.status !== 'active') continue;
      const sync = await rpc('estimly_richieste_sincronizza', { p_chiave: key, p_leads: (await leadsStore.get(key, { type: 'json' })) || [] });
      if (!sync || sync.ok === false) continue;          // studio non collegato o senza View: niente da fare
      const todo = await rpc('estimly_richieste_da_allineare', { p_chiave: key });
      if (!Array.isArray(todo) || !todo.length) continue;
      const list = (await leadsStore.get(key, { type: 'json', consistency: 'strong' })) || [];
      const studio = await dataStore.get(key, { type: 'json' });
      const settings = (studio && studio.studioSettings) || {};
      const nowIso = new Date().toISOString();
      let cambiata = false;
      for (const r of todo) {
        const entry = list.find((l) => l.id === r.lead_id);
        if (!entry) continue;
        if (r.da_allineare_presentazione && r.presentazione_url) {
          const ok = normalizeCanvaUrl(r.presentazione_url, await loadExtraHosts());   // solo Canva o View, come nel resto di Estimly
          if (ok) entry.presentazioneUrl = ok.url;
          if (entry.fase === 'nuova' || entry.fase === 'contattato') porta(entry, 'presentazione_inviata', nowIso);
          entry.aggiornatoAt = nowIso;
          cambiata = true;
          await leadsStore.setJSON(key, list);
          await rpc('estimly_richiesta_allineata', { p_chiave: key, p_lead: r.lead_id, p_tipo: 'presentazione' });
        }
        if (r.da_notificare_vinto) {
          porta(entry, 'vinto', nowIso);
          cambiata = true;
          await leadsStore.setJSON(key, list);            // prima lo stato, poi la mail: se la mail fallisce lo stato resta giusto
          const m = await mandaMail(settings, r, entry);
          if (!m.ok) { entry.mailVintoNonInviata = m.motivo; await leadsStore.setJSON(key, list); console.error('[suite-richieste] mail non inviata', key, m.motivo); }
          await rpc('estimly_richiesta_allineata', { p_chiave: key, p_lead: r.lead_id, p_tipo: 'vinto' });
        }
      }
      if (cambiata) console.log('[suite-richieste] allineata', key.slice(-4));
    } catch (e) {
      console.error('[suite-richieste] errore', key.slice(-4), String(e.message || e));
    }
  }
};
