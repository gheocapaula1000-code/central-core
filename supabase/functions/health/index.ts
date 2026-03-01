import { corsHeaders, handleOptions, makeDebugId } from "../_shared/http.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  const debugId = makeDebugId();
  const body = { ok: true, status: "healthy", time: new Date().toISOString(), debug_id: debugId };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8", "x-debug-id": debugId },
  });
});
