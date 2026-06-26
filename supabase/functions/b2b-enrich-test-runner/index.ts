// Temp test runner: reads B2B_FINDER_SECRET from env and proxies calls to b2b-finder-enrich.
// POST body: { action, ...payload }
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok");
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/b2b-finder-enrich`;
  const secret = Deno.env.get("B2B_FINDER_SECRET") ?? "";
  const body = await req.text();
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-source-app": "b2b-finder",
      "x-internal-secret": secret,
    },
    body,
  });
  const text = await r.text();
  return new Response(text, { status: r.status, headers: { "Content-Type": "application/json" } });
});
