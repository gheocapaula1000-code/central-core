// Temporary self-call test for b2b-finder-search. To be deleted after test.
Deno.serve(async () => {
  const secret = Deno.env.get("B2B_FINDER_SECRET") ?? "";
  const url = `https://${Deno.env.get("SUPABASE_PROJECT_ID") ?? "jpunnzgixcghuydstdlt"}.supabase.co/functions/v1/b2b-finder-search`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": secret,
      "x-source-app": "b2b-finder",
    },
    body: JSON.stringify({
      mode: "buyers",
      product: "Coprimacchia TNT",
      province: "PD",
      city: "Padova",
      region: "Veneto",
      limit: 50,
      dry_run: true,
    }),
  });
  const text = await resp.text();
  return new Response(text, { status: resp.status, headers: { "Content-Type": "application/json" } });
});
