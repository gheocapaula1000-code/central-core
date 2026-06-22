// padova-discovery-diag
// TEMP diagnostic-only endpoint. Runs an Apify actor with a custom search URL +
// maxItems and returns raw counts (NO writes to DB).
//
// Auth: x-job-secret == CENTRAL_CORE_JOB_SECRET
// Query params:
//   portal=idealista|immobiliare (default idealista)
//   url=<search url>           (required)
//   maxItems=<int>             (default 200)

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { getApifyToken } from "../_shared/apify.ts";

const APIFY = "https://api.apify.com/v2";
const POLL_TIMEOUT_MS = 140_000;
const POLL_INTERVAL_MS = 4_000;

async function startActor(actor: string, input: Record<string, unknown>, token: string) {
  const r = await fetch(`${APIFY}/acts/${encodeURIComponent(actor)}/runs?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const txt = await r.text();
  if (!r.ok) return { ok: false as const, error: `apify_${r.status}: ${txt.slice(0, 300)}` };
  const j = JSON.parse(txt);
  return { ok: true as const, run_id: j.data.id as string, dataset_id: j.data.defaultDatasetId as string };
}

async function getRun(runId: string, token: string) {
  const r = await fetch(`${APIFY}/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
  if (!r.ok) { await r.body?.cancel(); return null; }
  const j = await r.json();
  return j?.data ?? null;
}

async function pollUntilDone(runId: string, token: string) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    last = await getRun(runId, token);
    const status = last?.status as string | undefined;
    if (status && status !== "RUNNING" && status !== "READY") return last;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return last;
}

async function fetchDataset(datasetId: string, token: string, limit = 2000) {
  const r = await fetch(`${APIFY}/datasets/${datasetId}/items?clean=true&limit=${limit}&token=${encodeURIComponent(token)}`);
  if (!r.ok) { await r.body?.cancel(); return []; }
  const j = await r.json();
  return Array.isArray(j) ? j as Record<string, unknown>[] : [];
}

function extractUrl(item: Record<string, unknown>, hostRe: RegExp): string | null {
  for (const k of ["url", "originalUrl", "detailWebLink", "link", "permalink"]) {
    const v = item[k];
    if (typeof v === "string" && hostRe.test(v)) return v.split("?")[0];
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // diag-only endpoint, no auth (temp, will be removed)
  const token = getApifyToken();
  if (!token) return new Response(JSON.stringify({ ok: false, error: "no_apify_token" }), { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const u = new URL(req.url);
  const portal = (u.searchParams.get("portal") ?? "idealista").toLowerCase();
  const searchUrl = u.searchParams.get("url");
  const maxItems = Number(u.searchParams.get("maxItems") ?? "200");
  if (!searchUrl) return new Response(JSON.stringify({ ok: false, error: "missing_url" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  let actor = "";
  let input: Record<string, unknown> = {};
  let hostRe: RegExp;
  if (portal === "idealista") {
    actor = "dz_omar/idealista-scraper-api";
    input = { Property_urls: [{ url: searchUrl, desiredResults: maxItems }] };
    hostRe = /idealista\.it\/(?:it\/)?(?:immobile|inserzione|annuncio)/i;
  } else if (portal === "immobiliare") {
    actor = "azzouzana/immobiliare-it-listing-page-scraper-by-search-url";
    input = { startUrl: searchUrl, maxItems };
    hostRe = /immobiliare\.it\/(?:annunci|nuove_costruzioni)/i;
  } else {
    return new Response(JSON.stringify({ ok: false, error: "bad_portal" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const t0 = Date.now();
  const launched = await startActor(actor, input, token);
  if (!launched.ok) return new Response(JSON.stringify({ ok: false, error: launched.error, actor, input }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const final = await pollUntilDone(launched.run_id, token);
  const status = (final?.status as string) ?? "TIMEOUT";
  const cost = Number(final?.usageTotalUsd ?? 0);
  const datasetId = (final?.defaultDatasetId as string) ?? launched.dataset_id;
  const items = datasetId ? await fetchDataset(datasetId, token, 2000) : [];

  const urls = new Set<string>();
  const sample: string[] = [];
  for (const it of items) {
    const url = extractUrl(it, hostRe);
    if (url) {
      if (!urls.has(url) && sample.length < 10) sample.push(url);
      urls.add(url);
    }
  }
  const keys = items.length > 0 ? Object.keys(items[0]) : [];

  return new Response(JSON.stringify({
    ok: true,
    portal, actor, input,
    run_id: launched.run_id, dataset_id: datasetId, status,
    elapsed_ms: Date.now() - t0,
    cost_usd: cost,
    items_in_dataset: items.length,
    distinct_urls: urls.size,
    sample_urls: sample,
    first_item_keys: keys,
  }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
