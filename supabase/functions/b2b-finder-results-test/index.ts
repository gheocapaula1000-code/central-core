// Temporary test caller for b2b-finder-results. Deleted after verification.
Deno.serve(async (req) => {
  const secret = Deno.env.get("B2B_FINDER_SECRET") ?? "";
  const body = await req.text();
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/b2b-finder-results`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-source-app": "b2b-finder",
      "x-internal-secret": secret,
      "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      "authorization": `Bearer ${Deno.env.get("SUPABASE_ANON_KEY") ?? ""}`,
    },
    body,
  });
  const text = await r.text();
  return new Response(text, { status: r.status, headers: { "content-type": "application/json", "x-upstream-status": String(r.status) } });
});
