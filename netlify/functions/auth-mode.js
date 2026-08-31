export default async () => {
  const mode = process.env.AUTH_MODE === 'login' ? 'login' : 'key';
  return new Response(JSON.stringify({ mode }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};
