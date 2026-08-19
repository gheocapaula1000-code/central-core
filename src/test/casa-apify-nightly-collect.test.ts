import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACTOR_CASA,
  CASA_CHANNEL,
  CASA_CRON_JOB,
  CASA_DEFAULT_LOCATION,
  CASA_DEFAULT_MAX_ITEMS,
  CASA_LIVE_CORE_REF,
  CASA_MAX_ITEMS_CAP,
  CASA_PORTAL,
  COLLECT_PENDING_FN,
  buildCasaActorInput,
  buildCollectPendingWebhook,
  casaSourceRegistryPatch,
  classifyCasaNightlyResult,
  clampCasaMaxItems,
  collectPendingUrl,
  encodeApifyWebhooksParam,
  estimateCasaUsd,
  extractJobSecretCandidates,
  formatApifyStartError,
  isJobSecretAuthorized,
  jobAuthFailure,
  normalizeCasaLocations,
  redactApifyText,
  summarizeCasaDatasetItems,
  webhookCreateBody,
} from "../../supabase/functions/_shared/casaCollect.ts";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const SECRET = "test-job-secret-value-32chars-ok";

describe("job secret auth — headers actually used by cron / Core", () => {
  it("accepts x-job-secret (log_cron_http_invocation)", () => {
    expect(isJobSecretAuthorized(new Headers({ "x-job-secret": SECRET }), SECRET)).toBe(true);
  });

  it("accepts x-internal-secret", () => {
    expect(isJobSecretAuthorized(new Headers({ "x-internal-secret": SECRET }), SECRET)).toBe(true);
  });

  it("accepts Authorization Bearer when it is the job secret, not a JWT", () => {
    expect(isJobSecretAuthorized(new Headers({ Authorization: `Bearer ${SECRET}` }), SECRET)).toBe(true);
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
  });
});

describe("Casa.it actor input — locations only, Padova", () => {
  it("defaults to Padova and drops search URLs", () => {
    expect(normalizeCasaLocations(undefined)).toEqual([CASA_DEFAULT_LOCATION]);
    expect(normalizeCasaLocations([])).toEqual(["Padova"]);
    expect(normalizeCasaLocations(["https://www.casa.it/vendita/residenziale/padova"])).toEqual(["Padova"]);
    expect(normalizeCasaLocations(["  Padova  ", "https://example.com"])).toEqual(["Padova"]);
  });

  it("builds the Store schema (locations + channel + maxResults) without searchUrls", () => {
    const input = buildCasaActorInput(["Padova"], 300);
    expect(input).toEqual({ locations: ["Padova"], channel: CASA_CHANNEL, maxResults: 300 });
    expect(input).not.toHaveProperty("searchUrls");
    expect(ACTOR_CASA).toBe("benthepythondev~casa-it-scraper");
  });

  it("clamps max_items into 1..500 and prices at $0.002/result", () => {
    expect(clampCasaMaxItems(undefined)).toBe(CASA_DEFAULT_MAX_ITEMS);
    expect(clampCasaMaxItems(0)).toBe(1);
    expect(clampCasaMaxItems(9999)).toBe(CASA_MAX_ITEMS_CAP);
    expect(estimateCasaUsd(300)).toBe(0.6);
  });
});

describe("collect-pending webhook handoff", () => {
  it("posts run_ids and x-job-secret without embedding them in the repo", () => {
    const url = collectPendingUrl(`https://${CASA_LIVE_CORE_REF}.supabase.co`);
    expect(url).toContain(COLLECT_PENDING_FN);
    const wh = buildCollectPendingWebhook(url, SECRET);
    expect(wh).not.toBeNull();
    expect(wh!.payloadTemplate).toBe('{"run_ids":["{{resource.id}}"]}');
    expect(wh!.eventTypes).toContain("ACTOR.RUN.SUCCEEDED");
    const headers = JSON.parse(wh!.headersTemplate);
    expect(headers["x-job-secret"]).toBe(SECRET);
    expect(encodeApifyWebhooksParam([wh!]).length).toBeGreaterThan(20);
    const body = webhookCreateBody("run-1", wh!);
    expect((body.condition as { actorRunId: string }).actorRunId).toBe("run-1");
  });

  it("returns null when url or secret is missing", () => {
    expect(buildCollectPendingWebhook("", SECRET)).toBeNull();
    expect(buildCollectPendingWebhook("https://x/functions/v1/padova-apify-collect-pending", "")).toBeNull();
  });
});

describe("nightly semantic success — empty is fail", () => {
  it("requires a run_id and rejects skipped/error payloads", () => {
    expect(classifyCasaNightlyResult(202, { ok: true, run_id: "abc" }).ok).toBe(true);
    expect(classifyCasaNightlyResult(202, { ok: true, run_id: "abc" }).started_count).toBe(1);
    expect(classifyCasaNightlyResult(200, { ok: true, skipped: true, reason: "cap" }).ok).toBe(false);
    expect(classifyCasaNightlyResult(429, { ok: false, skipped: true, reason: "APIFY_DAILY_CAP_REACHED" }).reason)
      .toBe("APIFY_DAILY_CAP_REACHED");
    expect(classifyCasaNightlyResult(202, { ok: true }).ok).toBe(false);
    expect(classifyCasaNightlyResult(202, { ok: true }).reason).toBe("no_run_id");
    expect(classifyCasaNightlyResult(502, { ok: false, error: "provider_returned_zero_items" }).ok).toBe(false);
  });

  it("redacts tokens from Apify error bodies", () => {
    const msg = formatApifyStartError(404, "not found token=apify_api_live_secret_value more");
    expect(msg).toContain("APIFY_START_HTTP_404");
    expect(msg).not.toContain("apify_api_live_secret_value");
    expect(redactApifyText("Bearer super-secret token=abc")).toContain("[REDACTED]");
  });

  it("writes [casa-apify] to the source registry on failure", () => {
    const fail = casaSourceRegistryPatch({ ok: false, error: "timeout" }, "2026-08-19T02:30:00Z");
    expect(fail.last_error).toBe("[casa-apify] timeout");
    const ok = casaSourceRegistryPatch({ ok: true, records: 1 }, "2026-08-19T02:30:00Z");
    expect(ok.last_success_at).toBe("2026-08-19T02:30:00Z");
    expect(ok.record_count).toBe(1);
  });
});

describe("dataset sample summary", () => {
  it("counts Padova vs missing city from actor-shaped items", () => {
    const s = summarizeCasaDatasetItems([
      { id: 1, city: "Padova", channel: "sale" },
      { id: 2, city: "Selvazzano Dentro", channel: "sale" },
      { id: 3, channel: "rent" },
    ]);
    expect(s.count).toBe(3);
    expect(s.padova_city_count).toBe(1);
    expect(s.missing_city_count).toBe(1);
    expect(s.sale_count).toBe(2);
    expect(s.sample_ids).toEqual(["1", "2", "3"]);
  });
});

describe("wiring — nightly, collect, debug", () => {
  const nightly = read("supabase/functions/cron-apify-casa-nightly/index.ts");
  const collect = read("supabase/functions/padova-apify-casa-collect/index.ts");
  const debug = read("supabase/functions/casa-scrape-debug/index.ts");
  const shared = read("supabase/functions/_shared/casaCollect.ts");
  const cronSql = read("supabase/migrations/20260817145000_portal_crons_padova.sql");

  it("nightly forwards Padova locations and requires a real run_id", () => {
    expect(nightly).toContain("padova-apify-casa-collect");
    expect(nightly).toContain("CASA_DEFAULT_LOCATION");
    expect(nightly).toContain("classifyCasaNightlyResult");
    expect(nightly).toContain("isJobSecretAuthorized");
    expect(nightly).toContain("CASA_CRON_JOB");
    expect(nightly).toMatch(/Authorization.*Bearer/);
  });

  it("collect uses the Store actor, locations only, and collect-pending webhooks", () => {
    expect(collect).toContain("ACTOR_CASA");
    expect(collect).toContain("buildCasaActorInput");
    expect(collect).toContain("encodeApifyWebhooksParam");
    expect(collect).toContain("casa_run_already_running");
    expect(collect).toContain("Authorization: `Bearer ${token}`");
    expect(collect).not.toMatch(/searchUrls\s*:/);
    expect(collect).not.toMatch(/token=\$\{encodeURIComponent\(token\)\}/);
    expect(shared).toContain("benthepythondev~casa-it-scraper");
    expect(shared).toContain('channel: "sale"');
  });

  it("expires stale scrape jobs before the 6h already_running skip", () => {
    const expireIdx = collect.indexOf("await expireStaleScrapeJobs(sb)");
    const skipIdx = collect.indexOf("casa_run_already_running");
    expect(expireIdx).toBeGreaterThan(0);
    expect(skipIdx).toBeGreaterThan(expireIdx);
  });

  it("debug defaults to last Apify run and does not Firecrawl unless ?live=1", () => {
    expect(debug).toContain('mode: "apify_last_run"');
    expect(debug).toContain('u.searchParams.get("live") === "1"');
    expect(debug).toContain("requireDiagnosticSecret");
    const handler = debug.slice(debug.indexOf("Deno.serve("));
    const guardIdx = handler.indexOf("if (authFail) return authFail;");
    const liveIdx = handler.indexOf("api.firecrawl.dev");
    const defaultIdx = handler.indexOf("apify_last_run");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(liveIdx).toBeGreaterThan(guardIdx);
    expect(defaultIdx).toBeGreaterThan(guardIdx);
    expect(debug).toContain("PROMPT_FIX_PARSER_CASA");
  });

  it("cron on live Core only, vault secret, empty = fail", () => {
    expect(cronSql).toContain(CASA_LIVE_CORE_REF);
    expect(cronSql).toContain("/functions/v1/cron-apify-casa-nightly");
    expect(cronSql).toContain("'portal-casa-padova'");
    expect(cronSql).toContain("Casa.it empty = fail, not fake success");
    expect(cronSql).not.toContain("egjvullvkwpzyyworeml");
    expect(CASA_CRON_JOB).toBe("portal-casa-padova");
    expect(CASA_PORTAL).toBe("casa_collect");
  });

  it("does not embed secrets or the empty prod ref", () => {
    for (const src of [nightly, collect, debug, shared]) {
      expect(src).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
      expect(src).not.toContain("egjvullvkwpzyyworeml");
      expect(src).not.toMatch(/apify_api_[A-Za-z0-9]+/);
    }
  });
});
