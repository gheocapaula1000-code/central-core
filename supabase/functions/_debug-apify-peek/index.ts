// _debug-apify-peek — temporary debug endpoint (job-secret gated)
// Ritorna stato run + sample dataset items per indagine.
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { getApifyToken } from "../_shared/apify.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!jobSecret || req.headers.get("x-job-secret") !== jobSecret) {
    return new Response("unauth", { status: 401, headers: corsHeaders });
  }
  const url = new URL(req.url);
  const runId = url.searchParams.get("run_id") ?? "";
  const datasetId = url.searchParams.get("dataset_id") ?? "";
  const token = getApifyToken();
  if (!token) return new Response("no token", { status: 503, headers: corsHeaders });

  const out: Record<string, unknown> = {};
  if (runId) {
    const r = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
    const j = await r.json();
    const d = j?.data ?? {};
    out.run = {
      id: d.id, status: d.status, startedAt: d.startedAt, finishedAt: d.finishedAt,
      usageTotalUsd: d.usageTotalUsd, stats: d.stats, exitCode: d.exitCode,
      buildNumber: d.buildNumber, defaultDatasetId: d.defaultDatasetId,
    };
    if (!datasetId && d.defaultDatasetId) {
      const r2 = await fetch(`https://api.apify.com/v2/datasets/${d.defaultDatasetId}/items?clean=true&limit=3&token=${encodeURIComponent(token)}`);
      out.sample = await r2.json();
      out.sample_dataset_id = d.defaultDatasetId;
    }
  }
  if (datasetId) {
    const r2 = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&limit=3&token=${encodeURIComponent(token)}`);
    out.sample = await r2.json();
    const r3 = await fetch(`https://api.apify.com/v2/datasets/${datasetId}?token=${encodeURIComponent(token)}`);
    out.dataset_meta = (await r3.json())?.data;
  }
  return new Response(JSON.stringify(out, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
