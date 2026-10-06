import { getStore } from '@netlify/blobs';
import { syncQuoteToDesearqManager } from './desearq-sync.js';

const MAX_SAVED_QUOTES_BASE = 10;
const MAX_SAVED_QUOTES_ESTIMLY2 = 100;

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

  const key = (body.key || '').trim().toUpperCase();
  if (!key) {
    return new Response(JSON.stringify({ error: 'missing key' }), { status: 400 });
  }

  const licenses = getStore('licenses');
  const license = await licenses.get(key, { type: 'json' });
  if (!license || license.status !== 'active') {
    return new Response(JSON.stringify({ error: 'invalid license' }), { status: 401 });
  }

  const dataStore = getStore('studio-data');
  const maxSavedQuotes = license.followupEnabled ? MAX_SAVED_QUOTES_ESTIMLY2 : MAX_SAVED_QUOTES_BASE;

  if (body.action === 'load') {
    const record = await dataStore.get(key, { type: 'json' });
    if (!record) {
      return new Response(JSON.stringify({ found: false, savedQuotes: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      found: true,
      catalog: record.catalog,
      studioSettings: record.studioSettings,
      categoryOrder: record.categoryOrder,
      savedQuotes: Array.isArray(record.savedQuotes) ? record.savedQuotes : [],
      clients: Array.isArray(record.clients) ? record.clients : []
    }), { status: 200 });
  }

  if (body.action === 'save') {
    const existing = await dataStore.get(key, { type: 'json' });
    if (existing) {
      const backupsStore = getStore('studio-data-backups');
      const lastBackup = await backupsStore.get(key, { type: 'json' });
      const dayMs = 24 * 60 * 60 * 1000;
      const isStale = !lastBackup || (Date.now() - new Date(lastBackup.savedAt).getTime()) > dayMs;
      if (isStale) {
        await backupsStore.setJSON(key, { savedAt: new Date().toISOString(), data: existing });
      }
    }
    const record = {
      catalog: Array.isArray(body.catalog) ? body.catalog : [],
      studioSettings: body.studioSettings || {},
      categoryOrder: Array.isArray(body.categoryOrder) ? body.categoryOrder : [],
      savedQuotes: existing && Array.isArray(existing.savedQuotes) ? existing.savedQuotes : [],
      clients: existing && Array.isArray(existing.clients) ? existing.clients : [],
      updatedAt: new Date().toISOString()
    };
    await dataStore.setJSON(key, record);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  if (body.action === 'saveQuote') {
    if (!body.quote || typeof body.quote !== 'object') {
      return new Response(JSON.stringify({ error: 'missing quote' }), { status: 400 });
    }
    const existing = (await dataStore.get(key, { type: 'json' })) || {};
    const savedQuotes = Array.isArray(existing.savedQuotes) ? existing.savedQuotes : [];
    const entry = {
      id: 'q_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      savedAt: new Date().toISOString(),
      cart: Array.isArray(body.quote.cart) ? body.quote.cart : [],
      idCounter: body.quote.idCounter || 1,
      client: body.quote.client || {},
      vinto: false,
      valido: true
    };
    const updated = [entry, ...savedQuotes].slice(0, maxSavedQuotes);
    const record = {
      catalog: existing.catalog || [],
      studioSettings: existing.studioSettings || {},
      categoryOrder: existing.categoryOrder || [],
      savedQuotes: updated,
      clients: Array.isArray(existing.clients) ? existing.clients : [],
      updatedAt: new Date().toISOString()
    };
    await dataStore.setJSON(key, record);
    return new Response(JSON.stringify({ ok: true, savedQuotes: updated }), { status: 200 });
  }

  if (body.action === 'updateQuote') {
    if (!body.id) {
      return new Response(JSON.stringify({ error: 'missing id' }), { status: 400 });
    }
    const existing = (await dataStore.get(key, { type: 'json', consistency: 'strong' })) || {};
    const savedQuotes = Array.isArray(existing.savedQuotes) ? existing.savedQuotes : [];
    const idx = savedQuotes.findIndex((q) => q.id === body.id);
    if (idx === -1) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }
    const patch = (body.patch && typeof body.patch === 'object') ? body.patch : {};
    // "Vinto" spuntato manualmente dallo studio (casi non passati dalla firma online: accettazione
    // a voce, via email, ecc.) deve comunque far comparire il progetto in Desearq Studio Manager,
    // esattamente come già avviene alla firma del cliente (vedi signPublicQuote in public-quote.js).
    // Si sincronizza solo sulla transizione false/assente -> true, non ad ogni salvataggio con
    // vinto già true, per non rimandare ogni volta lo stesso preventivo.
    const wasVinto = !!savedQuotes[idx].vinto;
    // Firma e pagamenti già incassati vivono solo sul server (firma online, webhook Stripe): una copia
    // locale più vecchia del preventivo non deve mai cancellarli o riportarli a "in attesa".
    if (patch.client && typeof patch.client === 'object') {
      const prevClient = savedQuotes[idx].client || {};
      const merged = { ...patch.client };
      if (prevClient.firma) merged.firma = prevClient.firma;
      if (Array.isArray(patch.client.pagamenti) || Array.isArray(prevClient.pagamenti)) {
        const prevPag = Array.isArray(prevClient.pagamenti) ? prevClient.pagamenti : [];
        const incoming = Array.isArray(patch.client.pagamenti) ? patch.client.pagamenti : prevPag;
        const paidPrev = prevPag.filter(p => p.stato === 'pagato');
        const byId = new Map(incoming.map(p => [p.id, p]));
        paidPrev.forEach(p => byId.set(p.id, p));
        merged.pagamenti = Array.from(byId.values());
      }
      patch.client = merged;
    }
    savedQuotes[idx] = { ...savedQuotes[idx], ...patch };
    const becameVinto = !wasVinto && savedQuotes[idx].vinto === true;
    const record = {
      catalog: existing.catalog || [],
      studioSettings: existing.studioSettings || {},
      categoryOrder: existing.categoryOrder || [],
      savedQuotes,
      clients: Array.isArray(existing.clients) ? existing.clients : [],
      updatedAt: new Date().toISOString()
    };
    await dataStore.setJSON(key, record);
    if (becameVinto && license.suiteEnabled) {
      await syncQuoteToDesearqManager(savedQuotes[idx], { markNuovo: true });
    }
    return new Response(JSON.stringify({ ok: true, savedQuotes }), { status: 200 });
  }

  // Invio (o reinvio) a Desearq Studio Manager dei preventivi firmati o accettati: serve per
  // recuperare quelli rimasti fuori quando la sincronizzazione automatica non andava a buon fine.
  if (body.action === 'syncManager') {
    if (!license.suiteEnabled) {
      return new Response(JSON.stringify({ error: 'suite_disabled' }), { status: 403 });
    }
    const existing = (await dataStore.get(key, { type: 'json', consistency: 'strong' })) || {};
    const savedQuotes = Array.isArray(existing.savedQuotes) ? existing.savedQuotes : [];
    const targets = savedQuotes.filter((q) => {
      if (body.id) return q.id === body.id;
      return q.vinto === true || (q.client && q.client.firma && q.client.firma.firmato);
    });
    let synced = 0;
    let failed = 0;
    for (const q of targets) {
      const ok = await syncQuoteToDesearqManager(q, { markNuovo: true });
      if (ok) synced++; else failed++;
    }
    return new Response(JSON.stringify({ ok: failed === 0, synced, failed, total: targets.length }), { status: 200 });
  }

  if (body.action === 'deleteQuote') {
    if (!body.id) {
      return new Response(JSON.stringify({ error: 'missing id' }), { status: 400 });
    }
    const existing = (await dataStore.get(key, { type: 'json' })) || {};
    const savedQuotes = Array.isArray(existing.savedQuotes) ? existing.savedQuotes : [];
    const updated = savedQuotes.filter((q) => q.id !== body.id);
    const record = {
      catalog: existing.catalog || [],
      studioSettings: existing.studioSettings || {},
      categoryOrder: existing.categoryOrder || [],
      savedQuotes: updated,
      clients: Array.isArray(existing.clients) ? existing.clients : [],
      updatedAt: new Date().toISOString()
    };
    await dataStore.setJSON(key, record);
    return new Response(JSON.stringify({ ok: true, savedQuotes: updated }), { status: 200 });
  }

  if (body.action === 'saveClient') {
    if (!body.client || typeof body.client !== 'object') {
      return new Response(JSON.stringify({ error: 'missing client' }), { status: 400 });
    }
    const existing = (await dataStore.get(key, { type: 'json' })) || {};
    const clients = Array.isArray(existing.clients) ? existing.clients : [];
    let updated;
    const incomingId = body.client.id;
    if (incomingId && clients.some((c) => c.id === incomingId)) {
      // Aggiorna una scheda cliente esistente nella rubrica
      updated = clients.map((c) => (c.id === incomingId ? { ...c, ...body.client, updatedAt: new Date().toISOString() } : c));
    } else {
      const entry = {
        id: incomingId || ('c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)),
        cliente: body.client.cliente || '',
        tipoCliente: body.client.tipoCliente || 'Privato',
        cf: body.client.cf || '',
        indirizzo: body.client.indirizzo || '',
        piva: body.client.piva || '',
        email: body.client.email || '',
        telefono: body.client.telefono || '',
        pec: body.client.pec || '',
        indirizzoIntervento: body.client.indirizzoIntervento || '',
        note: body.client.note || '',
        // Provenienza e collegamento alla richiesta d'origine (vedi leads.js): la Rubrica
        // contiene solo clienti con preventivo, ma conserva da dove sono arrivati.
        fonte: String(body.client.fonte || '').slice(0, 80),
        canale: body.client.canale || '',
        leadId: body.client.leadId || '',
        createdAt: new Date().toISOString()
      };
      updated = [entry, ...clients];
    }
    const record = {
      catalog: existing.catalog || [],
      studioSettings: existing.studioSettings || {},
      categoryOrder: existing.categoryOrder || [],
      savedQuotes: Array.isArray(existing.savedQuotes) ? existing.savedQuotes : [],
      clients: updated,
      updatedAt: new Date().toISOString()
    };
    await dataStore.setJSON(key, record);
    return new Response(JSON.stringify({ ok: true, clients: updated }), { status: 200 });
  }

  if (body.action === 'deleteClient') {
    if (!body.id) {
      return new Response(JSON.stringify({ error: 'missing id' }), { status: 400 });
    }
    const existing = (await dataStore.get(key, { type: 'json' })) || {};
    const clients = Array.isArray(existing.clients) ? existing.clients : [];
    const updated = clients.filter((c) => c.id !== body.id);
    const record = {
      catalog: existing.catalog || [],
      studioSettings: existing.studioSettings || {},
      categoryOrder: existing.categoryOrder || [],
      savedQuotes: Array.isArray(existing.savedQuotes) ? existing.savedQuotes : [],
      clients: updated,
      updatedAt: new Date().toISOString()
    };
    await dataStore.setJSON(key, record);
    return new Response(JSON.stringify({ ok: true, clients: updated }), { status: 200 });
  }

  return new Response(JSON.stringify({ error: 'unknown action' }), { status: 400 });
};
