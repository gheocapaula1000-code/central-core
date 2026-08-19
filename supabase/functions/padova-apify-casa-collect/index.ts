// padova-apify-casa-collect
// Collect casa.it listings Padova via actor Apify `benthepythondev~casa-it-scraper`.
// Solo modalità async_start: lancia il run via helper condiviso startApifyRun
// (guardia budget + insert padova_apify_runs), poi padova-apify-collect-pending
// completa il download del dataset e l'upsert su padova_collect_v2_items.
//
// Auth: x-job-secret === CENTRAL_CORE_JOB_SECRET.
// Body opzionale: { locations?: string[], max_items?: number }
// NB: il campo searchUrls dell'actor NON va usato (ramo difettoso). Solo locations.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getApifyToken, startApifyRun } from "../_shared/apify.ts";
import { expireStaleScrapeJobs } from "../_shared/scrapeJobWatchdog.ts";

const ACTOR_CASA = "benthepythondev~casa-it-scraper";

interface Body {
  locations?: string[];
  max_items?: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!jobSecret || req.headers.get("x-job-secret") !== jobSecret) {
    return new Response(
      JSON.stringify({ ok: false, error: "unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const token = getApifyToken();
  if (!token) {
    return new Response(
      JSON.stringify({ ok: false, error: "APIFY_API_TOKEN_missing" }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  await expireStaleScrapeJobs(sb);

  let body: Body = {};
  try { body = await req.json(); } catch { /* empty */ }

  const rawMax = Number(body.max_items ?? 300);
  const maxResults = Math.min(2000, Math.max(1, Number.isFinite(rawMax) ? Math.trunc(rawMax) : 300));
  const locations = Array.isArray(body.locations) && body.locations.length > 0
    ? body.locations : ["padova"];

  const input = {
    locations,
    channel: "sale" as const,
    maxResults,
  };

  const estUsd = Number((maxResults * 0.002).toFixed(2));

  const launched = await startApifyRun(
    ACTOR_CASA,
    input,
    { portal: "casa_collect", estUsd, costCapUsd: 1.00 },
  );

  if (!launched.started) {
    console.warn(`[apify] lancio saltato: ${launched.reason} portal=casa_collect`);
    return new Response(
      JSON.stringify({ ok: false, skipped: true, reason: launched.reason }),
      { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      async_start: true,
      run_id: launched.run_id,
      dataset_id: launched.dataset_id,
      locations,
      max_results: maxResults,
      note: "run avviato in async: collect-pending completerà ingest",
    }, null, 2),
    { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
