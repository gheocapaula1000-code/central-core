import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { SOURCE_PLAN, AUTOMATED_TRIGGERS, assertManifestComplete, assertAutomatedHaveTriggers, isStale, nextRunAfter, classifySourceRow } from "../../supabase/functions/_shared/sourceScheduler.ts";
import { buildEvidenceRow } from "../../supabase/functions/_shared/evidenceLedger.ts";
import { scoreOpportunity, SOURCE_STRENGTH, FORBIDDEN_SOLO_SOURCES } from "../../supabase/functions/_shared/scoringOrchestration.ts";
import { propertyKey, microzoneKey, areaKey } from "../../supabase/functions/_shared/entityKey.ts";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const allSql = () =>
  readdirSync(resolve(root, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => read(`supabase/migrations/${f}`))
    .join("\n\n");

describe("Source scheduler manifest — F1..F22 coverage", () => {
  it("has every F-code with an automation_status", () => {
    assertManifestComplete();
    for (let i = 1; i <= 22; i++) {
      const p = SOURCE_PLAN[`F${i}`];
      expect(p.automation_status).toBeTruthy();
      expect(p.scheduler_frequency).toBeTruthy();
    }
  });

  it("every 'automated' source declares a real job module", () => {
    for (const p of Object.values(SOURCE_PLAN)) {
      if (p.automation_status === "automated") {
        expect(p.job, `${p.code} marked automated must declare a job`).toBeTruthy();
      }
    }
  });

  it("every automated source has a real trigger aligned with the plan endpoint", () => {
    expect(() => assertAutomatedHaveTriggers()).not.toThrow();
    for (const [code, t] of Object.entries(AUTOMATED_TRIGGERS)) {
      expect(SOURCE_PLAN[code].ingestion_endpoint).toBe(t.endpoint);
      expect(t.cron_job).toBeTruthy();
      expect(t.schedule).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
    }
  });

  it("classifySourceRow surfaces last_error and never-run", () => {
    expect(classifySourceRow({ last_run_at: null, last_success_at: null, last_error: null, stale_after_days: 7 })).toBe("MAI_ESEGUITO");
    expect(classifySourceRow({ last_run_at: new Date().toISOString(), last_success_at: null, last_error: "HTTP 500", stale_after_days: 7 })).toBe("ERRORE");
    expect(classifySourceRow({
      last_run_at: new Date().toISOString(),
      last_success_at: new Date().toISOString(),
      last_error: null,
      stale_after_days: 7,
    })).toBe("SANO");
  });

  it("manual sources are honestly marked manual_fallback, not automated", () => {
    // Sources that have no real fetch in this repo:
    for (const code of ["F1", "F3", "F4", "F8", "F9", "F12", "F17", "F20", "F22"]) {
      expect(SOURCE_PLAN[code].automation_status).toBe("manual_fallback");
    }
    expect(SOURCE_PLAN.F18.automation_status).toBe("automated");
    expect(SOURCE_PLAN.F18.job).toBe("civiko-sue-padova-collect");
  });

  it("paid F14/F15 are premium_on_demand only", () => {
    for (const code of ["F14", "F15"]) {
      expect(SOURCE_PLAN[code].automation_status).toBe("premium_on_demand");
      expect(SOURCE_PLAN[code].scheduler_frequency).toBe("on_demand");
    }
  });

  it("F19 remains aggregate-only weak source", () => {
    expect(SOURCE_PLAN.F19.automation_status).toBe("automated");
    expect(SOURCE_STRENGTH.F19).toBe("weak");
    expect(FORBIDDEN_SOLO_SOURCES.has("F19")).toBe(true);
  });

  it("nextRunAfter respects frequency", () => {
    const d = nextRunAfter("daily", new Date("2026-05-28"));
    expect(d?.toISOString().startsWith("2026-05-29")).toBe(true);
    expect(nextRunAfter("on_demand")).toBeNull();
  });

  it("isStale flags expired last_success_at", () => {
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    expect(isStale(old, 30)).toBe(true);
    expect(isStale(new Date().toISOString(), 30)).toBe(false);
  });
});

describe("Source registry — automation columns + evidence table migration", () => {
  const sql = allSql();
  it("adds automation_status + scheduler_frequency + stale_after_days columns", () => {
    expect(sql).toMatch(/automation_status\s+TEXT/i);
    expect(sql).toMatch(/scheduler_frequency\s+TEXT/i);
    expect(sql).toMatch(/stale_after_days\s+INTEGER/i);
    expect(sql).toMatch(/automation_notes\s+TEXT/i);
  });
  it("constrains automation_status vocabulary", () => {
    expect(sql).toMatch(/automation_status[\s\S]*?automated[\s\S]*?manual_fallback[\s\S]*?premium_on_demand/);
  });
  it("creates civiko_evidence with compliance_visibility", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.civiko_evidence/);
    expect(sql).toMatch(/compliance_visibility[\s\S]*?aggregate_only/);
  });
  it("civiko_evidence is service-role only", () => {
    const grants = sql.split("\n").filter((l) => /GRANT[\s\S]*civiko_evidence/.test(l)).join("\n");
    expect(grants).toMatch(/TO\s+service_role/i);
    expect(grants).not.toMatch(/TO\s+anon/i);
    expect(grants).not.toMatch(/TO\s+authenticated/i);
  });
});

describe("Evidence ledger — envelope and compliance guard", () => {
  it("builds envelope with default visibility per source", () => {
    const r = buildEvidenceRow({
      entity_type: "microzone", entity_key: "mz:padova:b1",
      source_code: "F2", evidence_type: "elderly_rate",
      evidence_value: { rate: 0.18 }, confidence: "medium",
      explanation: "ISTAT 2025",
    });
    expect(r.compliance_visibility).toBe("admin_only");
    expect(r.observed_at).toBeTruthy();
  });

  it("F19 evidence defaults to aggregate_only visibility", () => {
    const r = buildEvidenceRow({
      entity_type: "area", entity_key: "area:padova:35100",
      source_code: "F19", evidence_type: "aggregate_count",
      evidence_value: { count: 7 }, confidence: "low",
      explanation: "aggregate area-level 90d window",
    });
    expect(r.compliance_visibility).toBe("aggregate_only");
  });

  it("rejects person-level fields inside evidence_value", () => {
    expect(() =>
      buildEvidenceRow({
        entity_type: "area", entity_key: "area:x", source_code: "F19",
        evidence_type: "x", evidence_value: { full_name: "Mario" },
        confidence: "low", explanation: "x",
      }),
    ).toThrow();
  });
});

describe("Scoring orchestration — multi-source corroboration", () => {
  const now = new Date().toISOString();
  const ev = (source_code: string, confidence: "low" | "medium" | "high") => ({
    entity_type: "opportunity" as const,
    entity_key: "op:x",
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

  it("F19 alone never produces a strong opportunity", () => {
    const out = scoreOpportunity([ev("F19", "high"), ev("F19", "high")]);
    expect(out.confidence).toBe("low");
    expect(out.warnings).toContain("solo_aggregate_signal_blocked");
  });

  it("single non-weak source → medium at best", () => {
    const out = scoreOpportunity([ev("F2", "high")]);
    expect(out.confidence).not.toBe("high");
  });

  it("two corroborating non-weak sources can reach high", () => {
    const out = scoreOpportunity([ev("F16", "high"), ev("F21", "high"), ev("F2", "medium")]);
    expect(out.confidence).toBe("high");
    expect(out.contributing_sources.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Entity-key resolver — stable normalisation", () => {
  it("propertyKey is stable across diacritics + casing", () => {
    const a = propertyKey({ comune: "Padova", address: "Via Roma 12", lat: 45.4064, lng: 11.8768, property_type: "appartamento" });
    const b = propertyKey({ comune: "PADOVA", address: "via  roma 12", lat: 45.4064, lng: 11.8768, property_type: "Appartamento" });
    expect(a).toBe(b);
  });
  it("microzoneKey + areaKey are deterministic", () => {
    expect(microzoneKey({ comune: "Padova", microzona: "B1" })).toBe("mz:padova:b1");
    expect(areaKey({ comune: "Padova", cap: "35100", microzona: "B1" })).toBe("area:padova:35100:b1");
  });
});

describe("connector-status — surfaces automation fields without leaking raw rows", () => {
  const code = read("supabase/functions/connector-status/index.ts");
  it("selects new automation columns", () => {
    expect(code).toMatch(/automation_status/);
    expect(code).toMatch(/scheduler_frequency/);
    expect(code).toMatch(/next_run_at/);
    expect(code).toMatch(/stale_after_days/);
  });
  it("returns automation_summary + stale_sources counters", () => {
    expect(code).toMatch(/automation_summary/);
    expect(code).toMatch(/stale_sources/);
  });
});

describe("Scheduler manifest doc exists", () => {
  it("docs/civiko-source-scheduler.md catalogs F1..F22", () => {
    const doc = read("docs/civiko-source-scheduler.md");
    for (let i = 1; i <= 22; i++) expect(doc).toMatch(new RegExp(`\\|\\s*F${i}\\b`));
  });
});
