// Validazione dei link di presentazione (modulo di supporto, nessun endpoint).
// Il link finisce in una pagina pubblica di Estimly (iframe/pulsante) e nelle email ai clienti, quindi
// non può puntare a siti arbitrari. Sono ammessi solo link https verso:
//  - Canva (con anteprima incorporata dove possibile);
//  - View (dsqview.netlify.app, host esatto; il codice di accesso sta dopo il "?", es. /?s=...);
//  - i servizi di presentazione/condivisione più usati (elenco qui sotto);
//  - altri domini aggiunti dall'amministrazione di Estimly (store 'settings', chiave 'presentation-hosts').
// Niente indirizzi IP, porte, utente:password, http. Il "#" si toglie solo ai link Canva.
import { getStore } from '@netlify/blobs';

const CANVA_HOSTS = ['canva.com', 'www.canva.com', 'canva.link'];
const VIEW_HOSTS = ['dsqview.netlify.app'];
// Dominio e suoi sottodomini (servizi in cui ogni utente/azienda ha un proprio sottodominio).
const SERVIZI_DOMINI = [
  'docs.google.com', 'drive.google.com', 'canva.com', 'figma.com', 'miro.com', 'pitch.com', 'gamma.app',
  'genial.ly', 'genially.com', 'prezi.com', 'slides.com', 'beautiful.ai', 'notion.site', 'notion.so',
  'sharepoint.com', 'onedrive.live.com', '1drv.ms', 'dropbox.com', 'wetransfer.com', 'we.tl',
  'loom.com', 'vimeo.com', 'youtube.com', 'youtu.be', 'behance.net', 'issuu.com', 'icloud.com',
  'mural.co', 'visme.co', 'tome.app'
];

export const HOSTS_STORE = 'settings';
export const HOSTS_KEY = 'presentation-hosts';
let hostsCache = { t: 0, v: [] };

export function dominioValido(d) {
  d = String(d || '').trim().toLowerCase();
  return /^(?=.{4,100}$)([a-z0-9-]{1,63}\.)+[a-z]{2,24}$/.test(d) && !/^[0-9.]+$/.test(d) ? d : null;
}

// Domini extra decisi dall'amministrazione (cache breve; se lo store non risponde, nessun extra).
export async function loadExtraHosts() {
  if (Date.now() - hostsCache.t < 60000) return hostsCache.v;
  let v = [];
  try {
    const l = await getStore(HOSTS_STORE).get(HOSTS_KEY, { type: 'json' });
    if (Array.isArray(l)) v = l.map(dominioValido).filter(Boolean);
  } catch (e) { /* nessun extra */ }
  hostsCache = { t: Date.now(), v };
  return v;
}

const sottoDominio = (host, d) => host === d || host.endsWith('.' + d);

export function normalizeCanvaUrl(raw, extraHosts = []) {
  const str = String(raw || '').trim();
  if (!str || str.length > 500) return null;
  let u;
  try { u = new URL(str); } catch (e) { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (u.username || u.password || u.port) return null;
  if (VIEW_HOSTS.includes(host)) {
    // View: niente anteprima incorporata, il cliente lo apre con un pulsante dalla pagina di Estimly.
    return { url: u.href, embedUrl: null, kind: 'view' };
  }
  if (!CANVA_HOSTS.includes(host)) {
    // Altri servizi: nessuna anteprima incorporata, il cliente apre il link con un pulsante.
    const ammesso = SERVIZI_DOMINI.some((d) => sottoDominio(host, d)) || (extraHosts || []).some((d) => sottoDominio(host, d));
    if (!ammesso) return null;
    return { url: u.href, embedUrl: null, kind: 'altro' };
  }
  u.hash = '';
  const url = u.href;
  // Solo i link di visualizzazione dei design (canva.com/design/ID/TOKEN/view) si possono
  // incorporare in una pagina con ?embed; i link brevi (canva.link) si aprono solo con un pulsante.
  let embedUrl = null;
  if (u.hostname.toLowerCase().endsWith('canva.com') && /^\/design\/[^/]+\/[^/]+\/(view|watch)\/?$/.test(u.pathname)) {
    const e = new URL(url);
    e.search = '';
    e.searchParams.set('embed', '');
    embedUrl = e.href.replace('embed=', 'embed');
  }
  return { url, embedUrl, kind: 'canva' };
}
