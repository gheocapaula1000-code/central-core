import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildSourceRegistryPatch,
  normalizeRecordCount,
  PADOVA_CRON_COORDS,
} from "../../supabase/functions/_shared/sourceRegistryStatus.ts";
import { SOURCE_PLAN } from "../../supabase/functions/_shared/sourceScheduler.ts";
import { buildRequestPlan } from "../../supabase/functions/_shared/sourceJobs.ts";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const LIVE_REF = "jpunnzgixcghuydstdlt";

const FUNCTIONS = {
  F2: "supabase/functions/istat-sdmx-fetch/index.ts",
  F2b: "supabase/functions/connector-istat-demografia/index.ts",
  F5: "supabase/functions/connector-osm-cantieri/index.ts",
  F11: "supabase/functions/civiko-pnrr-padova/index.ts",
  F19: "supabase/functions/civiko-obituaries-aggregate/index.ts",
} as const;

describe("sourceRegistryStatus — patch contract", () => {
  it("success writes last_success_at, clears last_error, sets record_count", () => {
    const p = buildSourceRegistryPatch({
      ok: true,
      records: 42,
      now: "2026-08-19T00:00:00.000Z",
    });
    expect(p.last_run_at).toBe("2026-08-19T00:00:00.000Z");
    expect(p.last_success_at).toBe("2026-08-19T00:00:00.000Z");
    expect(p.last_error).toBeNull();
    expect(p.record_count).toBe(42);
  });

  it("failure writes last_error and record_count without last_success_at", () => {
    const p = buildSourceRegistryPatch({
      ok: false,
      records: 0,
      error: "HTTP 502 boom",
      now: "2026-08-19T00:00:00.000Z",
    });
    expect(p.last_run_at).toBeTruthy();
    expect(p.last_success_at).toBeUndefined();
    expect(p.last_error).toMatch(/HTTP 502/);
    expect(p.record_count).toBe(0);
  });

  it("writeRecordCount=false leaves record_count out (F2 demografia follow-on)", () => {
    const p = buildSourceRegistryPatch({
      ok: false,
      error: "demografia_ingest: HTTP 502",
      writeRecordCount: false,
    });
    expect(p.record_count).toBeUndefined();
    expect(p.last_error).toMatch(/demografia_ingest/);
  });

  it("truncates last_error to 500 chars", () => {
    const p = buildSourceRegistryPatch({ ok: false, error: "x".repeat(800) });
    expect(String(p.last_error).length).toBe(500);
  });

  it("normalizeRecordCount floors and rejects NaN", () => {
    expect(normalizeRecordCount(3.9)).toBe(3);
    expect(normalizeRecordCount(-4)).toBe(0);
    expect(normalizeRecordCount("nope")).toBe(0);
  });
});

describe("SOURCE_PLAN — official collectors point at real jobs", () => {
  it("F2 / F5 / F11 / F19 are automated with live edge functions", () => {
    expect(SOURCE_PLAN.F2.job).toBe("istat-sdmx-fetch");
    expect(SOURCE_PLAN.F5.job).toBe("connector-osm-cantieri");
    expect(SOURCE_PLAN.F11.job).toBe("civiko-pnrr-padova");
    expect(SOURCE_PLAN.F19.job).toBe("civiko-obituaries-aggregate");
    expect(SOURCE_PLAN.F19.ingestion_endpoint).toBe("/civiko-obituaries-aggregate");
  });

  it("F11 cron body has Padova coords without resolveCoords", () => {
    const plan = buildRequestPlan(SOURCE_PLAN.F11, {}, "job", null);
    expect("body" in plan).toBe(true);
    if ("body" in plan) {
      expect(plan.body.lat).toBe(PADOVA_CRON_COORDS.lat);
      expect(plan.body.lng).toBe(PADOVA_CRON_COORDS.lng);
    }
  });
});

describe("collection functions write civiko_source_registry status", () => {
  for (const path of Object.values(FUNCTIONS)) {
    it(`${path} writes registry status`, () => {
      const src = read(path);
      expect(src).toContain("writeSourceRegistryStatus");
      expect(src).toMatch(/civiko_source_registry|writeSourceRegistryStatus/);
      expect(src).toMatch(/records_processed/);
      expect(src).toMatch(/x-job-secret|isJobSecretAuthorized/);
    });
  }

  it("istat-sdmx-fetch writes F2 and upserts istat_comuni", () => {
    const src = read(FUNCTIONS.F2);
    expect(src).toMatch(/writeSourceRegistryStatus\([\s\S]*["']F2["']/);
    expect(src).toMatch(/upsert\([\s\S]*onConflict:\s*["']codice_istat["']/);
  });

  it("connector-osm-cantieri creates service client before job-secret path (no svc TDZ)", () => {
    const src = read(FUNCTIONS.F5);
    const svcIdx = src.indexOf("const svc = createClient");
    const jobIdx = src.indexOf("const jobSecretOk = isJobSecretAuthorized");
    expect(svcIdx).toBeGreaterThan(0);
    expect(jobIdx).toBeGreaterThan(0);
    expect(svcIdx).toBeLessThan(jobIdx);
    expect(src).toMatch(/writeSourceRegistryStatus\([\s\S]*["']F5["']/);
  });

  it("connector-istat-demografia accepts job secret and does not clobber F2 record_count", () => {
    const src = read(FUNCTIONS.F2b);
    expect(src).toContain("isJobSecretAuthorized");
    expect(src).toMatch(/writeRecordCount:\s*false/);
  });

  it("civiko-pnrr-padova defaults Padova coords for cron and writes F11", () => {
    const src = read(FUNCTIONS.F11);
    expect(src).toContain("PADOVA_CRON_COORDS");
    expect(src).toMatch(/writeSourceRegistryStatus\([\s\S]*["']F11["']/);
    expect(src).toContain("upsertEvidenceRows");
  });

  it("civiko-obituaries-aggregate writes F19 even when Firecrawl is missing", () => {
    const src = read(FUNCTIONS.F19);
    expect(src).toMatch(/firecrawl_key_missing/);
    expect(src).toMatch(/writeSourceRegistryStatus\([\s\S]*["']F19["']/);
    expect(src).toMatch(/K_ANONYMITY\s*=\s*3/);
  });
});

describe("pg_cron migration — official open-data on live Core", () => {
  const sql = read("supabase/migrations/20260819190000_official_opendata_crons.sql");

  it("targets live Core ref only", () => {
    expect(sql).toContain(LIVE_REF);
    expect(sql).not.toContain("egjvullvkwpzyyworeml");
  });

  it("schedules OSM, PNRR, obituaries, ISTAT demografia", () => {
    expect(sql).toContain("'official-osm-cantieri'");
    expect(sql).toContain("'30 4 * * 1'");
    expect(sql).toContain("/functions/v1/connector-osm-cantieri");
    expect(sql).toContain("'official-pnrr-padova'");
    expect(sql).toContain("/functions/v1/civiko-pnrr-padova");
    expect(sql).toContain("'official-obituaries-aggregate'");
    expect(sql).toContain("'30 4 * * *'");
    expect(sql).toContain("/functions/v1/civiko-obituaries-aggregate");
    expect(sql).toContain("'istat-demografia-monthly'");
    expect(sql).toContain("/functions/v1/connector-istat-demografia");
  });

  it("uses vault job secret via log_cron_http_invocation (no hardcoded secret)", () => {
    expect(sql).toContain("log_cron_http_invocation");
    expect(sql).toContain("CENTRAL_CORE_JOB_SECRET");
    expect(sql).not.toMatch(/C1v1k0C0r3/);
    expect(sql).not.toMatch(/sk_live|eyJhbGci/);
  });

  it("does not schedule Catasto, Conservatoria, civiko-scheduler, or portals", () => {
    expect(sql).not.toContain("civiko-premium-catasto");
    expect(sql).not.toContain("civiko-premium-conservatoria");
    expect(sql).not.toContain("/functions/v1/civiko-scheduler");
    expect(sql).not.toContain("cron-apify-");
  });

  it("rewires F19 registry job to civiko-obituaries-aggregate", () => {
    expect(sql).toMatch(/source_code\s*=\s*'F19'/);
    expect(sql).toContain("civiko-obituaries-aggregate");
  });

  it("unschedules the broken weekly obituaries cron that used current_setting", () => {
    expect(sql).toContain("cron-obituaries-aggregate-weekly");
  });
});

describe("GitHub Actions cron fallback", () => {
  const yml = read(".github/workflows/cron-official-opendata.yml");

  it("exists and curls the five collectors", () => {
    expect(existsSync(resolve(root, ".github/workflows/cron-official-opendata.yml"))).toBe(true);
    expect(yml).toContain("istat-sdmx-fetch");
    expect(yml).toContain("connector-istat-demografia");
    expect(yml).toContain("connector-osm-cantieri");
    expect(yml).toContain("civiko-pnrr-padova");
    expect(yml).toContain("civiko-obituaries-aggregate");
    expect(yml).toContain("x-job-secret");
    expect(yml).toContain("secrets.CENTRAL_CORE_JOB_SECRET");
    expect(yml).not.toMatch(/C1v1k0C0r3|sk_live|eyJhbGci/);
  });
});

describe("platform JWT — cron callers are not rejected at the gateway", () => {
  const cfg = read("supabase/config.toml");
  it("disables verify_jwt on the five collectors", () => {
    for (const name of [
      "istat-sdmx-fetch",
      "connector-osm-cantieri",
      "connector-istat-demografia",
      "civiko-obituaries-aggregate",
      "civiko-pnrr-padova",
    ]) {
      const block = cfg.match(new RegExp(`\\[functions\\.${name}\\]([\\s\\S]*?)(?:\\n\\[|$)`));
      expect(block, `${name} missing from config.toml`).not.toBeNull();
      expect(block![1], `${name} must disable gateway JWT`).toMatch(/verify_jwt\s*=\s*false/);
    }
  });
  it("keeps live Core project_id", () => {
    expect(cfg).toContain(`project_id = "${LIVE_REF}"`);
  });
});

describe("core-cron-health includes official open-data jobs", () => {
  const health = read("supabase/functions/core-cron-health-public/index.ts");
  for (const name of [
    "istat-sdmx-monthly",
    "istat-demografia-monthly",
    "official-osm-cantieri",
    "official-pnrr-padova",
    "official-obituaries-aggregate",
  ]) {
    it(`lists ${name}`, () => {
      expect(health).toContain(`jobname: "${name}"`);
    });
  }
});
