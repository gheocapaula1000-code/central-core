// debug-apify-launch — temporary debug endpoint per lanciare un actor Apify on-demand
// gated da x-job-secret. Usato per testare URL Subito.
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { getApifyToken } from "../_shared/apify.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!jobSecret || req.headers.get("x-job-secret") !== jobSecret) {
    return new Response("unauth", { status: 401, headers: corsHeaders });
  }
  const body = await req.json().catch(() => ({}));
  const actor = body.actor ?? "azzouzana/subito-scraper-pro-by-search-url";
  const input = body.input ?? {};
  const token = getApifyToken();
  if (!token) return new Response("no token", { status: 503, headers: corsHeaders });

  // Lancia run sincrona con timeout (max 60s — il vero scraping ne richiede di più, ma lascia che torni info)
  const r = await fetch(`https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/runs?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const j = await r.json();
  console.log("DEBUG_APIFY_LAUNCH", JSON.stringify({ actor, input, started: j?.data }));
  return new Response(JSON.stringify(j, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
