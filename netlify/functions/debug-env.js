export default async () => {
  const val = process.env.ADMIN_PASSWORD;
  return new Response(JSON.stringify({
    isSet: val !== undefined,
    length: val ? val.length : 0,
    preview: val ? (val.slice(0, 2) + '***' + val.slice(-2)) : null,
    trimmedMatches: val ? (val === val.trim()) : null
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
