import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  AUTOMATED_TRIGGERS,
  SOURCE_PLAN,
  assertAutomatedHaveTriggers,
  classifySourceRow,
} from "../../supabase/functions/_shared/sourceScheduler.ts";
import { runOne } from "../../supabase/functions/_shared/sourceJobs.ts";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const allSql = () =>
  readdirSync(resolve(root, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => read(`supabase/migrations/${f}`))
    .join("\n\n");

function fakeSupabase() {
  const patches: Record<string, Record<string, unknown>> = {};
  return {
    patches,
    from() {
      return {
        update(patch: Record<string, unknown>) {
          return {
            async eq(_col: string, val: string) {
              patches[val] = { ...(patches[val] ?? {}), ...patch };
              return { data: null, error: null };
            },
          };
        },
      };
    },
  };
}

describe("civiko-scheduler edge function", () => {
  const fn = read("supabase/functions/civiko-scheduler/index.ts");
  const cfg = read("supabase/config.toml");

  it("exists and is registered with verify_jwt = false", () => {
    expect(existsSync(resolve(root, "supabase/functions/civiko-scheduler/index.ts"))).toBe(true);
    expect(cfg).toContain("[functions.civiko-scheduler]");
    const block = cfg.split("[functions.civiko-scheduler]")[1] ?? "";
    expect(block.split("[functions.")[0]).toMatch(/verify_jwt\s*=\s*false/);
  });

  it("guards with CENTRAL_CORE_JOB_SECRET and never hardcodes it", () => {
    expect(fn).toMatch(/CENTRAL_CORE_JOB_SECRET/);
    expect(fn).toMatch(/x-job-secret/);
    expect(fn).toMatch(/constantTimeEqual/);
    expect(fn).toMatch(/runScheduledSources/);
    expect(fn).not.toMatch(/sk-|whsec_|eyJhbGci/);
  });

  it("writes cron_executions_log failure when sources fail", () => {
    expect(fn).toMatch(/cron_executions_log/);
    expect(fn).toMatch(/error_message/);
    expect(fn).toMatch(/status: "failure"/);
  });
});

describe("pg_cron source triggers", () => {
  const sql = read("supabase/migrations/20260819180000_civiko_scheduler_crons.sql");
  const all = allSql();

  it("schedules daily + weekly scheduler and dedicated F5/F11/F19 jobs on live Core", () => {
    expect(sql).toContain("jpunnzgixcghuydstdlt");
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS pg_cron");
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS pg_net");
    expect(sql).toContain("civiko-scheduler-daily");
    expect(sql).toContain("civiko-scheduler-weekly");
    expect(sql).toContain("connector-osm-cantieri-weekly");
    expect(sql).toContain("civiko-pnrr-padova-weekly");
    expect(sql).toContain("civiko-obituaries-aggregate-daily");
    expect(sql).toContain("/functions/v1/civiko-scheduler/run-scheduled");
    expect(sql).toContain("log_cron_http_invocation");
  });

  it("does not schedule Catasto or Conservatoria", () => {
    expect(sql).not.toContain("civiko-premium-catasto");
    expect(sql).not.toContain("civiko-premium-conservatoria");
  });

  it("every AUTOMATED_TRIGGERS cron_job is scheduled somewhere", () => {
    assertAutomatedHaveTriggers();
    for (const t of Object.values(AUTOMATED_TRIGGERS)) {
      expect(all).toContain(`'${t.cron_job}'`);
    }
  });
});

describe("GitHub Actions scheduler fallback", () => {
  const yml = read(".github/workflows/cron-source-scheduler.yml");

  it("curls civiko-scheduler with Actions secrets, never hardcoded", () => {
    expect(yml).toContain("secrets.SUPABASE_URL");
    expect(yml).toContain("secrets.CENTRAL_CORE_JOB_SECRET");
    expect(yml).toContain("civiko-scheduler/run-scheduled");
    expect(yml).toContain("x-job-secret");
    expect(yml).not.toMatch(/x-job-secret:\s*['"][^$]/);
    expect(yml).not.toMatch(/sk-|whsec_|eyJhbGci/);
  });
});

describe("core-cron-health-public — useful status, still secret-gated", () => {
  const health = read("supabase/functions/core-cron-health-public/index.ts");

  it("keeps Checkpoint 1A diagnostic guard (401 without secret is expected)", () => {
    expect(health).toMatch(/requireDiagnosticSecret/);
    expect(health).toMatch(/x-diagnostic-secret/);
  });

  it("monitors scheduler + dedicated source crons", () => {
    expect(health).toContain('jobname: "civiko-scheduler-daily"');
    expect(health).toContain('jobname: "civiko-scheduler-weekly"');
    expect(health).toContain('jobname: "connector-osm-cantieri-weekly"');
    expect(health).toContain('jobname: "civiko-obituaries-aggregate-daily"');
    expect(health).toContain('jobname: "expire-stale-scrape-jobs"');
    expect(health).toContain('jobname: "portal-collect-pending-drain"');
    expect(health).toContain('jobname: "portal-subito-promote"');
    expect(health).toContain('jobname: "apify-subito-weekly"');
    expect(health).toContain('jobname: "central-core-radar-arpav-weekly"');
    expect(health).toContain('jobname: "central-core-radar-ckan-weekly"');
    expect(health).toContain('jobname: "central-core-radar-aste-daily"');
    expect(health).toContain('"*/15 * * * *"');
  });

  it("reports fonti_scheduler with last_error and query failures", () => {
    expect(health).toMatch(/fonti_scheduler/);
    expect(health).toMatch(/classifySourceRow/);
    expect(health).toMatch(/last_error/);
    expect(health).toMatch(/civiko_source_registry/);
    expect(health).toMatch(/diagnostics_errors/);
    expect(health).toMatch(/fonti_read_error/);
  });
});

describe("connector-status — machine auth + last_error", () => {
  const code = read("supabase/functions/connector-status/index.ts");

  it("accepts x-job-secret or x-diagnostic-secret in addition to admin JWT", () => {
    expect(code).toMatch(/x-job-secret/);
    expect(code).toMatch(/x-diagnostic-secret/);
    expect(code).toMatch(/CENTRAL_CORE_JOB_SECRET/);
    expect(code).toMatch(/machineAuthorized/);
    expect(code).toMatch(/Unauthorized/);
  });

  it("exposes failed_sources, last_error, and registry read errors", () => {
    expect(code).toMatch(/failed_sources/);
    expect(code).toMatch(/classifySourceRow/);
    expect(code).toMatch(/last_error/);
    expect(code).toMatch(/sources_read_error/);
  });
});

describe("docs/civiko-source-scheduler.md alignment", () => {
  const doc = read("docs/civiko-source-scheduler.md");

  it("catalogs F1..F22 and documents 401 as expected without secrets", () => {
    for (let i = 1; i <= 22; i++) expect(doc).toMatch(new RegExp(`\\|\\s*F${i}\\b`));
    expect(doc).toMatch(/401 without the secret is expected/i);
    expect(doc).toContain("civiko-obituaries-aggregate");
    expect(doc).toContain("cron-source-scheduler.yml");
  });
});

describe("runOne — last_error + next_run_at", () => {
  it("failed fetch writes last_error and next_run_at", async () => {
    const supabase = fakeSupabase();
    const r = await runOne(SOURCE_PLAN.F5, {
      supabase,
      baseUrl: "https://x.test",
      jobSecret: "s",
      secrets: { SUPABASE_SERVICE_ROLE_KEY: "srv" },
      attachEvidenceWriter: false,
      fetchImpl: () => Promise.reject(new Error("network down")),
    });
    expect(r.status).toBe("failed");
    expect(supabase.patches.F5.last_error).toMatch(/network down/);
    expect(supabase.patches.F5.next_run_at).toBeTruthy();
  });

  it("missing AI_CORE_SECRET_CIVIKO records last_error for F2", async () => {
    const supabase = fakeSupabase();
    const r = await runOne(SOURCE_PLAN.F2, {
      supabase,
      baseUrl: "https://x.test",
      jobSecret: "s",
      attachEvidenceWriter: false,
      fetchImpl: () => Promise.reject(new Error("should not fetch")),
    });
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("missing_AI_CORE_SECRET_CIVIKO");
    expect(supabase.patches.F2.last_error).toBe("missing_AI_CORE_SECRET_CIVIKO");
  });

  it("classifySourceRow treats empty last_error as healthy when fresh", () => {
    expect(classifySourceRow({
      last_run_at: new Date().toISOString(),
      last_success_at: new Date().toISOString(),
      last_error: "   ",
      stale_after_days: 30,
    })).toBe("SANO");
  });
});
