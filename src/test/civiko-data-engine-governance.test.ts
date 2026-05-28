import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { SOURCE_PLAN } from "../../supabase/functions/_shared/sourceScheduler.ts";
import { scoreOpportunity } from "../../supabase/functions/_shared/scoringOrchestration.ts";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const allSql = () =>
  readdirSync(resolve(root, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => read(`supabase/migrations/${f}`))
    .join("\n\n");

describe("Source plan governance — automation honesty", () => {
  it("every automated / semi_automated source declares a real job or endpoint", () => {
    for (const p of Object.values(SOURCE_PLAN)) {
      if (p.automation_status === "automated" || p.automation_status === "semi_automated") {
        const ok = Boolean(p.job) || Boolean(p.ingestion_endpoint);
        expect(ok, `${p.code} must declare job or ingestion_endpoint`).toBe(true);
      }
    }
  });

  it("every manual_fallback source carries an automation_todo", () => {
    for (const p of Object.values(SOURCE_PLAN)) {
      if (p.automation_status === "manual_fallback") {
        expect(p.automation_todo, `${p.code} manual_fallback needs automation_todo`).toBeTruthy();
      }
    }
  });

  it("F14/F15 stay premium_on_demand without scheduler", () => {
    for (const code of ["F14", "F15"]) {
      const p = SOURCE_PLAN[code];
      expect(p.automation_status).toBe("premium_on_demand");
      expect(p.scheduler_frequency).toBe("on_demand");
      expect(p.job, `${code} must not declare a scheduler job`).toBeUndefined();
      expect(p.cross_check_enabled).toBe(false);
    }
  });

  it("F19 stays aggregate-only and out of the cross-check graph", () => {
    const p = SOURCE_PLAN.F19;
    expect(p.automation_status).toBe("automated");
    expect(p.cross_check_enabled).toBe(false);
  });
});

describe("Source registry migration — governance columns and constraints", () => {
  const sql = allSql();
  it("adds scheduler_job_name + ingestion_endpoint + cross_check_enabled + automation_todo", () => {
    expect(sql).toMatch(/scheduler_job_name\s+TEXT/i);
    expect(sql).toMatch(/ingestion_endpoint\s+TEXT/i);
    expect(sql).toMatch(/cross_check_enabled\s+BOOLEAN/i);
    expect(sql).toMatch(/automation_todo\s+TEXT/i);
  });
  it("enforces honesty: automated sources need job or endpoint", () => {
    expect(sql).toMatch(/civiko_source_registry_automation_honesty_check/);
  });
  it("enforces manual_fallback sources carry a todo or note", () => {
    expect(sql).toMatch(/civiko_source_registry_manual_todo_check/);
  });
});

describe("connector-status — exposes governance fields", () => {
  const code = read("supabase/functions/connector-status/index.ts");
  it("selects scheduler_job_name + ingestion_endpoint + cross_check_enabled + automation_todo", () => {
    expect(code).toMatch(/scheduler_job_name/);
    expect(code).toMatch(/ingestion_endpoint/);
    expect(code).toMatch(/cross_check_enabled/);
    expect(code).toMatch(/automation_todo/);
  });
});

describe("Scoring orchestration — high-confidence requires multi-source corroboration", () => {
  const now = new Date().toISOString();
  const ev = (source_code: string, confidence: "low" | "medium" | "high") => ({
    entity_type: "opportunity" as const,
    entity_key: "op:gov",
    source_code,
    evidence_type: "x",
    evidence_value: null,
    confidence,
    freshness_days: 1,
    observed_at: now,
    explanation: `e ${source_code}`,
    raw_ref_id: null,
    compliance_visibility: "admin_only" as const,
  });

  it("solo strong source cannot reach high confidence", () => {
    const out = scoreOpportunity([ev("F16", "high")]);
    expect(out.confidence).not.toBe("high");
  });

  it("two corroborating non-weak sources lift confidence to high", () => {
    const out = scoreOpportunity([ev("F16", "high"), ev("F1", "medium")]);
    expect(out.confidence).toBe("high");
    expect(out.contributing_sources.length).toBeGreaterThanOrEqual(2);
  });
});
