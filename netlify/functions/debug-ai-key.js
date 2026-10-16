// Funzione diagnostica TEMPORANEA per capire perché ANTHROPIC_API_KEY dà "invalid x-api-key".
// Non espone mai il valore vero della chiave, solo lunghezza/anteprima/eventuali spazi.
// Da cancellare una volta risolto il problema (netlify/functions/debug-ai-key.js).
import { createHash } from 'node:crypto';

export default async () => {
  const val = process.env.ANTHROPIC_API_KEY;
  return new Response(JSON.stringify({
    isSet: val !== undefined,
    length: val ? val.length : 0,
    preview: val ? (val.slice(0, 8) + '…' + val.slice(-4)) : null,
    trimmedMatches: val ? (val === val.trim()) : null,
    startsCorrectly: val ? val.startsWith('sk-ant-') : null,
    // Codice di controllo (SHA-256, primi 12 caratteri): confrontalo con quello calcolato sulla tua chiave.
    sha256Prefix: val ? createHash('sha256').update(val).digest('hex').slice(0, 12) : null
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
