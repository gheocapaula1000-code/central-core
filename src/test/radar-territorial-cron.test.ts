import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildRequestPlan } from "../../supabase/functions/_shared/sourceJobs.ts";
import { SOURCE_PLAN } from "../../supabase/functions/_shared/sourceScheduler.ts";
import { resolveScheduledPersist, scheduledCollectBody } from "../../supabase/functions/civiko-radar-veneto/openData/scheduledPersist.ts";
import {
  jobsForMode,
  territorialCollectBody,
  territorialCollectHeaders,
  collectTerritorialSignals,
  TERRITORIAL_COLLECT_JOBS,
} from "../../supabase/functions/cron-radar-padova-nightly/collectTerritorial.ts";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("scheduled persist flags", () => {
  it("keeps unadorned admin POST as dry-run", () => {
    expect(resolveScheduledPersist({})).toEqual({ dryRun: true, doImport: false });
  });

  it("persists for cron / scheduler triggers", () => {
    expect(resolveScheduledPersist({ triggered_by: "pg_cron" })).toEqual({ dryRun: false, doImport: true });
    expect(resolveScheduledPersist({ triggered_by: "cron-radar-padova-full" })).toEqual({ dryRun: false, doImport: true });
    expect(resolveScheduledPersist({ triggered_by: "civiko-scheduler" })).toEqual({ dryRun: false, doImport: true });
  });

  it("explicit dryRun wins over cron trigger", () => {
    expect(resolveScheduledPersist({ triggered_by: "pg_cron", dryRun: true })).toEqual({ dryRun: true, doImport: false });
  });

  it("explicit import or dryRun:false persists", () => {
    expect(resolveScheduledPersist({ import: true })).toEqual({ dryRun: false, doImport: true });
    expect(resolveScheduledPersist({ dryRun: false })).toEqual({ dryRun: false, doImport: true });
  });

  it("scheduledCollectBody never embeds a secret", () => {
    const body = scheduledCollectBody("pg_cron");
    expect(body.dryRun).toBe(false);
    expect(body.import).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/secret|password|token/i);
  });
});

describe("source scheduler wiring for territorial collectors", () => {
  it("F7 / F10 / F16 point at real civiko-radar-veneto routes", () => {
    expect(SOURCE_PLAN.F7.ingestion_endpoint).toBe("/civiko-radar-veneto/jobs/import-arpav-air-quality");
    expect(SOURCE_PLAN.F10.ingestion_endpoint).toBe("/civiko-radar-veneto/jobs/import-veneto-open-data");
    expect(SOURCE_PLAN.F16.ingestion_endpoint).toBe("/civiko-radar-veneto/jobs/refresh-padova-auctions");
  });

  it("F7 / F10 / F16 scheduled body persists territorial writes", () => {
    for (const code of ["F7", "F10", "F16"] as const) {
      const plan = buildRequestPlan(SOURCE_PLAN[code], {}, "job", null);
      expect("body" in plan).toBe(true);
      if ("body" in plan) {
        expect(plan.body.dryRun).toBe(false);
        expect(plan.body.import).toBe(true);
        expect(plan.body.province).toEqual(["PD"]);
        expect(plan.headers["x-job-secret"]).toBe("job");
      }
    }
  });
});

describe("civiko-radar-veneto job routes + secret", () => {
  const src = read("supabase/functions/civiko-radar-veneto/index.ts");

  it("registers anac-ckan and asteGiudiziarie routes", () => {
    expect(src).toContain('"/jobs/anac-ckan"');
    expect(src).toContain('"/jobs/asteGiudiziarie"');
    expect(src).toContain('pathname.endsWith("/asteGiudiziarie")');
    expect(src).toContain("dati.anticorruzione.it");
  });

  it("authorizeJob accepts x-job-secret or x-internal-secret", () => {
    expect(src).toContain('headers.get("x-job-secret")');
    expect(src).toContain('headers.get("x-internal-secret")');
    expect(src).toContain("CENTRAL_CORE_JOB_SECRET");
    expect(src).not.toMatch(/console\.[a-z]+\([^)]*\$\{(?:JOB_SECRET|primary|providedJob|providedInternal)\}/);
  });

  it("scheduled collectors use resolveScheduledPersist", () => {
    expect(src).toContain("resolveScheduledPersist");
    expect(src).toContain("persist.doImport");
    expect(src).toContain("refreshPadovaAuctions");
  });
});

describe("nightly territorial collect", () => {
  const nightly = read("supabase/functions/cron-radar-padova-nightly/index.ts");

  it("invokes collectTerritorialSignals before agent-radar", () => {
    expect(nightly).toContain("collectTerritorialSignals");
    expect(nightly.indexOf("collectTerritorialSignals")).toBeLessThan(nightly.indexOf("await runAll("));
  });

  it("fails closed on 401 from every collector", () => {
    expect(nightly).toContain("territorial_collect_unauthorized");
    expect(nightly).toContain("auth_rejected");
  });

  it("soft skips aste; full includes aste", () => {
    expect(jobsForMode("soft").map((j) => j.slug)).toEqual(["import-arpav-air-quality", "anac-ckan"]);
    expect(jobsForMode("full").map((j) => j.slug)).toEqual([
      "import-arpav-air-quality",
      "anac-ckan",
      "asteGiudiziarie",
    ]);
  });

  it("sends persist body + job secret headers without leaking the secret", () => {
    const headers = territorialCollectHeaders("unit-test-secret");
    expect(headers["x-job-secret"]).toBe("unit-test-secret");
    expect(headers["x-internal-secret"]).toBe("unit-test-secret");
    expect(headers["x-source-app"]).toBe("central-core-cron");
    const body = territorialCollectBody("full", "cron-radar-padova-full");
    expect(body.dryRun).toBe(false);
    expect(body.import).toBe(true);
    expect(JSON.stringify({ headers: { ...headers, "x-job-secret": "***", "x-internal-secret": "***" }, body }))
      .not.toContain("unit-test-secret");
  });

  it("posts each collector with persist flags", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const out = await collectTerritorialSignals({
      supabaseUrl: "https://jpunnzgixcghuydstdlt.supabase.co",
      jobSecret: "unit-test-secret",
      mode: "full",
      triggeredBy: "cron-radar-padova-full",
      fetchImpl,
    });

    expect(out.ok).toBe(true);
    expect(out.auth_rejected).toBe(false);
    expect(seen).toHaveLength(TERRITORIAL_COLLECT_JOBS.length);
    expect(seen.map((s) => s.url)).toEqual([
      "https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/import-arpav-air-quality",
      "https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/anac-ckan",
      "https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/asteGiudiziarie",
    ]);
    for (const s of seen) {
      const headers = s.init.headers as Record<string, string>;
      expect(headers["x-job-secret"]).toBe("unit-test-secret");
      const body = JSON.parse(String(s.init.body));
      expect(body.dryRun).toBe(false);
      expect(body.import).toBe(true);
    }
  });

  it("marks auth_rejected when every collector returns 401", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: false }), { status: 401 })) as typeof fetch;
    const out = await collectTerritorialSignals({
      supabaseUrl: "https://jpunnzgixcghuydstdlt.supabase.co",
      jobSecret: "wrong",
      mode: "soft",
      triggeredBy: "cron-radar-padova-soft",
      fetchImpl,
    });
    expect(out.auth_rejected).toBe(true);
    expect(out.ok).toBe(false);
  });
});

describe("pg_cron territorial collectors on live Core", () => {
  const sql = read("supabase/migrations/20260819180000_radar_territorial_collect_cron.sql");
  const health = read("supabase/functions/core-cron-health-public/index.ts");

  it("schedules ARPAV, CKAN and aste on jpunnzgixcghuydstdlt", () => {
    expect(sql).toContain("'central-core-radar-arpav-weekly'");
    expect(sql).toContain("'central-core-radar-ckan-weekly'");
    expect(sql).toContain("'central-core-radar-aste-daily'");
    expect(sql).toContain("jpunnzgixcghuydstdlt");
    expect(sql).toContain("/jobs/import-arpav-air-quality");
    expect(sql).toContain("/jobs/anac-ckan");
    expect(sql).toContain("/jobs/asteGiudiziarie");
    expect(sql).toContain("log_cron_http_invocation");
    expect(sql).toContain('"dryRun":false');
    expect(sql).toContain('"import":true');
    expect(sql).not.toMatch(/CENTRAL_CORE_JOB_SECRET\s*=\s*'/);
    expect(sql).not.toContain("egjvullvkwpzyyworeml");
  });

  it("CORE_JOBS includes the three territorial collectors", () => {
    expect(health).toContain('jobname: "central-core-radar-arpav-weekly"');
    expect(health).toContain('jobname: "central-core-radar-ckan-weekly"');
    expect(health).toContain('jobname: "central-core-radar-aste-daily"');
    expect(health).toContain('"20 4 * * 0"');
    expect(health).toContain('"35 4 * * 0"');
    expect(health).toContain('"10 4 * * *"');
  });

  it("importers persist territorial_signals", () => {
    expect(existsSync(resolve(root, "supabase/functions/civiko-radar-veneto/openData/ckanImporter.ts"))).toBe(true);
    const ckan = read("supabase/functions/civiko-radar-veneto/openData/ckanImporter.ts");
    const arpav = read("supabase/functions/civiko-radar-veneto/openData/arpavAirImporter.ts");
    expect(ckan).toContain('from("territorial_signals")');
    expect(arpav).toContain('from("territorial_signals")');
    expect(ckan).toContain("territorial_signals_created");
    expect(arpav).toContain("territorial_signals_created");
  });
});
