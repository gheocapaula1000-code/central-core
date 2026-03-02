import { corsHeaders, handleOptions, makeDebugId, CORE_VERSION } from "../_shared/http.ts";

Deno.serve((req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = "health-" + makeDebugId().slice(0, 8);
  return new Response(
    JSON.stringify({
      ok: true,
      data: { status: "healthy", version: CORE_VERSION, time: new Date().toISOString() },
      warnings: [],
      debug_id: debugId,
    }),
    {
      status: 200,
      headers: { ...corsHeaders(req), "Content-Type": "application/json", "x-debug-id": debugId },
    },
  );
});
