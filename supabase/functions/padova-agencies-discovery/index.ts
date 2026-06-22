// padova-agencies-discovery
// Central Core — daily discovery of NEW listing URLs from idealista + immobiliare
// search-result pages (sorted by most-recent), so the existing refresh-by-url
// pipeline (padova-agencies-pipeline) finds them already in padova_listings.
//
// Schedule: 01:30 UTC daily, BEFORE the 02:00 UTC refresh.
//
// Actors:
//   - idealista:   dz_omar/idealista-scraper-api   (search-by-url mode)
//   - immobiliare: azzouzana/immobiliare-it-listing-page-scraper-by-search-url
//
// Rules:
//   - hard cap 200 NEW URLs imported per portal per run
//   - budget check via agency_pipeline_budget_check (shares the monthly $215 cap)
//   - structured console.log start/end per portal
//   - writes one pipeline_runs row with mode='discovery' and per_source_stats
//   - alerts (console.error + cron_executions_log row) when a portal returns
//     0 NEW urls for 3 consecutive discovery runs
//
// Auth: x-job-secret == CENTRAL_CORE_JOB_SECRET.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getApifyToken } from "../_shared/apify.ts";

const APIFY = "https://api.apify.com/v2";
const CAP_USD = Number(Deno.env.get("AGENCY_PIPELINE_MONTHLY_CAP_USD") ?? "215");

const MAX_NEW_PER_PORTAL = 200;
const POLL_TIMEOUT_MS = 110_000;   // edge function ceiling ~150s, leave headroom
const POLL_INTERVAL_MS = 4_000;

const IDEALISTA_SEARCH_URL =
  "https://www.idealista.it/vendita-case/padova-padova/con-ultime-settimane_1/";
const IMMOBILIARE_SEARCH_URL =
  "https://www.immobiliare.it/vendita-case/padova/?criterio=dataModifica&ordine=desc";

function sb(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

async function startActor(actor: string, input: Record<string, unknown>, token: string) {
  const r = await fetch(`${APIFY}/acts/${encodeURIComponent(actor)}/runs?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const txt = await r.text();
  if (!r.ok) return { ok: false as const, error: `apify_${r.status}: ${txt.slice(0, 300)}` };
  let j: Record<string, unknown> = {};
  try { j = JSON.parse(txt); } catch { /* */ }
  const d = (j as { data?: { id?: string; defaultDatasetId?: string; status?: string } }).data ?? {};
  return { ok: true as const, run_id: d.id!, dataset_id: d.defaultDatasetId, status: d.status };
}

async function getRun(runId: string, token: string) {
  const r = await fetch(`${APIFY}/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
  if (!r.ok) { await r.body?.cancel(); return null; }
  const j = await r.json();
  return j?.data ?? null;
}

async function fetchDataset(datasetId: string, token: string, limit = 1000): Promise<Record<string, unknown>[]> {
  const r = await fetch(`${APIFY}/datasets/${datasetId}/items?clean=true&limit=${limit}&token=${encodeURIComponent(token)}`);
  if (!r.ok) { await r.body?.cancel(); return []; }
  const j = await r.json();
  return Array.isArray(j) ? j as Record<string, unknown>[] : [];
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

function extractUrl(item: Record<string, unknown>, hostMatch: RegExp): string | null {
  for (const k of ["url", "originalUrl", "detailWebLink", "link", "permalink"]) {
    const v = item[k];
    if (typeof v === "string" && hostMatch.test(v)) return v.split("?")[0];
  }
  // immobiliare: sometimes nested in {realEstate:{contract,...}, properties:[{...}]}
  const id = item.id ?? item.realEstateId ?? item.propertyId;
  if (id && hostMatch.source.includes("immobiliare")) {
    return `https://www.immobiliare.it/annunci/${id}/`;
  }
  return null;
}

function isoMaybe(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof v === "number") {
    const d = new Date(v < 1e12 ? v * 1000 : v);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  return null;
}

interface DiscoveryResult {
  portal: string;
  actor: string;
  ok: boolean;
  error?: string;
  run_id?: string;
  found: number;
  new: number;
  dup: number;
  imported: number;
  cost_usd: number;
  status?: string;
}

async function discoverPortal(
  client: SupabaseClient,
  token: string,
  portal: "idealista" | "immobiliare",
): Promise<DiscoveryResult> {
  const tsStart = new Date().toISOString();
  let actor = "";
  let input: Record<string, unknown> = {};
  let hostRe: RegExp;
  let fonte = portal;

  if (portal === "idealista") {
    actor = "dz_omar/idealista-scraper-api";
    input = {
      Search_urls: [{ url: IDEALISTA_SEARCH_URL }],
      desiredResults: MAX_NEW_PER_PORTAL * 2,
    };
    hostRe = /idealista\.it\/(?:immobile|inserzione|annuncio)/i;
  } else {
    actor = "azzouzana/immobiliare-it-listing-page-scraper-by-search-url";
    input = {
      searchUrls: [{ url: IMMOBILIARE_SEARCH_URL }],
      maxItems: MAX_NEW_PER_PORTAL * 2,
    };
    hostRe = /immobiliare\.it\/(?:annunci|nuove_costruzioni)/i;
  }

  console.log(JSON.stringify({
    evt: "discovery_start", ts: tsStart, portal, actor, cap: MAX_NEW_PER_PORTAL,
  }));

  const launched = await startActor(actor, input, token);
  if (!launched.ok) {
    console.error(JSON.stringify({ evt: "discovery_launch_failed", portal, error: launched.error }));
    return { portal, actor, ok: false, error: launched.error, found: 0, new: 0, dup: 0, imported: 0, cost_usd: 0 };
  }

  await client.from("padova_apify_runs").insert({
    portal: `${portal}_discovery`, actor_id: actor,
    run_id: launched.run_id, dataset_id: launched.dataset_id ?? null,
    status: launched.status ?? "RUNNING", cost_cap_usd: 0.5,
  });

  const final = await pollUntilDone(launched.run_id, token);
  const status = (final?.status as string) ?? "TIMEOUT";
  const cost = Number(final?.usageTotalUsd ?? 0);
  const datasetId = (final?.defaultDatasetId as string) ?? launched.dataset_id;

  if (status !== "SUCCEEDED") {
    await client.from("padova_apify_runs").update({
      status, cost_usd: cost, finished_at: new Date().toISOString(),
      error: `discovery_${status}`,
    }).eq("run_id", launched.run_id);
    console.error(JSON.stringify({ evt: "discovery_actor_not_succeeded", portal, status, cost }));
    return { portal, actor, ok: false, error: status, run_id: launched.run_id, found: 0, new: 0, dup: 0, imported: 0, cost_usd: cost, status };
  }

  const items = datasetId ? await fetchDataset(datasetId, token, 1000) : [];
  // Extract URLs preserving order (most-recent first thanks to sort=dataModifica desc)
  const seen = new Set<string>();
  const candidates: { url: string; published_at_portal: string | null; raw: Record<string, unknown> }[] = [];
  for (const it of items) {
    const u = extractUrl(it, hostRe);
    if (!u || seen.has(u)) continue;
    seen.add(u);
    const pub = isoMaybe((it as Record<string, unknown>).publishedAt ?? (it as Record<string, unknown>).date ?? (it as Record<string, unknown>).createdAt);
    candidates.push({ url: u, published_at_portal: pub, raw: it });
  }

  // Dedup against padova_listings
  let dup = 0, newCount = 0, imported = 0;
  const toInsert: Record<string, unknown>[] = [];
  const urls = candidates.map((c) => c.url);
  const existing = new Set<string>();
  // chunk in 500 to keep .in() URL length reasonable
  for (let i = 0; i < urls.length; i += 500) {
    const chunk = urls.slice(i, i + 500);
    const { data } = await client
      .from("padova_listings")
      .select("url")
      .eq("fonte", fonte)
      .in("url", chunk);
    for (const r of (data ?? []) as { url: string }[]) existing.add(r.url);
  }
  const nowIso = new Date().toISOString();
  for (const c of candidates) {
    if (existing.has(c.url)) { dup++; continue; }
    if (newCount >= MAX_NEW_PER_PORTAL) break;
    newCount++;
    toInsert.push({
      fonte,
      url: c.url,
      published_at_portal: c.published_at_portal,
      last_seen_at: nowIso,
      imported_at: nowIso,
      raw_json: { discovered_via: "discovery_cron", source_search_url: portal === "idealista" ? IDEALISTA_SEARCH_URL : IMMOBILIARE_SEARCH_URL, item: c.raw },
    });
  }
  for (let i = 0; i < toInsert.length; i += 200) {
    const { error, count } = await client.from("padova_listings").insert(toInsert.slice(i, i + 200), { count: "exact" });
    if (error) {
      console.error(JSON.stringify({ evt: "discovery_insert_error", portal, error: error.message }));
    } else {
      imported += count ?? toInsert.slice(i, i + 200).length;
    }
  }

  await client.from("padova_apify_runs").update({
    status, cost_usd: cost, items_count: items.length, imported,
    finished_at: new Date().toISOString(),
  }).eq("run_id", launched.run_id);

  console.log(JSON.stringify({
    evt: "discovery_end", ts: new Date().toISOString(), portal,
    found: candidates.length, new: newCount, dup, imported, cost_usd: cost, run_id: launched.run_id,
  }));

  return { portal, actor, ok: true, run_id: launched.run_id, found: candidates.length, new: newCount, dup, imported, cost_usd: cost, status };
}

async function checkAlertStreak(client: SupabaseClient, portal: string, currentNew: number) {
  // Look at last 2 discovery runs (we'll be the 3rd if currentNew===0)
  if (currentNew > 0) return null;
  const { data } = await client
    .from("pipeline_runs")
    .select("id, started_at, per_source_stats")
    .eq("pipeline_name", "padova-agencies-discovery")
    .eq("status", "succeeded")
    .order("started_at", { ascending: false })
    .limit(2);
  const prevZero = (data ?? []).filter((r) => {
    const s = (r as { per_source_stats: Record<string, { new?: number }> | null }).per_source_stats;
    const n = s?.[portal]?.new;
    return n === 0;
  }).length;
  if (prevZero >= 2) {
    const msg = `discovery_zero_new_streak portal=${portal} consecutive_runs=${prevZero + 1}`;
    console.error(JSON.stringify({ evt: "discovery_alert", portal, msg }));
    await client.from("cron_executions_log").insert({
      job_name: "padova-agencies-discovery",
      status: "alert",
      error_message: msg,
      triggered_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });
    return msg;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!jobSecret || req.headers.get("x-job-secret") !== jobSecret) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const token = getApifyToken();
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: "APIFY_API_TOKEN_missing" }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const url = new URL(req.url);
  const trigger = url.searchParams.get("trigger") ?? "cron";
  const onlyParam = url.searchParams.get("portal"); // "idealista" | "immobiliare" | null

  const client = sb();

  // Budget gate (shared monthly cap)
  const { data: budget } = await client.rpc("agency_pipeline_budget_check", { p_cap_usd: CAP_USD });
  const b = (budget ?? {}) as { ok?: boolean; spent_usd?: number; cap_usd?: number };
  if (!b.ok) {
    return new Response(JSON.stringify({ ok: false, error: "monthly_cap_reached", budget: b }, null, 2),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const { data: runRow } = await client.from("pipeline_runs").insert({
    pipeline_name: "padova-agencies-discovery", mode: "discovery", trigger_source: trigger,
    status: "running",
    monthly_spent_usd_at_start: b.spent_usd, monthly_cap_usd: b.cap_usd,
  }).select("id").single();
  const runDbId = (runRow as { id: number } | null)?.id ?? null;

  const portals = onlyParam ? [onlyParam] : ["idealista", "immobiliare"];
  const results: DiscoveryResult[] = [];
  const alerts: string[] = [];
  let totalCost = 0;

  for (const p of portals) {
    if (p !== "idealista" && p !== "immobiliare") continue;
    const res = await discoverPortal(client, token, p);
    results.push(res);
    totalCost += res.cost_usd;
    const alert = await checkAlertStreak(client, p, res.new);
    if (alert) alerts.push(alert);
  }

  const perSource: Record<string, unknown> = {};
  for (const r of results) {
    perSource[r.portal] = { found: r.found, new: r.new, dup: r.dup, imported: r.imported, cost_usd: r.cost_usd, ok: r.ok, status: r.status, error: r.error };
  }

  if (runDbId != null) {
    await client.from("pipeline_runs").update({
      status: "succeeded",
      finished_at: new Date().toISOString(),
      sources: results.map((r) => r.portal),
      cost_usd: totalCost,
      per_source_stats: perSource,
      warnings: alerts,
    }).eq("id", runDbId);
  }

  return new Response(JSON.stringify({
    ok: true, pipeline_run_id: runDbId, results, alerts, total_cost_usd: totalCost,
  }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
