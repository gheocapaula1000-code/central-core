Deno.serve(async (req) => {

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-source-app",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json"
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  const debugId = "health-" + crypto.randomUUID().slice(0, 8);
  return new Response(JSON.stringify({ ok: true, data: { status: "healthy", time: new Date().toISOString() }, warnings: [], debug_id: debugId }), { status: 200, headers: { ...headers, "x-debug-id": debugId } });
});
