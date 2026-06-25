// TEMP test runner — Step 4 verification. Will be deleted after tests.
Deno.serve(async (_req: Request) => {
  const secret = Deno.env.get("B2B_FINDER_SECRET") ?? "";
  const url = "https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/b2b-finder-search";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const headers = {
    "Content-Type": "application/json",
    "x-source-app": "b2b-finder",
    "x-internal-secret": secret,
    "apikey": anon,
    "Authorization": `Bearer ${anon}`,
  };
  const url2 = new URL(_req.url);
  const test = url2.searchParams.get("test") ?? "dry";
  let body: Record<string, unknown> = {
    mode: "buyers",
    city: "Padova",
    province: "PD",
    region: "Veneto",
    limit: 10,
    dry_run: true,
  };
  if (test === "save10") body = { ...body, dry_run: false, limit: 10 };
  if (test === "save10b") body = { ...body, dry_run: false, limit: 10 };
  if (test === "clamp") body = { ...body, dry_run: false, limit: 200 };

  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const txt = await r.text();
  return new Response(JSON.stringify({ status: r.status, body: txt.slice(0, 4000) }), {
    headers: { "Content-Type": "application/json" },
  });
});
