// Funzione diagnostica TEMPORANEA per capire perché ANTHROPIC_API_KEY dà "invalid x-api-key".
// Non espone mai il valore vero della chiave, solo lunghezza/anteprima/eventuali spazi.
// Da cancellare una volta risolto il problema (netlify/functions/debug-ai-key.js).
export default async () => {
  const val = process.env.ANTHROPIC_API_KEY;
  return new Response(JSON.stringify({
    isSet: val !== undefined,
    length: val ? val.length : 0,
    preview: val ? (val.slice(0, 8) + '…' + val.slice(-4)) : null,
    trimmedMatches: val ? (val === val.trim()) : null,
    startsCorrectly: val ? val.startsWith('sk-ant-') : null
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
