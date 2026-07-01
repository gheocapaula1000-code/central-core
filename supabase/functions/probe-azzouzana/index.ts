import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
const APIFY = "https://api.apify.com/v2";
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const token = Deno.env.get("APIFY_API_TOKEN") ?? "";
  if (req.headers.get("x-job-secret") !== Deno.env.get("CENTRAL_CORE_JOB_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const actor = "azzouzana~immobiliare-it-listing-page-scraper-by-search-url";
  const inputs = [
    { label: "startUrl-string", input: { startUrl: "https://www.immobiliare.it/vendita-case/padova/", maxItems: 3 } },
    { label: "startUrl-object", input: { startUrl: { url: "https://www.immobiliare.it/vendita-case/padova/" }, maxItems: 3 } },
    { label: "startUrls-array", input: { startUrls: [{ url: "https://www.immobiliare.it/vendita-case/padova/" }], maxItems: 3 } },
  ];
  const out: any[] = [];
  for (const cfg of inputs) {
    const r = await fetch(`${APIFY}/acts/${encodeURIComponent(actor)}/runs?token=${encodeURIComponent(token)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg.input),
    });
    const j = await r.json();
    out.push({ label: cfg.label, status: r.status, response: j?.error ?? { run: j?.data?.id, actorStatus: j?.data?.status } });
  }
  return new Response(JSON.stringify(out, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
