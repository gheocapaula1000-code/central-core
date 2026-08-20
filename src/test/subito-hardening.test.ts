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
  it("requires job-secret auth before fetch", () => {
    const gateIdx = WRAPPER.indexOf("isJobSecretAuthorized");
    const fetchIdx = WRAPPER.indexOf("await fetch(TARGET");
    expect(gateIdx).toBeGreaterThan(0);
    expect(fetchIdx).toBeGreaterThan(gateIdx);
    expect(WRAPPER).toMatch(/jobAuthFailure/);
  });

  it("skips Apify full unless force_apify; Firecrawl soft is the live path", () => {
    expect(WRAPPER).toContain("firecrawl_soft_is_primary");
    expect(WRAPPER).toContain("force_apify");
    expect(WRAPPER).toMatch(/async_start:\s*true/);
    expect(WRAPPER).toMatch(/max_items:\s*40/);
  });
});

describe("padova-apify-subito-collect hardening", () => {
  it("launches via startApifyRun (budget + padova_apify_runs live in _shared/apify)", () => {
    expect(COLLECT).toMatch(/from "\.\.\/_shared\/apify\.ts"/);
    expect(COLLECT).toMatch(/startApifyRun/);
    expect(COLLECT).toMatch(/buildSubitoActorInput/);
  });

  it("clamps max_items and refuses Apify full before start", () => {
    expect(COLLECT).toMatch(/clampSubitoMaxItems/);
    expect(COLLECT).toContain("refuseSubitoApifyFull");
    expect(COLLECT).toContain("clampSubitoWaitSeconds");
    expect(COLLECT).toContain("firecrawl_soft_is_primary");
  });

  it("estimates cost as max_items * 5 / 1000 (300 -> 1.50)", () => {
    expect(COLLECT).toMatch(/estimateSubitoCostUsd/);
    expect(Number(((300 * 5) / 1000).toFixed(3))).toBe(1.5);
  });

  it("guards duplicate RUNNING run in last 6h with skipped_reason", () => {
    expect(COLLECT).toMatch(/subito_run_already_running/);
    expect(COLLECT).toMatch(/6 \* 3600 \* 1000/);
    expect(COLLECT).toMatch(/\.eq\("status", "RUNNING"\)/);
  });

  it("fail-closes with APIFY_DEDUP_CHECK_FAILED (503) when dedup query errors, before startApifyRun", () => {
    expect(COLLECT).toMatch(/data:\s*inflight,\s*error:\s*inflightErr/);
    expect(COLLECT).toMatch(/APIFY_DEDUP_CHECK_FAILED/);
    expect(COLLECT).toMatch(/status:\s*503/);
    const errIdx = COLLECT.indexOf("APIFY_DEDUP_CHECK_FAILED");
    const startIdx = COLLECT.indexOf("await startApifyRun(");
    expect(errIdx).toBeGreaterThan(0);
    expect(startIdx).toBeGreaterThan(errIdx);
  });

  it("does not modify actor id, startUrls key, or maxResultItems key", () => {
    expect(COLLECT).toMatch(/ACTOR_SUBITO/);
    expect(COLLECT).toMatch(/buildSubitoActorInput\(searchUrls, maxItems\)/);
  });
});

describe("cron migration (pending)", () => {
  it("has expected SHA-256", () => {
    const sha = createHash("sha256").update(readFileSync(MIGRATION_PATH)).digest("hex");
    expect(sha).toBe("be5e164112744d90b951583fb0d34c7d04d1878d9cadc6006a0f92037c96cde3");
  });

  it("does not hardcode the secret value", () => {
    expect(MIGRATION).not.toMatch(/central_core_job_secret\s*=\s*['"][^'"]+['"]/i);
    expect(MIGRATION).toMatch(/vault\.decrypted_secrets/);
    expect(MIGRATION).toMatch(/name = 'central_core_job_secret'/);
  });

  it("preserves weekly schedule and job name (looked up by jobname)", () => {
    expect(MIGRATION).toMatch(/jobname = 'apify-subito-weekly'/);
    expect(MIGRATION).not.toMatch(/schedule\s*:=/i);
    expect(MIGRATION).toMatch(/aborting cron update/);
  });

  it("does not change URL or actor", () => {
    expect(MIGRATION).toMatch(/cron-apify-subito-nightly/);
    expect(MIGRATION).not.toMatch(/emastra/);
  });
});

describe("cron compensating migration (restore body {} + apikey)", () => {
  it("has expected SHA-256", () => {
    const sha = createHash("sha256").update(readFileSync(COMPENSATING_PATH)).digest("hex");
    expect(sha).toBe("4bae14b68ee28cd90d106c48fe2a90f482bd5a5597c16a3a74a96160ee58900f");
  });

  it("has exactly one BEGIN and one COMMIT", () => {
    expect(COMPENSATING.match(/^BEGIN;/m)?.length).toBe(1);
    expect(COMPENSATING.match(/^COMMIT;/m)?.length).toBe(1);
  });

  it("restores body '{}'::jsonb and keeps URL unchanged", () => {
    expect(COMPENSATING).toMatch(/body\s*:=\s*'\{\}'::jsonb/);
    expect(COMPENSATING).toMatch(/\/functions\/v1\/cron-apify-subito-nightly/);
  });

  it("preserves Content-Type, restores apikey, and reads x-job-secret from Vault", () => {
    expect(COMPENSATING).toMatch(/'Content-Type',\s*'application\/json'/);
    expect(COMPENSATING).toMatch(/'apikey',\s*%L/);
    expect(COMPENSATING).toMatch(/'x-job-secret',\s*\(SELECT decrypted_secret FROM vault\.decrypted_secrets WHERE name = 'central_core_job_secret'/);
  });

  it("fails fast if central_core_job_secret is missing", () => {
    expect(COMPENSATING).toMatch(/aborting cron update/);
  });

  it("targets exactly one job by jobname", () => {
    expect(COMPENSATING).toMatch(/jobname = 'apify-subito-weekly'/);
    expect(COMPENSATING).toMatch(/expected exactly 1 cron job/);
  });

  it("does not alter schedule or actor", () => {
    expect(COMPENSATING).not.toMatch(/schedule\s*:=/i);
    expect(COMPENSATING).not.toMatch(/emastra/);
  });
});
