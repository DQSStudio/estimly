const SUPABASE_URL = 'https://qgeiehavpnqdxqnggfzq.supabase.co';

export default async () => {
  const key = process.env.SUPABASE_ANON_KEY || '';

  if (!key) {
    return new Response(JSON.stringify({ ok: false, step: 'env', error: 'SUPABASE_ANON_KEY non impostata su questo sito' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const payload = {
    id: 'test_diagnostico_' + Date.now(),
    external_id: 'test_diagnostico_' + Date.now(),
    numero: 'TEST-DIAGNOSTICO',
    cliente_nome: 'Test diagnostico automatico',
    totale: 1
  };

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/estimly_quotes?on_conflict=external_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text();

    return new Response(JSON.stringify({
      ok: res.ok,
      step: 'supabase-request',
      status: res.status,
      supabaseResponse: text
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    return new Response(JSON.stringify({ ok: false, step: 'fetch-error', error: String(err) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
