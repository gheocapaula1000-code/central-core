import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  APIFY_DATASET_HARD_CAP,
  APIFY_RUN_WEBHOOK_EVENTS,
  buildApifyRunWebhooks,
  clampMaxItemsPerRun,
  collectHttpStatus,
  collectPendingCount,
  collectPendingWebhookUrl,
  collectTickNeedsContinue,
  datasetPagePlan,
  datasetWasTruncated,
  drainLoopShouldContinue,
  encodeApifyWebhooksQuery,
  extractCollectRunIds,
  isApifyFailed,
  isApifyPending,
  isApifyRunWebhook,
  isApifySucceeded,
  shouldSkipZombieMark,
  waitForFinishSeconds,
} from "../../supabase/functions/_shared/apifyDrain";
import {
  APIFY_DATASET_PROCESSOR,
  drainBudgetRemaining,
  isLeaseExpired,
  lostLeaseIsRetryable,
  processorClaimLimit,
  safeEqual,
  shouldClaimAnotherWave,
} from "../../supabase/functions/_shared/scrapingLocks";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const CRON = read("supabase/functions/cron-apify-collect-pending/index.ts");
const COLLECT = read("supabase/functions/padova-apify-collect-pending/index.ts");
const WORKER = read("supabase/functions/scraping-worker/index.ts");
const PROCESSOR = read("supabase/functions/scraping-result-processor/index.ts");
const START = read("supabase/functions/_shared/apify.ts");
const MIGRATION = read(
  "supabase/migrations/20260819170100_portal_collect_pending_drain.sql",
);

describe("Apify webhook / run-id parsing", () => {
  it("reads explicit run_ids and ignores ERROR placeholders", () => {
    expect(extractCollectRunIds({ run_ids: ["abc12345", "ERROR", ""] })).toEqual([
      "abc12345",
    ]);
  });

  it("extracts Apify webhook resource and eventData ids", () => {
    const body = {
      eventType: "ACTOR.RUN.SUCCEEDED",
      eventData: { actorId: "x", actorRunId: "runFromEvent9" },
      resource: { id: "runFromResource8", status: "SUCCEEDED" },
    };
    expect(isApifyRunWebhook(body)).toBe(true);
    expect(extractCollectRunIds(body)).toEqual([
      "runFromResource8",
      "runFromEvent9",
    ]);
  });

  it("does not treat a normal collect body as a webhook", () => {
    expect(isApifyRunWebhook({ stale_minutes: 5, max_runs: 20 })).toBe(false);
  });

  it("builds ad-hoc webhooks without embedding the secret in the URL", () => {
    const hooks = buildApifyRunWebhooks({
      requestUrl: "https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/padova-apify-collect-pending",
      jobSecret: "test-job-secret",
    });
    expect(hooks).not.toBeNull();
    expect(hooks![0].eventTypes).toEqual([...APIFY_RUN_WEBHOOK_EVENTS]);
    expect(hooks![0].requestUrl).toContain("padova-apify-collect-pending");
    expect(hooks![0].requestUrl).not.toContain("test-job-secret");
    const encoded = encodeApifyWebhooksQuery(hooks!);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(hooks![0].headersTemplate)["x-job-secret"]).toBe("test-job-secret");
  });

  it("refuses non-https or wrong path webhook URLs", () => {
    expect(buildApifyRunWebhooks({
      requestUrl: "http://example.com/functions/v1/padova-apify-collect-pending",
      jobSecret: "x",
    })).toBeNull();
    expect(buildApifyRunWebhooks({
      requestUrl: collectPendingWebhookUrl("https://jpunnzgixcghuydstdlt.supabase.co").replace(
        "padova-apify-collect-pending",
        "other",
      ),
      jobSecret: "x",
    })).toBeNull();
  });
});

describe("Dataset drain paging", () => {
  it("pages up to the hard cap instead of a single 1500-item cut", () => {
    const pages = datasetPagePlan(9323);
    expect(pages[0]).toEqual({ offset: 0, limit: 1000 });
    expect(pages.at(-1)).toEqual({ offset: 9000, limit: 323 });
    expect(pages.reduce((sum, p) => sum + p.limit, 0)).toBe(9323);
    expect(clampMaxItemsPerRun(undefined)).toBe(APIFY_DATASET_HARD_CAP);
    expect(clampMaxItemsPerRun(1500)).toBe(1500);
    expect(datasetPagePlan(20000).reduce((sum, p) => sum + p.limit, 0)).toBe(
      APIFY_DATASET_HARD_CAP,
    );
  });

  it("detects truncation when the last page is full", () => {
    expect(datasetWasTruncated(10000, 10000, 1000, 1000)).toBe(true);
    expect(datasetWasTruncated(250, 10000, 250, 1000)).toBe(false);
  });
});

describe("Collect-pending drain status", () => {
  it("returns 202 when the only unfinished work is still_running", () => {
    const results = [
      { run_id: "a", status: "RUNNING", action: "still_running" },
      { run_id: "b", status: "SUCCEEDED", items: 12, created: 4, updated: 2 },
    ];
    const pending = collectPendingCount(results);
    expect(pending).toBe(1);
    expect(collectHttpStatus({ ok: false, pendingCount: pending, errorsCount: pending })).toBe(202);
    expect(collectTickNeedsContinue({ pendingCount: pending, httpStatus: 202, ok: false })).toBe(true);
  });

  it("returns 502 when ingest errors are present", () => {
    expect(collectHttpStatus({ ok: false, pendingCount: 0, errorsCount: 1 })).toBe(502);
  });

  it("waits for Apify inside the remaining budget", () => {
    expect(waitForFinishSeconds(45_000)).toBeGreaterThanOrEqual(40);
    expect(waitForFinishSeconds(500)).toBe(0);
  });

  it("keeps SUCCEEDED zombies selectable for ingest", () => {
    expect(shouldSkipZombieMark("SUCCEEDED")).toBe(true);
    expect(shouldSkipZombieMark("RUNNING")).toBe(true);
    expect(shouldSkipZombieMark("FAILED")).toBe(false);
    expect(isApifySucceeded("SUCCEEDED")).toBe(true);
    expect(isApifyPending("READY")).toBe(true);
    expect(isApifyFailed("TIMED-OUT")).toBe(true);
  });

  it("continues the cron drain loop while budget remains", () => {
    expect(drainLoopShouldContinue({
      startedAtMs: 0,
      nowMs: 10_000,
      wallBudgetMs: 110_000,
      needsContinue: true,
    })).toBe(true);
    expect(drainLoopShouldContinue({
      startedAtMs: 0,
      nowMs: 108_000,
      wallBudgetMs: 110_000,
      needsContinue: true,
    })).toBe(false);
  });
});

describe("Scraping worker / processor locks", () => {
  it("treats a missing or past lease as expired", () => {
    expect(isLeaseExpired(null)).toBe(true);
    expect(isLeaseExpired("2020-01-01T00:00:00Z", new Date("2026-08-19T12:00:00Z"))).toBe(true);
    expect(isLeaseExpired("2026-08-19T13:00:00Z", new Date("2026-08-19T12:00:00Z"))).toBe(false);
    expect(lostLeaseIsRetryable("lost_lease")).toBe(true);
  });

  it("claims a full wave in drain mode instead of min(limit, concurrency)", () => {
    expect(processorClaimLimit({ limit: 10, concurrency: 3, drain: false })).toBe(3);
    expect(processorClaimLimit({ limit: 10, concurrency: 3, drain: true })).toBe(10);
  });

  it("stops claiming when the wall budget is exhausted", () => {
    expect(shouldClaimAnotherWave({
      startedAtMs: 0, nowMs: 10_000, wallMs: 50_000, lastClaimed: 5,
    })).toBe(true);
    expect(shouldClaimAnotherWave({
      startedAtMs: 0, nowMs: 49_000, wallMs: 50_000, lastClaimed: 5,
    })).toBe(false);
    expect(drainBudgetRemaining({
      startedAtMs: 0, nowMs: 10_000, wallMs: 50_000,
    })).toBeGreaterThan(0);
  });

  it("compares worker tokens in constant time", () => {
    expect(safeEqual("abcd", "abcd")).toBe(true);
    expect(safeEqual("abcd", "abce")).toBe(false);
    expect(safeEqual("ab", "abcd")).toBe(false);
  });
});

describe("Wired into the four scoped functions", () => {
  it("cron wrapper drains collect-pending until pending is gone or budget ends", () => {
    expect(CRON).toContain("COLLECT_CRON_TIMEOUT_MS");
    expect(CRON).toContain("drainLoopShouldContinue");
    expect(CRON).toContain("drain_wait_seconds");
    expect(CRON).toContain("max_items_per_run");
    expect(CRON).not.toContain("COLLECT_TIMEOUT_MS = 60_000");
  });

  it("collect-pending pages datasets, honors webhooks, and does not ok still_running", () => {
    expect(COLLECT).toContain("extractCollectRunIds");
    expect(COLLECT).toContain("fetchDatasetPaged");
    expect(COLLECT).toContain("buildApifyRunWebhooks");
    expect(COLLECT).toContain("expireStaleScrapeJobs");
    expect(COLLECT).toContain("WATCHDOG_ERROR");
    expect(COLLECT).toContain("collectHttpStatus");
    expect(COLLECT).toContain("waitForFinishSeconds");
    expect(COLLECT).not.toContain("limit=${limit}");
  });

  it("scraping-worker reaps leases, attaches webhooks, and enqueues the Apify processor", () => {
    expect(WORKER).toContain("scraping_reap_expired");
    expect(WORKER).toContain("APIFY_DATASET_PROCESSOR");
    expect(WORKER).toContain("scraping_enqueue_processed");
    expect(WORKER).toContain("buildApifyRunWebhooks");
    expect(WORKER).toContain("shouldClaimAnotherWave");
    expect(WORKER).toContain("safeEqual");
  });

  it("result-processor drains waves, reaps processing leases, and ingests Apify datasets", () => {
    expect(PROCESSOR).toContain("scraping_processing_reap_expired");
    expect(PROCESSOR).toContain("padova_apify_dataset_v1");
    expect(PROCESSOR).toContain("shouldClaimAnotherWave");
    expect(PROCESSOR).toContain("processorClaimLimit");
    expect(PROCESSOR).toContain(APIFY_DATASET_PROCESSOR);
    expect(PROCESSOR).toContain("padova-apify-collect-pending");
  });

  it("startApifyRun registers collect-pending webhooks", () => {
    expect(START).toContain("buildApifyRunWebhooks");
    expect(START).toContain("encodeApifyWebhooksQuery");
    expect(START).toContain("webhooks=");
  });

  it("schedules a 15-minute drain cron on live Core", () => {
    expect(MIGRATION).toContain("portal-collect-pending-drain");
    expect(MIGRATION).toContain("'*/15 * * * *'");
    expect(MIGRATION).toContain("jpunnzgixcghuydstdlt");
    expect(MIGRATION).toContain("cron-apify-collect-pending");
    expect(MIGRATION).toContain("drain_wait_seconds");
    expect(MIGRATION).not.toMatch(/eyJ|service_role|APIFY_API_TOKEN|sk_live/);
  });
});
