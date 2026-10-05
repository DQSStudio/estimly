// Validazione dei link di presentazione Canva (modulo di supporto, nessun endpoint).
// Accettiamo solo https verso canva.com / canva.link: il link finisce in email al cliente e in
// una pagina pubblica (iframe/pulsante), quindi non deve poter puntare a siti arbitrari.
const ALLOWED_HOSTS = ['canva.com', 'www.canva.com', 'canva.link'];

export function normalizeCanvaUrl(raw) {
  const str = String(raw || '').trim();
  if (!str || str.length > 500) return null;
  let u;
  try { u = new URL(str); } catch (e) { return null; }
  if (u.protocol !== 'https:') return null;
  if (!ALLOWED_HOSTS.includes(u.hostname.toLowerCase())) return null;
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
  return { url, embedUrl };
}
