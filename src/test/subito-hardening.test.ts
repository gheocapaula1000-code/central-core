import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const WRAPPER = readFileSync("supabase/functions/cron-apify-subito-nightly/index.ts", "utf8");
const COLLECT = readFileSync("supabase/functions/padova-apify-subito-collect/index.ts", "utf8");
const MIGRATION_PATH = "docs/pending-migrations/20260723200000_cron_subito_weekly_job_secret_header.sql";
const MIGRATION = readFileSync(MIGRATION_PATH, "utf8");
const COMPENSATING_PATH = "docs/pending-migrations/20260723210000_cron_subito_weekly_restore_body_apikey.sql";
const COMPENSATING = readFileSync(COMPENSATING_PATH, "utf8");

describe("cron-apify-subito-nightly wrapper gate", () => {
  it("requires x-job-secret header matching CENTRAL_CORE_JOB_SECRET before fetch", () => {
    const gateIdx = WRAPPER.indexOf('req.headers.get("x-job-secret")');
    const fetchIdx = WRAPPER.indexOf("fetch(`${base}/functions/v1/cron-apify-subito-nightly".replace("cron-apify-subito-nightly", "padova-apify-subito-collect"));
    expect(gateIdx).toBeGreaterThan(0);
    expect(fetchIdx).toBeGreaterThan(gateIdx);
    expect(WRAPPER).toMatch(/status:\s*401/);
    expect(WRAPPER).toMatch(/status:\s*500/);
  });

  it("keeps forwarded payload shape unchanged (async_start + max_items 300 default)", () => {
    expect(WRAPPER).toMatch(/async_start:\s*true,\s*max_items:\s*300/);
  });
});

describe("padova-apify-subito-collect hardening", () => {
  it("imports canSpendApify and recordApifySpend from apifyBudget", () => {
    expect(COLLECT).toMatch(/from "\.\.\/_shared\/apifyBudget\.ts"/);
    expect(COLLECT).toMatch(/canSpendApify/);
    expect(COLLECT).toMatch(/recordApifySpend/);
  });

  it("clamps max_items into 1..300", () => {
    expect(COLLECT).toMatch(/Math\.min\(300,\s*Math\.max\(1/);
  });

  it("estimates cost as max_items * 5 / 1000 (300 -> 1.50)", () => {
    expect(COLLECT).toMatch(/maxItems \* 5\) \/ 1000/);
    // sanity: numeric check
    expect(Number(((300 * 5) / 1000).toFixed(3))).toBe(1.5);
  });

  it("guards duplicate RUNNING run in last 6h with skipped_reason", () => {
    expect(COLLECT).toMatch(/subito_run_already_running/);
    expect(COLLECT).toMatch(/6 \* 3600 \* 1000/);
    expect(COLLECT).toMatch(/\.eq\("status", "RUNNING"\)/);
  });

  it("fail-closes with APIFY_DEDUP_CHECK_FAILED (503) when dedup query errors, before budget/startRun/insert", () => {
    // destructure error from dedup query
    expect(COLLECT).toMatch(/data:\s*inflight,\s*error:\s*inflightErr/);
    // returns 503 with sanitized code
    expect(COLLECT).toMatch(/APIFY_DEDUP_CHECK_FAILED/);
    expect(COLLECT).toMatch(/status:\s*503/);
    // ordering: dedup-error branch precedes budget/start/insert
    const errIdx = COLLECT.indexOf("APIFY_DEDUP_CHECK_FAILED");
    const budgetIdx = COLLECT.indexOf("canSpendApify(estCostUsd)");
    const startIdx = COLLECT.indexOf("const started = await startRun(");
    const recordIdx = COLLECT.indexOf("recordApifySpend(estCostUsd");
    const insertIdx = COLLECT.indexOf('.from("padova_apify_runs").insert(');
    expect(errIdx).toBeGreaterThan(0);
    expect(budgetIdx).toBeGreaterThan(errIdx);
    expect(startIdx).toBeGreaterThan(errIdx);
    expect(recordIdx).toBeGreaterThan(errIdx);
    expect(insertIdx).toBeGreaterThan(errIdx);
  });

  it("returns APIFY_BUDGET_BLOCKED without calling startRun when budget denied", () => {
    const budgetIdx = COLLECT.indexOf("APIFY_BUDGET_BLOCKED");
    const startIdx = COLLECT.indexOf("const started = await startRun(");
    expect(budgetIdx).toBeGreaterThan(0);
    expect(startIdx).toBeGreaterThan(budgetIdx);
  });

  it("records spend only AFTER successful startRun", () => {
    const startIdx = COLLECT.indexOf("const started = await startRun(");
    const recordIdx = COLLECT.indexOf("recordApifySpend(estCostUsd");
    expect(startIdx).toBeGreaterThan(0);
    expect(recordIdx).toBeGreaterThan(startIdx);
  });

  it("persists dynamic cost_cap_usd (not hardcoded 0.05)", () => {
    expect(COLLECT).toMatch(/cost_cap_usd:\s*estCostUsd/);
    expect(COLLECT).not.toMatch(/cost_cap_usd:\s*0\.05/);
  });

  it("does not modify actor id, startUrls key, or maxResultItems key", () => {
    expect(COLLECT).toMatch(/ACTOR = "emastra~subito-it-immobili"/);
    expect(COLLECT).toMatch(/startUrls: searchUrls/);
    expect(COLLECT).toMatch(/maxResultItems: maxItems/);
  });
});

describe("cron migration (pending)", () => {
  it("has expected SHA-256", () => {
    const sha = createHash("sha256").update(readFileSync(MIGRATION_PATH)).digest("hex");
    expect(sha).toBe("be5e164112744d90b951583fb0d34c7d04d1878d9cadc6006a0f92037c96cde3");
  });

  it("does not hardcode the secret value", () => {
    expect(MIGRATION).not.toMatch(/central_core_job_secret\s*=\s*['"][^'"]+['"]/i);
    // Only references the vault name, never a literal secret value
    expect(MIGRATION).toMatch(/vault\.decrypted_secrets/);
    expect(MIGRATION).toMatch(/name = 'central_core_job_secret'/);
  });

  it("preserves weekly schedule and job name (looked up by jobname)", () => {
    expect(MIGRATION).toMatch(/jobname = 'apify-subito-weekly'/);
    // does not alter schedule
    expect(MIGRATION).not.toMatch(/schedule\s*:=/i);
    // fail-fast if secret missing
    expect(MIGRATION).toMatch(/aborting cron update/);
  });

  it("does not change URL or actor", () => {
    expect(MIGRATION).toMatch(/cron-apify-subito-nightly/);
    expect(MIGRATION).not.toMatch(/emastra/);
  });
});
