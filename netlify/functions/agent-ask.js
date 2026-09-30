// Funzione di TEST per l'assistente AI di Estimly 2.0.
// Riceve una domanda + un riepilogo aggregato dei dati dello studio, chiama l'API di
// Anthropic (Claude Haiku) e restituisce la risposta. Nessuna scrittura sui dati reali.
// Richiede la variabile d'ambiente ANTHROPIC_API_KEY configurata su Netlify (mai nel codice).

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_QUESTION_LENGTH = 500;

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Chiave non ancora configurata su questo ambiente: il frontend gestisce
    // questo caso mostrando una risposta di esempio invece di rompersi.
    return new Response(JSON.stringify({ error: 'missing_api_key' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let question, context;
  try {
    const body = await req.json();
    question = (body.question || '').toString().trim().slice(0, MAX_QUESTION_LENGTH);
    context = body.context && typeof body.context === 'object' ? body.context : {};
  } catch (err) {
    return new Response(JSON.stringify({ error: 'bad_request' }), { status: 400 });
  }

  if (!question) {
    return new Response(JSON.stringify({ error: 'empty_question' }), { status: 400 });
  }

  const systemPrompt = [
    'Sei l\'assistente AI di Estimly, il software di preventivazione dello studio di architettura Desearq.',
    'Rispondi sempre in italiano, in modo breve, chiaro e professionale (massimo 3-4 frasi).',
    'Usa SOLO i dati riassuntivi forniti qui sotto per rispondere a domande sull\'attività dello studio: non inventare mai numeri, nomi o dettagli che non ti vengono forniti.',
    'Se non hai il dato richiesto nel riepilogo, dillo chiaramente invece di indovinare.',
    'Se la domanda non riguarda i dati dello studio, rispondi comunque in modo utile restando nel ruolo di assistente di Estimly.',
    '',
    'Riepilogo aggregato attuale dello studio (nessun dato di dettaglio, solo conteggi):',
    JSON.stringify(context, null, 2)
  ].join('\n');

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: question }]
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Anthropic API error', resp.status, errText);
      return new Response(JSON.stringify({ error: 'ai_error' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const data = await resp.json();
    const reply = Array.isArray(data.content)
      ? data.content.map(block => block.text || '').join('').trim()
      : '';
    const usage = data.usage || {};

    return new Response(JSON.stringify({
      reply: reply || 'Non sono riuscito a generare una risposta, riprova tra poco.',
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('agent-ask error', err);
    return new Response(JSON.stringify({ error: 'server_error' }), { status: 500 });
  }
};
