import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("ISTAT monthly cron — allowlisted first slice", () => {
  const sql = read("supabase/migrations/20260817140000_istat_sdmx_monthly_cron.sql");
  const health = read("supabase/functions/core-cron-health-public/index.ts");
  const istat = read("supabase/functions/istat-sdmx-fetch/index.ts");
  const cfg = read("supabase/config.toml");

  it("schedules one job that POSTs istat-sdmx-fetch on live Core", () => {
    expect(sql).toContain("'istat-sdmx-monthly'");
    expect(sql).toContain("'0 4 1 * *'");
    expect(sql).toContain("/functions/v1/istat-sdmx-fetch");
    expect(sql).toContain("jpunnzgixcghuydstdlt");
    expect(sql).not.toContain("egjvullvkwpzyyworeml");
    expect(sql).toContain("log_cron_http_invocation");
  });

  it("does not schedule portals, Catasto, Conservatoria, civici, OSM, or civiko-scheduler", () => {
    expect(sql).not.toContain("/functions/v1/cron-apify-");
    expect(sql).not.toContain("civiko-premium-catasto");
    expect(sql).not.toContain("civiko-premium-conservatoria");
    expect(sql).not.toContain("padova-civici-ingest");
    expect(sql).not.toContain("connector-osm-cantieri");
    expect(sql).not.toContain("/functions/v1/civiko-scheduler");
    expect(sql).not.toContain("civiko-radar-veneto");
  });

  it("CORE_JOBS includes istat-sdmx-monthly", () => {
    expect(health).toContain('jobname: "istat-sdmx-monthly"');
    expect(health).toContain('"0 4 1 * *"');
  });

  it("istat-sdmx-fetch accepts x-job-secret or existing requireSecret", () => {
    expect(istat).toContain("x-job-secret");
    expect(istat).toContain("CENTRAL_CORE_JOB_SECRET");
    expect(istat).toContain("requireSecret");
  });

  it("ISTAT slice itself does not stand up civiko-scheduler", () => {
    expect(sql).not.toContain("/functions/v1/civiko-scheduler");
    expect(sql).not.toContain("[functions.civiko-scheduler]");
    expect(cfg).toContain("[functions.istat-sdmx-fetch]");
    expect(cfg).toContain('project_id = "jpunnzgixcghuydstdlt"');
  });
});
