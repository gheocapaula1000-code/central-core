import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACTOR_SUBITO,
  SUBITO_PADOVA_SEARCH_URLS,
  buildCollectPendingWebhook,
  classifyNightlyCollectResult,
  encodeApifyWebhooksParam,
  extractCollectRunIds,
  formatApifyStartError,
  isKnownSubitoActor,
  normalizeApifyActorId,
  sourceRegistryPatch,
} from "../../supabase/functions/_shared/apifyLaunch.ts";
import {
  extractJobSecretCandidates,
  isJobSecretAuthorized,
  jobAuthFailure,
  jobAuthHeaders,
} from "../../supabase/functions/_shared/jobAuth.ts";
import {
  buildSubitoActorInput,
  clampSubitoMaxItems,
  clampSubitoWaitSeconds,
  classifyPromoteResult,
  refuseSubitoApifyFull,
  SUBITO_APIFY_LIVE_MAX_ITEMS,
  SUBITO_FIRECRAWL_PRIMARY_REASON,
  estimateSubitoCostUsd,
  flattenSubitoForStaging,
  mapSubito,
  normalizeSubitoStartUrls,
} from "../../supabase/functions/_shared/subitoMapper.ts";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const SECRET = "test-job-secret-value-32chars-ok";

const EMSTRA_PADOVA = {
  page_url: "https://www.subito.it/appartamenti/bilocale-padova-123456789.htm",
  type: "vendita",
  sub_category: "appartamenti",
  price: { value: 185000 },
  location: {
    city: "Padova",
    province: "Padova",
    region: "Veneto",
    coordinates: { latitude: 45.4064, longitude: 11.8768 },
  },
  features: {
    size_sqm: { value: 72 },
    rooms: { value: 3 },
    bathrooms: { value: 1 },
    floor: { value: null, label: "Rialzato" },
    building_condition: { label: "Buono" },
  },
  advertiser: { type: "privato", name: "Mario", phone_number: "+39049" },
  images: ["https://img.subito.it/a.jpg"],
};

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

describe("Apify actor ids and start errors", () => {
  it("normalizes username/name to the Apify path form username~name", () => {
    expect(normalizeApifyActorId("emastra/subito-it-immobili")).toBe(ACTOR_SUBITO);
    expect(normalizeApifyActorId(ACTOR_SUBITO)).toBe(ACTOR_SUBITO);
    expect(normalizeApifyActorId("")).toBe("");
  });

  it("knows the Subito actor used by collect + collect-pending", () => {
    expect(isKnownSubitoActor("emastra/subito-it-immobili")).toBe(true);
    expect(isKnownSubitoActor(ACTOR_SUBITO)).toBe(true);
    expect(isKnownSubitoActor("someone~else")).toBe(false);
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
  it("succeeds when run_id is present (Subito async_start shape)", () => {
    expect(classifyNightlyCollectResult({
      httpOk: true, ok: true, run_id: "r1",
    })).toEqual({ ok: true, started_count: 1, errors_count: 0, reason: null });
  });

  it("succeeds when started[] is present", () => {
    expect(classifyNightlyCollectResult({
      httpOk: true, ok: true, started: [{ run_id: "r1" }], errors: [],
    })).toEqual({ ok: true, started_count: 1, errors_count: 0, reason: null });
  });

  it("fails closed on skip, empty start, or HTTP error", () => {
    expect(classifyNightlyCollectResult({
      httpOk: true, ok: false, error: "APIFY_TOKEN_MISSING",
    }).reason).toBe("APIFY_TOKEN_MISSING");
    expect(classifyNightlyCollectResult({
      httpOk: true, ok: true, skipped: true,
    }).reason).toMatch(/^skipped/);
    expect(classifyNightlyCollectResult({
      httpOk: false, error: "unauthorized",
    }).ok).toBe(false);
    expect(classifyNightlyCollectResult({
      httpOk: true, ok: true,
    }).reason).toBe("no_apify_run_started");
  });

  it("prefixes registry errors so last_error is auditable", () => {
    const fail = sourceRegistryPatch(
      { ok: false, error: "APIFY_START_HTTP_404:actor not found" },
      "2026-08-19T02:20:00Z",
      "[subito-apify]",
    );
    expect(fail.last_error).toMatch(/^\[subito-apify\] APIFY_START_HTTP_404/);
    expect(fail.last_success_at).toBeUndefined();
    const ok = sourceRegistryPatch({ ok: true, records: 4 }, "2026-08-19T02:20:00Z");
    expect(ok.last_error).toBeNull();
    expect(ok.last_success_at).toBe("2026-08-19T02:20:00Z");
    expect(ok.record_count).toBe(4);
  });
});

describe("Subito mapper, actor input, flatten for promote", () => {
  it("defaults every search URL to Padova vendita on subito.it", () => {
    expect(SUBITO_PADOVA_SEARCH_URLS.length).toBeGreaterThanOrEqual(1);
    for (const url of SUBITO_PADOVA_SEARCH_URLS) {
      expect(url).toContain("https://www.subito.it/annunci-veneto/vendita/");
      expect(url).toContain("/padova/");
    }
  });

  it("builds emastra actor input with startUrls strings and maxResultItems", () => {
    const input = buildSubitoActorInput([...SUBITO_PADOVA_SEARCH_URLS], 300);
    expect(input.startUrls).toEqual([...SUBITO_PADOVA_SEARCH_URLS]);
    expect(input.maxResultItems).toBe(300);
    expect(input).not.toHaveProperty("maxItems");
  });

  it("clamps max_items and estimates 5 USD / 1000 items", () => {
    expect(clampSubitoMaxItems(0)).toBe(1);
    expect(clampSubitoMaxItems(9999)).toBe(1000);
    expect(clampSubitoMaxItems("nope")).toBe(300);
    expect(estimateSubitoCostUsd(300)).toBe(1.5);
  });

  it("refuses Apify full and caps sync wait so the job cannot hang until watchdog", () => {
    expect(refuseSubitoApifyFull({ max_items: 500 }).refuse).toBe(true);
    expect(refuseSubitoApifyFull({ mode: "full" }).reason).toBe(SUBITO_FIRECRAWL_PRIMARY_REASON);
    expect(refuseSubitoApifyFull({ ingest_run_id: "run_1" }).refuse).toBe(false);
    expect(refuseSubitoApifyFull({ max_items: SUBITO_APIFY_LIVE_MAX_ITEMS }).refuse).toBe(false);
    expect(refuseSubitoApifyFull({ force_apify: true, max_items: 500 }).refuse).toBe(false);
    expect(clampSubitoWaitSeconds(240)).toBe(45);
    expect(clampSubitoWaitSeconds(0)).toBe(5);
  });

  it("normalizes {url} objects and rejects non-subito hosts", () => {
    expect(normalizeSubitoStartUrls([{ url: SUBITO_PADOVA_SEARCH_URLS[0] }])).toEqual([
      SUBITO_PADOVA_SEARCH_URLS[0],
    ]);
    expect(normalizeSubitoStartUrls(["https://evil.example/x"])).toEqual([...SUBITO_PADOVA_SEARCH_URLS]);
  });

  it("maps emastra Padova vendita and keeps textual floor labels", () => {
    const mapped = mapSubito(EMSTRA_PADOVA, "job-1", "2026-08-19T02:20:00Z");
    expect(mapped).not.toBeNull();
    expect(mapped!.portal).toBe("subito");
    expect(mapped!.citta).toBe("Padova");
    expect(mapped!.prezzo).toBe(185000);
    expect(mapped!.mq).toBe(72);
    expect(mapped!.piano).toBe("Rialzato");
    expect(mapped!.tipo_lead).toBe("PRIVATO");
    expect(mapped!.listing_id).toBe("123456789");
  });

  it("drops Vigonza and rentals fail-closed", () => {
    expect(mapSubito({
      ...EMSTRA_PADOVA,
      location: { ...EMSTRA_PADOVA.location, city: "Vigonza" },
    }, "j", "t")).toBeNull();
    expect(mapSubito({ ...EMSTRA_PADOVA, type: "affitto" }, "j", "t")).toBeNull();
    expect(mapSubito({ ...EMSTRA_PADOVA, price: { value: 500 } }, "j", "t")).toBeNull();
  });

  it("flattens nested emastra JSON into process_padova_subito_staging keys", () => {
    const flat = flattenSubitoForStaging(EMSTRA_PADOVA);
    expect(flat.urls_default).toContain("123456789.htm");
    expect(String(flat.geo_town_value).toLowerCase()).toBe("padova");
    expect(String(flat.type_value).toLowerCase()).toContain("vendita");
    expect(flat.features_price_values).toBe("185000");
    expect(flat.features_size_values).toBe("72");
    expect(flat.advertiser_company).toBe("false");
  });

  it("passes through already-flat azzouzana staging rows", () => {
    const already = { urls_default: "https://www.subito.it/x-1.htm", geo_town_value: "Padova" };
    expect(flattenSubitoForStaging(already)).toEqual(already);
  });

  it("fails promote classification on RPC errors, succeeds on empty quiet night", () => {
    expect(classifyPromoteResult({ ok: true, staging_rows_found: 0, errors: 0 }).ok).toBe(true);
    expect(classifyPromoteResult({ ok: true, errors: 2 }).ok).toBe(false);
    expect(classifyPromoteResult(null).reason).toBe("empty_promote_result");
  });
});

describe("Padova search URLs and wiring", () => {
  const nightly = read("supabase/functions/cron-apify-subito-nightly/index.ts");
  const collect = read("supabase/functions/padova-apify-subito-collect/index.ts");
  const promote = read("supabase/functions/cron-padova-subito-promote/index.ts");
  const shared = read("supabase/functions/_shared/apify.ts");
  const pending = read("supabase/functions/padova-apify-collect-pending/index.ts");

  it("nightly, collect and promote share job-secret auth and write the source registry", () => {
    expect(nightly).toContain("isJobSecretAuthorized");
    expect(nightly).toContain("writeSubitoSourceRegistry");
    expect(nightly).toContain("handoffCollectPending");
    expect(collect).toContain("isJobSecretAuthorized");
    expect(collect).toContain("writeSubitoSourceRegistry");
    expect(collect).toContain("padova_subito_staging");
    expect(promote).toContain("isJobSecretAuthorized");
    expect(promote).toContain("process_padova_subito_staging");
    expect(promote).toContain("promote_padova_collect_v2_to_listings");
  });

  it("startApifyRun attaches collect-pending webhooks and persists FAILED launches", () => {
    expect(shared).toContain("buildCollectPendingWebhook");
    expect(shared).toContain("persistFailedLaunch");
    expect(shared).toContain("Authorization: `Bearer ${token}`");
    expect(shared).not.toMatch(/token=\$\{encodeURIComponent\(token\)\}/);
  });

  it("collect-pending accepts Apify webhook bodies and writes Subito staging", () => {
    expect(pending).toContain("extractCollectRunIds");
    expect(pending).toContain("webhookRunIds");
    expect(pending).toContain("isJobSecretAuthorized");
    expect(pending).toContain("flattenSubitoForStaging");
    expect(pending).toContain("padova_subito_staging");
  });

  it("does not embed secrets or the empty prod ref", () => {
    for (const src of [nightly, collect, promote, shared, pending]) {
      expect(src).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
      expect(src).not.toContain("egjvullvkwpzyyworeml");
      expect(src).not.toMatch(/apify_api_[A-Za-z0-9]+/);
    }
  });
});

describe("cron migration — live Core, vault secret, 15-min collect, promote", () => {
  const sqlPath = "supabase/migrations/20260819180000_subito_apify_collect_handoff.sql";
  const sql = read(sqlPath);
  const health = read("supabase/functions/core-cron-health-public/index.ts");

  it("exists and targets live Core only", () => {
    expect(existsSync(resolve(root, sqlPath))).toBe(true);
    expect(sql).toContain("jpunnzgixcghuydstdlt");
    expect(sql).not.toContain("egjvullvkwpzyyworeml");
  });

  it("replaces the weekly job that posted a hardcoded anon JWT", () => {
    expect(sql).toContain("apify-subito-weekly");
    expect(sql).toContain("cron.unschedule");
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(sql).toContain("log_cron_http_invocation");
    expect(sql).toContain("'30 3 * * 0'");
  });

  it("keeps the 15-minute collect-pending drain and watchdog already on main", () => {
    const unschedules = sql.slice(sql.indexOf("FOREACH"), sql.indexOf("END LOOP"));
    expect(unschedules).not.toContain("'portal-collect-pending'");
    expect(unschedules).not.toContain("'portal-collect-pending-drain'");
    expect(unschedules).not.toContain("'expire-stale-scrape-jobs'");
    expect(sql).not.toMatch(/cron\.schedule\(\s*'portal-collect-pending'/);
    expect(health).toContain('jobname: "portal-collect-pending"');
    expect(health).toContain('jobname: "portal-collect-pending-drain"');
    expect(health).toContain('jobname: "expire-stale-scrape-jobs"');
    expect(health).toContain('jobname: "portal-subito-promote"');
    expect(health).toContain('jobname: "apify-subito-weekly"');
    expect(health).toContain('"*/15 * * * *"');
  });

  it("keeps subito nightly on live Core and schedules promote after launch", () => {
    expect(sql).toContain("/functions/v1/cron-apify-subito-nightly");
    expect(sql).toContain("'20 2 * * *'");
    expect(sql).toContain("/functions/v1/cron-padova-subito-promote");
    expect(sql).toContain("'50 2,3 * * *'");
  });
});
