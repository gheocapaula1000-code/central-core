// Public meta stats endpoint for civikoone.com preview.
// Exposes ingestion freshness + aggregate counts. No auth.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  pickAllowedOrigin,
  publicHeaders,
  checkRateLimit,
  rateLimited,
} from "../_shared/public-stats-utils.ts";

const VERSION = "v3.4.0";
const CONTRACT = "central-core-v3";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: publicHeaders(req) });
  }
  if (req.method !== "GET") {
    return new Response(
      JSON.stringify({ ok: false, error: { code: "METHOD_NOT_ALLOWED" } }),
      { status: 405, headers: { ...publicHeaders(req), Allow: "GET, OPTIONS" } },
    );
  }

  const rl = checkRateLimit(req, "public-padova-meta-stats");
  if (!rl.ok) return rateLimited(req, rl.retryAfter);

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Last scrape run: take MAX across the two scraper run tables.
    const [apifyRes, firecrawlRes] = await Promise.all([
      supabase
        .from("padova_apify_runs")
        .select("status, started_at, finished_at")
        .order("started_at", { ascending: false })
        .limit(1),
      supabase
        .from("padova_firecrawl_jobs")
        .select("status, updated_at, finished_at")
        .order("updated_at", { ascending: false })
        .limit(1),
    ]);

    type RunCandidate = { at: string | null; status: string | null };
    const apifyRow = apifyRes.data?.[0];
    const fcRow = firecrawlRes.data?.[0];
    const candidates: RunCandidate[] = [
      apifyRow
        ? { at: apifyRow.finished_at ?? apifyRow.started_at ?? null, status: apifyRow.status ?? null }
        : { at: null, status: null },
      fcRow
        ? { at: fcRow.finished_at ?? fcRow.updated_at ?? null, status: fcRow.status ?? null }
        : { at: null, status: null },
    ];
    const newest = candidates
      .filter((c) => c.at != null)
      .sort((a, b) => (b.at! > a.at! ? 1 : -1))[0] ?? null;

    const lastRunAt: string | null = newest?.at ?? null;
    let lastRunStatus: "success" | "failed" | "running" | "unknown" = "unknown";
    if (newest?.status) {
      const s = newest.status.toLowerCase();
      if (["done", "success", "succeeded", "completed", "ok"].includes(s)) lastRunStatus = "success";
      else if (["failed", "error", "errored", "stopped_spend_cap"].includes(s)) lastRunStatus = "failed";
      else if (["running", "started", "in_progress", "queued"].includes(s)) lastRunStatus = "running";
    }

    let freshnessHours: number | null = null;
    if (lastRunAt) {
      const diffMs = Date.now() - new Date(lastRunAt).getTime();
      freshnessHours = Math.round((diffMs / 3_600_000) * 10) / 10;
    }

    // Aggregate counts in parallel.
    const [listingsRes, contRes, privRes, quartRes] = await Promise.all([
      supabase.from("padova_collect_v2_items").select("id", { count: "exact", head: true }),
      supabase.from("padova_contendibili").select("id", { count: "exact", head: true }),
      supabase
        .from("padova_collect_v2_items")
        .select("id", { count: "exact", head: true })
        .is("agency", null),
      supabase.from("padova_collect_v2_items").select("quartiere").not("quartiere", "is", null),
    ]);

    const quartieriUnique = quartRes.data
      ? new Set(
          quartRes.data
            .map((r: { quartiere: string | null }) => r.quartiere)
            .filter((q): q is string => !!q),
        ).size
      : 0;

    const body = {
      ok: true,
      contract: CONTRACT,
      version: VERSION,
      last_scrape_run_at: lastRunAt,
      last_scrape_status: lastRunStatus,
      next_scheduled_run_at: null as string | null, // cron expression not centrally exposed
      total_listings_padova: listingsRes.count ?? 0,
      total_contendibili: contRes.count ?? 0,
      total_privati: privRes.count ?? 0,
      total_quartieri: quartieriUnique,
      data_freshness_hours: freshnessHours,
      updated_at: new Date().toISOString(),
    };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: publicHeaders(req),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "internal error";
    return new Response(
      JSON.stringify({ ok: false, error: { code: "INTERNAL", message: msg } }),
      { status: 500, headers: publicHeaders(req) },
    );
  }
});

// pickAllowedOrigin import kept for tree-shaking parity with other public endpoints
void pickAllowedOrigin;
