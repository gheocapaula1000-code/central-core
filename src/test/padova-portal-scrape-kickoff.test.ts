import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  constantTimeEqual,
  extractJobSecretCandidates,
  isJobSecretAuthorized,
  jobAuthFailure,
} from "../../supabase/functions/_shared/jobAuth";
import {
  classifyMultiLaunchOutcome,
  decideInflightLock,
  defaultMultiLaunchBody,
  isEmptyLaunchBody,
  isLockHeldEnvelope,
  identifierPairFromEnvelope,
  redactLaunchError,
  STALE_LOCK_MS,
} from "../../supabase/functions/_shared/padovaPortalLaunch";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const ENQUEUE = read("supabase/functions/enqueue-padova-portal-scrapes/index.ts");
const KICKOFF = read("supabase/functions/padova-apify-kickoff/index.ts");
const MULTI = read("supabase/functions/padova-apify-multi-launch/index.ts");
const STATUS = read("supabase/functions/padova-apify-multi-status/index.ts");
const BATCH = read("supabase/functions/civiko-padova-apify-launch-batch/index.ts");
const CAPPED = read("supabase/functions/civiko-padova-apify-launch-batch-capped/index.ts");
const CONFIG = read("supabase/config.toml");

const SECRET = "cron-job-secret-value-32chars-min";

describe("job secret headers used by cron", () => {
  it("accepts x-job-secret, x-internal-secret, and non-JWT Bearer", () => {
    expect(isJobSecretAuthorized(new Headers({ "x-job-secret": SECRET }), SECRET)).toBe(true);
    expect(isJobSecretAuthorized(new Headers({ "x-internal-secret": SECRET }), SECRET)).toBe(true);
    expect(isJobSecretAuthorized(new Headers({ Authorization: `Bearer ${SECRET}` }), SECRET)).toBe(true);
  });

  it("rejects missing, wrong, empty, and JWT bearers", () => {
    expect(isJobSecretAuthorized(new Headers(), SECRET)).toBe(false);
    expect(isJobSecretAuthorized(new Headers({ "x-job-secret": "nope" }), SECRET)).toBe(false);
    expect(isJobSecretAuthorized(new Headers({ "x-job-secret": SECRET }), "")).toBe(false);
    expect(isJobSecretAuthorized(
      new Headers({ Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig" }),
      SECRET,
    )).toBe(false);
    expect(extractJobSecretCandidates(
      new Headers({ Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig" }),
    )).toEqual([]);
  });

  it("compares in constant time and fails closed when env is missing", () => {
    expect(constantTimeEqual(SECRET, SECRET)).toBe(true);
    expect(constantTimeEqual(SECRET, "x")).toBe(false);
    expect(jobAuthFailure(false)).toEqual({ status: 500, error: "CENTRAL_CORE_JOB_SECRET missing" });
    expect(jobAuthFailure(true)).toEqual({ status: 401, error: "unauthorized" });
  });
});

describe("kickoff / multi-launch defaults so cron can start scrapes", () => {
  it("treats empty cron bodies as empty and fills the Padova plan", () => {
    expect(isEmptyLaunchBody({})).toBe(true);
    expect(isEmptyLaunchBody(null)).toBe(true);
    expect(isEmptyLaunchBody({ subito_full: {} })).toBe(false);
    const plan = defaultMultiLaunchBody();
    expect(plan.idealista).toMatchObject({ from_db: true });
    expect(plan.casa_full).toMatchObject({ search_location: "Padova" });
    expect(plan.subito_full).toBeTruthy();
  });

  it("reuses a live lock and expires a stale RUNNING row", () => {
    const now = Date.parse("2026-08-19T16:00:00Z");
    expect(decideInflightLock({
      run_id: "run_live",
      dataset_id: "ds_live",
      started_at: "2026-08-19T15:10:00Z",
      status: "RUNNING",
    }, now)).toEqual({ action: "reuse", run_id: "run_live", dataset_id: "ds_live" });
    expect(decideInflightLock({
      run_id: "run_stale",
      dataset_id: "ds_stale",
      started_at: new Date(now - STALE_LOCK_MS - 1000).toISOString(),
      status: "RUNNING",
    }, now)).toEqual({ action: "expire", run_id: "run_stale" });
    expect(decideInflightLock(null, now)).toEqual({ action: "launch" });
  });

  it("classifies launch errors vs budget vs lock reuse", () => {
    expect(classifyMultiLaunchOutcome([
      { started: true, run_id: "a", dataset_id: "d" },
      { started: true, reason: "already_running", run_id: "b", dataset_id: "e" },
    ])).toMatchObject({ ok: true, status: 200, started_count: 2, reused_count: 1 });
    expect(classifyMultiLaunchOutcome([
      { started: false, reason: "monthly_cap_reached" },
    ])).toMatchObject({ ok: false, status: 429 });
    expect(classifyMultiLaunchOutcome([
      { started: false, reason: "APIFY_START_HTTP_500" },
    ])).toMatchObject({ ok: false, status: 502 });
  });

  it("recognizes lock-held envelopes and redacts tokens from launch errors", () => {
    expect(isLockHeldEnvelope(409, {
      skipped: true,
      skipped_reason: "subito_run_already_running",
      existing_run_id: "run_1",
    })).toBe(true);
    expect(identifierPairFromEnvelope({
      existing_run_id: "run_1",
      existing_dataset_id: "ds_1",
    })).toEqual({ run_id: "run_1", dataset_id: "ds_1" });
    expect(redactLaunchError("APIFY_START_HTTP_401: token=secret-value&x=1"))
      .toContain("token=[REDACTED]");
    expect(redactLaunchError("APIFY_START_HTTP_401: token=secret-value&x=1"))
      .not.toContain("secret-value");
  });
});

describe("scoped functions wire the cron contract", () => {
  const files = [
    ["enqueue", ENQUEUE],
    ["kickoff", KICKOFF],
    ["multi-launch", MULTI],
    ["multi-status", STATUS],
    ["launch-batch", BATCH],
    ["launch-batch-capped", CAPPED],
  ] as const;

  for (const [name, src] of files) {
    it(`${name} uses shared jobAuth and does not log the secret`, () => {
      expect(src).toContain("isJobSecretAuthorized");
      expect(src).toContain('Deno.env.get("CENTRAL_CORE_JOB_SECRET")');
      expect(src).not.toMatch(/console\.[a-z]+\([^)]*JOB_SECRET/);
      expect(src).not.toMatch(/C1v1k0C0r3/);
      expect(src).not.toMatch(/body\s*[?.]*\.?job_secret/);
    });
  }

  it("kickoff accepts job-secret without an admin JWT and fills empty launch bodies", () => {
    expect(KICKOFF).toContain("isJobSecretAuthorized");
    expect(KICKOFF).toContain("isAdminJwt");
    expect(KICKOFF).toContain("defaultMultiLaunchBody");
    expect(KICKOFF).toContain("padova-apify-multi-launch");
    expect(CONFIG).toMatch(/\[functions\.padova-apify-kickoff\]\s*\nverify_jwt = false/);
  });

  it("multi-launch expires stale locks and persists failed starts", () => {
    expect(MULTI).toContain("decideInflightLock");
    expect(MULTI).toContain("STALE_LOCK");
    expect(MULTI).toContain('status: "FAILED"');
    expect(MULTI).toContain("classifyMultiLaunchOutcome");
    expect(MULTI).toContain("defaultMultiLaunchBody");
  });

  it("multi-status releases unreadable stale RUNNING locks", () => {
    expect(STATUS).toContain("STALE_LOCK_MS");
    expect(STATUS).toContain("STALE_LOCK");
  });

  it("launch batches treat already_running as a held lock, not a hard fail", () => {
    expect(BATCH).toContain("isLockHeldEnvelope");
    expect(BATCH).toContain("existing_run_id");
    expect(BATCH).toContain("lookupRunBundle");
    expect(CAPPED).toContain("isLockHeldEnvelope");
    expect(CAPPED).toContain("existing_run_id");
  });
});
