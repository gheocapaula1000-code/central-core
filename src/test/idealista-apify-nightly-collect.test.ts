import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACTOR_IDEALISTA,
  IDEALISTA_PADOVA_DISCOVERY_URLS,
  buildCollectPendingWebhook,
  classifyNightlyCollectResult,
  encodeApifyWebhooksParam,
  extractCollectRunIds,
  extractStartedRunIds,
  formatApifyStartError,
  isKnownIdealistaActor,
  isValidIdealistaUrl,
  normalizeApifyActorId,
  sourceRegistryPatch,
} from "../../supabase/functions/_shared/apifyLaunch.ts";
import {
  extractJobSecretCandidates,
  isJobSecretAuthorized,
  jobAuthFailure,
  jobAuthHeaders,
} from "../../supabase/functions/_shared/jobAuth.ts";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const SECRET = "test-job-secret-value-32chars-ok";

describe("job secret auth — headers actually used by cron / Core", () => {
  it("accepts x-job-secret (log_cron_http_invocation)", () => {
    const h = new Headers({ "x-job-secret": SECRET });
    expect(isJobSecretAuthorized(h, SECRET)).toBe(true);
  });

  it("accepts x-internal-secret (canonical internal header)", () => {
    const h = new Headers({ "x-internal-secret": SECRET });
    expect(isJobSecretAuthorized(h, SECRET)).toBe(true);
  });

  it("accepts Authorization Bearer when it is the job secret, not a JWT", () => {
    const h = new Headers({ Authorization: `Bearer ${SECRET}` });
    expect(isJobSecretAuthorized(h, SECRET)).toBe(true);
  });

  it("ignores JWT bearers and rejects missing/wrong secrets", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb";
    expect(isJobSecretAuthorized(new Headers({ Authorization: `Bearer ${jwt}` }), SECRET)).toBe(false);
    expect(isJobSecretAuthorized(new Headers({ "x-job-secret": "nope" }), SECRET)).toBe(false);
    expect(isJobSecretAuthorized(new Headers(), SECRET)).toBe(false);
    expect(isJobSecretAuthorized(new Headers({ "x-job-secret": SECRET }), "")).toBe(false);
  });

  it("does not treat a JWT as a candidate", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb";
    expect(extractJobSecretCandidates(new Headers({ Authorization: `Bearer ${jwt}` }))).toEqual([]);
  });

  it("reports CONFIG vs unauthorized without leaking the secret", () => {
    expect(jobAuthFailure(false)).toEqual({ status: 500, error: "CENTRAL_CORE_JOB_SECRET missing" });
    expect(jobAuthFailure(true)).toEqual({ status: 401, error: "unauthorized" });
    expect(JSON.stringify(jobAuthHeaders(SECRET))).not.toMatch(/eyJ/);
  });
});

describe("Apify actor ids, Padova URLs, and start errors", () => {
  it("normalizes username/name to the Apify path form username~name", () => {
    expect(normalizeApifyActorId("dz_omar/idealista-scraper-api")).toBe(ACTOR_IDEALISTA);
    expect(normalizeApifyActorId(ACTOR_IDEALISTA)).toBe(ACTOR_IDEALISTA);
    expect(normalizeApifyActorId("")).toBe("");
  });

  it("knows the Idealista actor used by collect + collect-pending", () => {
    expect(isKnownIdealistaActor("dz_omar/idealista-scraper-api")).toBe(true);
    expect(isKnownIdealistaActor(ACTOR_IDEALISTA)).toBe(true);
    expect(isKnownIdealistaActor("someone~else")).toBe(false);
  });

  it("accepts only Idealista host URLs that the actor schema allows", () => {
    for (const url of IDEALISTA_PADOVA_DISCOVERY_URLS) {
      expect(isValidIdealistaUrl(url)).toBe(true);
      expect(url).toContain("https://www.idealista.it/vendita-case/padova-padova");
      expect(url).not.toMatch(/desde|ordenado-por|ordinato-per=/);
    }
    expect(isValidIdealistaUrl("https://www.immobiliare.it/vendita-case/padova/")).toBe(false);
    expect(isValidIdealistaUrl("http://www.idealista.it/vendita-case/padova-padova/")).toBe(false);
  });

  it("redacts token= from Apify error bodies", () => {
    const msg = formatApifyStartError(404, "not found token=apify_live_secret_value more");
    expect(msg).toContain("APIFY_START_HTTP_404");
    expect(msg).not.toContain("apify_live_secret_value");
    expect(msg).toContain("token=[REDACTED]");
  });
});

describe("collect-pending webhook handoff", () => {
  it("builds a webhook that posts run_ids and x-job-secret without embedding them in the repo", () => {
    const wh = buildCollectPendingWebhook(
      "https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/padova-apify-collect-pending",
      SECRET,
    );
    expect(wh).not.toBeNull();
    expect(wh!.requestUrl).toContain("padova-apify-collect-pending");
    expect(wh!.payloadTemplate).toBe('{"run_ids":["{{resource.id}}"]}');
    expect(wh!.eventTypes).toContain("ACTOR.RUN.SUCCEEDED");
    expect(wh!.eventTypes).toContain("ACTOR.RUN.FAILED");
    const headers = JSON.parse(wh!.headersTemplate);
    expect(headers["x-job-secret"]).toBe(SECRET);
    expect(encodeApifyWebhooksParam([wh!]).length).toBeGreaterThan(20);
  });

  it("refuses to attach a webhook without https URL or secret (fail-closed)", () => {
    expect(buildCollectPendingWebhook("http://insecure.example/fn", SECRET)).toBeNull();
    expect(buildCollectPendingWebhook("https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/x", "")).toBeNull();
  });

  it("reads run_ids from our template and from raw Apify webhook bodies", () => {
    expect(extractCollectRunIds({ run_ids: ["abc", "abc", ""] })).toEqual(["abc"]);
    expect(extractCollectRunIds({ eventData: { actorRunId: "run_1" } })).toEqual(["run_1"]);
    expect(extractCollectRunIds({ resource: { id: "run_2" } })).toEqual(["run_2"]);
    expect(extractCollectRunIds({ foo: 1 })).toEqual([]);
  });
});

describe("nightly semantic classification + registry patch", () => {
  it("succeeds when collect returns started[] or a top-level run_id", () => {
    expect(classifyNightlyCollectResult({
      httpOk: true, ok: true, started: [{ run_id: "r1" }], errors: [],
    })).toEqual({ ok: true, started_count: 1, errors_count: 0, reason: null });
    expect(classifyNightlyCollectResult({
      httpOk: true, ok: true, run_id: "r2",
    })).toEqual({ ok: true, started_count: 1, errors_count: 0, reason: null });
    expect(extractStartedRunIds({ run_id: "r2", dataset_id: "d2" })).toEqual(["r2"]);
    expect(extractStartedRunIds({ started: [{ run_id: "r1" }, { run_id: "r1" }] })).toEqual(["r1"]);
  });

  it("fails closed on skip, empty start, or HTTP error", () => {
    expect(classifyNightlyCollectResult({
      httpOk: true, ok: false, error: "APIFY_TOKEN_MISSING", started: [],
    }).reason).toBe("APIFY_TOKEN_MISSING");
    expect(classifyNightlyCollectResult({
      httpOk: true, ok: true, started: [], skipped: true,
    }).reason).toMatch(/^skipped/);
    expect(classifyNightlyCollectResult({
      httpOk: false, error: "unauthorized", started: [],
    }).ok).toBe(false);
  });

  it("prefixes registry errors so F21 last_error is auditable", () => {
    const fail = sourceRegistryPatch(
      { ok: false, error: "APIFY_START_HTTP_404:actor not found" },
      "2026-08-19T02:10:00Z",
      "[idealista-apify]",
    );
    expect(fail.last_error).toMatch(/^\[idealista-apify\] APIFY_START_HTTP_404/);
    expect(fail.last_success_at).toBeUndefined();
    const ok = sourceRegistryPatch({ ok: true, records: 4 }, "2026-08-19T02:10:00Z");
    expect(ok.last_error).toBeNull();
    expect(ok.last_success_at).toBe("2026-08-19T02:10:00Z");
    expect(ok.record_count).toBe(4);
  });
});

describe("Padova search URLs and wiring", () => {
  const nightly = read("supabase/functions/cron-apify-idealista-nightly/index.ts");
  const collect = read("supabase/functions/padova-apify-idealista-collect/index.ts");
  const shared = read("supabase/functions/_shared/apify.ts");

  it("defaults every nightly discovery URL to vendita-case/padova-padova", () => {
    expect(IDEALISTA_PADOVA_DISCOVERY_URLS.length).toBeGreaterThanOrEqual(3);
    expect(nightly).toContain("IDEALISTA_PADOVA_DISCOVERY_URLS");
    expect(collect).toContain("IDEALISTA_PADOVA_DISCOVERY_URLS");
  });

  it("nightly and collect share job-secret auth and write the source registry", () => {
    expect(nightly).toContain("isJobSecretAuthorized");
    expect(nightly).toContain("writeIdealistaSourceRegistry");
    expect(nightly).toContain("padova-apify-collect-pending");
    expect(nightly).toContain("portal-idealista-padova");
    expect(collect).toContain("isJobSecretAuthorized");
    expect(collect).toContain("writeIdealistaSourceRegistry");
    expect(collect).toContain("handoffCollectPending");
  });

  it("startApifyRun attaches collect-pending webhooks and persists FAILED launches", () => {
    expect(shared).toContain("buildApifyRunWebhooks");
    expect(shared).toContain("encodeApifyWebhooksQuery");
    expect(shared).toContain("persistFailedLaunch");
    expect(shared).toContain("Authorization: `Bearer ${token}`");
    expect(shared).not.toMatch(/token=\$\{encodeURIComponent\(token\)\}/);
  });

  it("collect still runs the scrape-job watchdog before launch", () => {
    const expireIdx = collect.indexOf("await expireStaleScrapeJobs(sb)");
    const launchIdx = collect.indexOf("await startApifyRun(");
    expect(expireIdx).toBeGreaterThan(0);
    expect(launchIdx).toBeGreaterThan(expireIdx);
  });

  it("does not embed secrets or the empty prod ref", () => {
    for (const src of [nightly, collect, shared]) {
      expect(src).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
      expect(src).not.toContain("egjvullvkwpzyyworeml");
      expect(src).not.toMatch(/apify_api_[A-Za-z0-9]+/);
    }
  });
});

describe("cron migration — live Core, vault secret, keep drain + watchdog", () => {
  const sql = read("supabase/migrations/20260819181000_idealista_apify_collect_handoff.sql");
  const health = read("supabase/functions/core-cron-health-public/index.ts");

  it("exists and targets live Core only", () => {
    expect(existsSync(resolve(root, "supabase/migrations/20260819181000_idealista_apify_collect_handoff.sql"))).toBe(true);
    expect(sql).toContain("jpunnzgixcghuydstdlt");
    expect(sql).not.toContain("egjvullvkwpzyyworeml");
  });

  it("unschedules only Idealista nightly jobs and uses vault-backed log_cron_http_invocation", () => {
    expect(sql).toContain("central-core-apify-idealista-nightly");
    expect(sql).toContain("cron.unschedule");
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(sql).toContain("log_cron_http_invocation");
    expect(sql).not.toMatch(/FOREACH j IN ARRAY ARRAY\[[^\]]*(collect-pending|expire-stale)/);
  });

  it("keeps the main drain and watchdog crons untouched", () => {
    expect(health).toContain('jobname: "portal-collect-pending"');
    expect(health).toContain('jobname: "portal-collect-pending-drain"');
    expect(health).toContain('jobname: "expire-stale-scrape-jobs"');
    expect(health).toMatch(/portal-collect-pending-drain[\s\S]*"\*\/15 \* \* \* \*"/);
    expect(health).toMatch(/expire-stale-scrape-jobs[\s\S]*"\*\/15 \* \* \* \*"/);
  });

  it("keeps idealista nightly on live Core via vault-backed job secret", () => {
    expect(sql).toContain("/functions/v1/cron-apify-idealista-nightly");
    expect(sql).toContain("'10 2 * * *'");
  });
});
