import { corsHeaders, handleOptions } from "../_shared/http.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  const body = { ok: true, status: "healthy", time: new Date().toISOString() };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8" },
  });
});
