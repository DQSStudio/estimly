// Validazione dei link di presentazione (modulo di supporto, nessun endpoint).
// Accettiamo solo https verso Canva (canva.com / canva.link) oppure verso View (dsqview.netlify.app,
// host esatto): il link finisce in una pagina pubblica (iframe/pulsante), quindi non deve poter
// puntare a siti arbitrari. Il link di accesso a View porta il codice dopo il "?" (es. /?s=...),
// quindi la rimozione del "#" non lo rovina; il "#" si toglie comunque solo ai link Canva.
const CANVA_HOSTS = ['canva.com', 'www.canva.com', 'canva.link'];
const VIEW_HOSTS = ['dsqview.netlify.app'];

export function normalizeCanvaUrl(raw) {
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
  if (!CANVA_HOSTS.includes(host)) return null;
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
