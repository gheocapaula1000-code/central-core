// v3.2.3
// health check endpoint — Central Core v3

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "*";

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-source-app, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  const debugId = "health-" + crypto.randomUUID().slice(0, 8);

  return new Response(
    JSON.stringify({ ok: true, data: { status: "healthy", time: new Date().toISOString() }, warnings: [], debug_id: debugId }),
    { status: 200, headers: { ...headers, "x-debug-id": debugId } },
  );
});
