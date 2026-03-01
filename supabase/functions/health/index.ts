import { makeDebugId } from "../_shared/http.ts";

const PUBLIC_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-internal-secret, x-app-secret, x-core-secret, x-source-app",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: PUBLIC_CORS_HEADERS });
  }

  const debugId = makeDebugId();
  const body = { ok: true, status: "healthy", time: new Date().toISOString(), debug_id: debugId };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      ...PUBLIC_CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "x-debug-id": debugId,
    },
  });
});
