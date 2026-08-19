// Public meta stats endpoint for civikoone.com preview.
// Exposes ingestion freshness + aggregate counts. No auth.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  publicHeaders,
  checkRateLimit,
  rateLimited,
} from "../_shared/public-stats-utils.ts";
import { classifyPublicScrapeStatus } from "../_shared/scrapeJobWatchdog.ts";

const VERSION = "v3.4.1";
const CONTRACT = "central-core-v3";

function computeNextCron6h(): string {
  // Matches cron '0 */6 * * *' (00:00, 06:00, 12:00, 18:00 UTC).
  const now = new Date();
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  const h = now.getUTCHours();
  const nextHour = (Math.floor(h / 6) + 1) * 6;
  if (nextHour >= 24) {
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(nextHour - 24);
  } else {
    next.setUTCHours(nextHour);
  }
  return next.toISOString();
}

function healthBucket(hrs: number | null): "fresh" | "ok" | "stale" | "critical" | "unknown" {
  // Refresh cadence: 1× daily (cron 0 1 * * * UTC). Thresholds tuned accordingly.
  if (hrs == null) return "unknown";
  if (hrs < 30) return "fresh";
  if (hrs < 50) return "ok";
  if (hrs < 100) return "stale";
  return "critical";
}

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

    // Last scrape run: MAX across the two scraper run tables.
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

    type RunCandidate = { at: string | null; status: string | null; clock: string | null };
    const apifyRow = apifyRes.data?.[0];
    const fcRow = firecrawlRes.data?.[0];
    const candidates: RunCandidate[] = [
      apifyRow
        ? {
          at: apifyRow.finished_at ?? apifyRow.started_at ?? null,
          status: apifyRow.status ?? null,
          clock: apifyRow.started_at ?? null,
        }
        : { at: null, status: null, clock: null },
      fcRow
        ? {
          at: fcRow.finished_at ?? fcRow.updated_at ?? null,
          status: fcRow.status ?? null,
          clock: fcRow.updated_at ?? null,
        }
        : { at: null, status: null, clock: null },
    ];
    const newest = candidates
      .filter((c) => c.at != null)
      .sort((a, b) => (b.at! > a.at! ? 1 : -1))[0] ?? null;

    const lastRunAt: string | null = newest?.at ?? null;
    // Open statuses older than the watchdog timeout are failed, not "running"
    // forever. That is what kept last_scrape_status stuck for 14+ hours.
    const lastRunStatus = classifyPublicScrapeStatus(
      newest?.status,
      newest?.clock,
      new Date(),
    );

    let freshnessHours: number | null = null;
    if (lastRunAt) {
      const diffMs = Date.now() - new Date(lastRunAt).getTime();
      freshnessHours = Math.round((diffMs / 3_600_000) * 10) / 10;
    }

    // Aggregate counts — queries copied from the other public-padova-* endpoints
    // to guarantee identical values.
    //  - total_listings_padova  ← public-padova-quartieri-stats.tot_annunci  (padova_listings count)
    //  - total_contendibili     ← public-padova-contendibili-stats.total    (padova_contendibili count)
    //  - total_privati          ← public-padova-privati-stats.total         (padova_listings WHERE tipo_lead='PRIVATO')
    //  - total_quartieri        ← public-padova-quartieri-stats.tot_quartieri_con_contendibili (distinct quartiere in padova_contendibili)
    const [listingsRes, contRes, privRes, quartRes] = await Promise.all([
      supabase.from("padova_listings").select("id", { count: "exact", head: true }),
      supabase.from("padova_contendibili").select("chiave_match", { count: "exact", head: true }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase.from("padova_listings") as any)
        .select("id", { count: "exact", head: true })
        .eq("tipo_lead", "PRIVATO")
        .eq("comune", "Padova"),
      supabase
        .from("padova_contendibili")
        .select("quartiere")
        .not("quartiere", "is", null),
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
      next_scheduled_run_at: computeNextCron6h(),
      total_listings_padova: listingsRes.count ?? 0,
      total_contendibili: contRes.count ?? 0,
      total_privati: privRes.count ?? 0,
      total_quartieri: quartieriUnique,
      data_freshness_hours: freshnessHours,
      health_bucket: healthBucket(freshnessHours),
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
