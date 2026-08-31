export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch (err) {
    return new Response(JSON.stringify({ valid: false }), { status: 400 });
  }

  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';

  const expectedEmail = (process.env.INTERNAL_EMAIL || '').trim().toLowerCase();
  const expectedPassword = process.env.INTERNAL_PASSWORD || '';

  const valid = !!expectedEmail && !!expectedPassword && email === expectedEmail && password === expectedPassword;

  return new Response(JSON.stringify({ valid }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};
