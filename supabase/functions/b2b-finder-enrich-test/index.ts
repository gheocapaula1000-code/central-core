// Temporary proxy: invokes b2b-finder-enrich with secret from env. Delete after test.
Deno.serve(async (req) => {
  const body = await req.text();
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const secret = Deno.env.get("B2B_FINDER_SECRET")!;
  const r = await fetch(`${SUPABASE_URL}/functions/v1/b2b-finder-enrich`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-source-app": "b2b-finder",
      "x-internal-secret": secret,
      Authorization: req.headers.get("authorization") ?? "",
    },
    body,
  });
  const text = await r.text();
  return new Response(text, { status: r.status, headers: { "Content-Type": "application/json" } });
});
