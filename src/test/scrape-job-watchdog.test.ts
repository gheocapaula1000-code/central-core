import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_TIMEOUT_MS,
  WATCHDOG_ERROR,
  OPEN_STATUSES,
  isOpenStatus,
  isExpired,
  classifyPublicScrapeStatus,
  buildExpiredApifyPatch,
  buildExpiredFirecrawlPatch,
  buildExpiredCronLogPatch,
  selectExpiredJobs,
  expireStaleScrapeJobs,
  type WatchdogClient,
} from "../../supabase/functions/_shared/scrapeJobWatchdog.ts";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const NOW = new Date("2026-08-19T16:55:00.000Z");
const FRESH = "2026-08-19T15:00:00.000Z";
const STALE = "2026-08-19T02:25:04.718Z"; // 14.5h before NOW — live stuck run

function fakeSb() {
  const updates: Array<{ table: string; patch: Record<string, unknown>; filters: Record<string, unknown> }> = [];
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const builder: any = {
      in(col: string, vals: string[]) { filters[col] = vals; return builder; },
      lt(col: string, val: string) { filters[`${col}_lt`] = val; return builder; },
      eq(col: string, val: string) { filters[col] = val; return builder; },
      async select() {
        const n = table === "padova_apify_runs" ? 2
          : table === "padova_firecrawl_jobs" ? 1
          : 1;
        return { data: Array.from({ length: n }, (_, i) => ({ id: i })), error: null };
      },
    };
    return {
      update(patch: Record<string, unknown>) {
        updates.push({ table, patch, filters });
        return builder;
      },
    };
  };
  return { client: { from } as WatchdogClient, updates };
}

describe("scrape job watchdog — status and timeout", () => {
  it("treats running/started/in_progress/queued (any case) as open", () => {
    for (const s of ["running", "RUNNING", "started", "in_progress", "queued", "READY"]) {
      expect(isOpenStatus(s)).toBe(true);
    }
    expect(isOpenStatus("SUCCEEDED")).toBe(false);
    expect(isOpenStatus("FAILED")).toBe(false);
    expect(isOpenStatus(null)).toBe(false);
  });

  it("expires only after the timeout, never on a fresh start", () => {
    expect(isExpired(STALE, NOW)).toBe(true);
    expect(isExpired(FRESH, NOW)).toBe(false);
    expect(isExpired(NOW.toISOString(), NOW, DEFAULT_TIMEOUT_MS)).toBe(false);
    expect(isExpired(null, NOW)).toBe(false);
  });

  it("classifies a 14h+ running scrape as failed (live meta-stats case)", () => {
    expect(classifyPublicScrapeStatus("running", STALE, NOW)).toBe("failed");
    expect(classifyPublicScrapeStatus("RUNNING", STALE, NOW)).toBe("failed");
    expect(classifyPublicScrapeStatus("queued", STALE, NOW)).toBe("failed");
  });

  it("keeps a fresh running scrape as running so in-flight work is not killed", () => {
    expect(classifyPublicScrapeStatus("RUNNING", FRESH, NOW)).toBe("running");
    expect(classifyPublicScrapeStatus("started", FRESH, NOW)).toBe("running");
  });

  it("maps terminal statuses without using age", () => {
    expect(classifyPublicScrapeStatus("SUCCEEDED", STALE, NOW)).toBe("success");
    expect(classifyPublicScrapeStatus("done", STALE, NOW)).toBe("success");
    expect(classifyPublicScrapeStatus("FAILED", FRESH, NOW)).toBe("failed");
    expect(classifyPublicScrapeStatus("TIMED-OUT", FRESH, NOW)).toBe("failed");
    expect(classifyPublicScrapeStatus("ABORTED", FRESH, NOW)).toBe("failed");
    expect(classifyPublicScrapeStatus("mystery", FRESH, NOW)).toBe("unknown");
  });

  it("FAILED patch releases the lock with watchdog_timeout", () => {
    const apify = buildExpiredApifyPatch(NOW);
    expect(apify).toEqual({
      status: "FAILED",
      error: WATCHDOG_ERROR,
      finished_at: NOW.toISOString(),
    });
    const fc = buildExpiredFirecrawlPatch(NOW);
    expect(fc.status).toBe("failed");
    expect(fc.last_error).toBe(WATCHDOG_ERROR);
    expect(fc.finished_at).toBe(NOW.toISOString());
    expect(buildExpiredCronLogPatch(NOW).status).toBe("failure");
  });

  it("selectExpiredJobs keeps only open+stale rows", () => {
    const rows = [
      { id: "stale-running", status: "RUNNING", started_at: STALE },
      { id: "fresh-running", status: "RUNNING", started_at: FRESH },
      { id: "old-success", status: "SUCCEEDED", started_at: STALE },
      { id: "fc-stale", status: "running", updated_at: STALE },
    ];
    expect(selectExpiredJobs(rows, NOW).map((r) => r.id)).toEqual([
      "stale-running",
      "fc-stale",
    ]);
  });
});

describe("expireStaleScrapeJobs — mark failed and release locks", () => {
  it("updates apify, firecrawl, and started cron log rows older than the cutoff", async () => {
    const { client, updates } = fakeSb();
    const counts = await expireStaleScrapeJobs(client, NOW, DEFAULT_TIMEOUT_MS);
    expect(counts).toEqual({ apify: 2, firecrawl: 1, cron_log: 1 });

    const tables = updates.map((u) => u.table);
    expect(tables).toEqual([
      "padova_apify_runs",
      "padova_firecrawl_jobs",
      "cron_executions_log",
    ]);

    const cutoff = new Date(NOW.getTime() - DEFAULT_TIMEOUT_MS).toISOString();
    expect(updates[0].patch.status).toBe("FAILED");
    expect(updates[0].patch.error).toBe(WATCHDOG_ERROR);
    expect(updates[0].filters.status).toEqual([...OPEN_STATUSES]);
    expect(updates[0].filters.started_at_lt).toBe(cutoff);

    expect(updates[1].patch.status).toBe("failed");
    expect(updates[1].filters.updated_at_lt).toBe(cutoff);

    expect(updates[2].patch.status).toBe("failure");
    expect(updates[2].filters.status).toBe("started");
    expect(updates[2].filters.triggered_at_lt).toBe(cutoff);
  });

  it("after expire, an inflight skip query would not see the stale RUNNING lock", async () => {
    const rows = [
      { portal: "subito_collect", status: "RUNNING", started_at: STALE, run_id: "hung" },
      { portal: "subito_collect", status: "RUNNING", started_at: FRESH, run_id: "live" },
    ];
    const expired = new Set(selectExpiredJobs(rows, NOW).map((r) => r.run_id));
    const remainingLocks = rows.filter((r) => r.status === "RUNNING" && !expired.has(r.run_id));
    expect(expired.has("hung")).toBe(true);
    expect(remainingLocks.map((r) => r.run_id)).toEqual(["live"]);
  });
});

describe("wiring — collectors expire before skip, meta-stats uses classifier", () => {
  const collectPending = read("supabase/functions/padova-apify-collect-pending/index.ts");
  const subito = read("supabase/functions/padova-apify-subito-collect/index.ts");
  const immo = read("supabase/functions/padova-apify-immobiliare-collect/index.ts");
  const idea = read("supabase/functions/padova-apify-idealista-collect/index.ts");
  const casa = read("supabase/functions/padova-apify-casa-collect/index.ts");
  const firecrawl = read("supabase/functions/padova-firecrawl-detail-collect/index.ts");
  const meta = read("supabase/functions/public-padova-meta-stats/index.ts");
  const health = read("supabase/functions/core-cron-health-public/index.ts");

  it("collect-pending expires zombies even if Apify still says RUNNING", () => {
    expect(collectPending).toContain("expireStaleScrapeJobs");
    expect(collectPending).toContain("WATCHDOG_ERROR");
    expect(collectPending).toContain("WATCHDOG_UNRECOVERABLE");
    expect(collectPending).not.toMatch(/if \(d && d\.status === "RUNNING"\) continue/);
    expect(collectPending).toMatch(/\.eq\("error", WATCHDOG_ERROR\)/);
  });

  it("subito expires stale locks before the 6h already_running skip", () => {
    const expireIdx = subito.indexOf("await expireStaleScrapeJobs(sb)");
    const skipIdx = subito.indexOf("subito_run_already_running");
    expect(expireIdx).toBeGreaterThan(0);
    expect(skipIdx).toBeGreaterThan(expireIdx);
  });

  it("immobiliare, idealista, casa, and firecrawl call the watchdog", () => {
    expect(immo).toContain("expireStaleScrapeJobs");
    expect(idea).toContain("expireStaleScrapeJobs");
    expect(casa).toContain("expireStaleScrapeJobs");
    expect(firecrawl).toContain("expireStaleScrapeJobs");
  });

  it("public-padova-meta-stats classifies expired open jobs as failed", () => {
    expect(meta).toContain("classifyPublicScrapeStatus");
    expect(meta).not.toMatch(/lastRunStatus = "running"/);
  });

  it("core cron health lists the 15-minute watchdog", () => {
    expect(health).toContain('jobname: "expire-stale-scrape-jobs"');
    expect(health).toContain('"*/15 * * * *"');
  });
});

describe("SQL watchdog migration — timeout, mark failed, no secrets", () => {
  const dir = resolve(root, "supabase/migrations");
  const file = readdirSync(dir).find((f) => f.endsWith("_expire_stale_scrape_jobs.sql"));
  expect(file).toBeTruthy();
  const sql = read(`supabase/migrations/${file}`);

  it("creates expire_stale_scrape_jobs with a 4h default and 15-minute cron", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.expire_stale_scrape_jobs/);
    expect(sql).toMatch(/DEFAULT 14400/);
    expect(sql).toContain("'expire-stale-scrape-jobs'");
    expect(sql).toContain("'*/15 * * * *'");
    expect(sql).toContain("public.expire_stale_scrape_jobs()");
  });

  it("marks open apify + firecrawl + started cron rows failed", () => {
    expect(sql).toMatch(/status = 'FAILED'/);
    expect(sql).toMatch(/error = 'watchdog_timeout'/);
    expect(sql).toMatch(/last_error = 'watchdog_timeout'/);
    expect(sql).toMatch(/status = 'failure'/);
    expect(sql).toMatch(/lower\(status\) IN \('running', 'ready', 'started', 'in_progress', 'queued'\)/);
  });

  it("does not embed secrets, tokens, or vault material", () => {
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]+/);
    expect(sql).not.toMatch(/service_role_key|SERVICE_ROLE_KEY|CENTRAL_CORE_JOB_SECRET/i);
    expect(sql).not.toMatch(/vault\.decrypted_secrets/);
    expect(sql).not.toMatch(/Bearer /);
    expect(sql).not.toMatch(/net\.http_post/);
  });

  it("is service_role only", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.expire_stale_scrape_jobs/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.expire_stale_scrape_jobs\(integer\) TO service_role/);
  });
});
