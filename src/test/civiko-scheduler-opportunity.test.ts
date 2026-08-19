import { describe, it, expect } from "vitest";
import {
  runScheduledSources,
  runOne,
  isDue,
  eligibleSourcePlans,
  FORBIDDEN_SCHEDULER_CODES,
} from "../../supabase/functions/_shared/sourceJobs.ts";
import { SOURCE_PLAN } from "../../supabase/functions/_shared/sourceScheduler.ts";
import {
  buildOpportunityFromEvidence,
  filterEvidenceForAudience,
  SOURCE_FAMILY,
} from "../../supabase/functions/_shared/opportunityEngine.ts";
import type { EvidenceRow } from "../../supabase/functions/_shared/evidenceLedger.ts";

// ── Supabase stub: captures .update() patches per source_code ────────────
function fakeSupabase(initialRows: Array<{ source_code: string; last_run_at: string | null }> = []) {
  const patches: Record<string, Record<string, unknown>> = {};
  return {
    patches,
    from(_table: string) {
      const select = {
        select(_cols?: string) { return select; },
        then(onFulfilled: (v: unknown) => unknown) {
          return Promise.resolve({ data: initialRows, error: null }).then(onFulfilled);
        },
      };
      return {
        select(cols?: string) { return select.select(cols); },
        update(patch: Record<string, unknown>) {
          return {
            async eq(col: string, val: string) {
              if (col === "source_code") {
                patches[val] = { ...(patches[val] ?? {}), ...patch };
              }
              return { data: null, error: null };
            },
          };
        },
      };
    },
  };
}

const ev = (
  source_code: string,
  confidence: "low" | "medium" | "high" = "medium",
  compliance_visibility: EvidenceRow["compliance_visibility"] = "admin_only",
  explanation = `e ${source_code}`,
): EvidenceRow => ({
  entity_type: "opportunity",
  entity_key: "op:test",
  source_code,
  evidence_type: "x",
  evidence_value: null,
  confidence,
  freshness_days: 7,
  observed_at: new Date().toISOString(),
  explanation,
  raw_ref_id: null,
  compliance_visibility,
});

// ───────────────────────────────────────────────────────────── runner
describe("sourceJobs.eligibleSourcePlans — never schedules F14/F15", () => {
  const plans = eligibleSourcePlans();
  const codes = new Set(plans.map((p) => p.code));
  it("excludes premium_on_demand F14/F15", () => {
    expect(codes.has("F14")).toBe(false);
    expect(codes.has("F15")).toBe(false);
  });
  it("FORBIDDEN_SCHEDULER_CODES has F14 and F15", () => {
    expect(FORBIDDEN_SCHEDULER_CODES.has("F14")).toBe(true);
    expect(FORBIDDEN_SCHEDULER_CODES.has("F15")).toBe(true);
  });
  it("includes known automated sources F2, F5, F11, F16, F19, F21", () => {
    for (const c of ["F2", "F5", "F11", "F16", "F19", "F21"]) {
      expect(codes.has(c), `${c} missing from eligible plans`).toBe(true);
    }
  });
});

describe("sourceJobs.runOne — outcome contracts", () => {
  it("manual_fallback returns skipped without calling fetch", async () => {
    let called = false;
    const supabase = fakeSupabase();
    const result = await runOne(SOURCE_PLAN.F1, {
      supabase, baseUrl: "https://x.test", jobSecret: "s",
      fetchImpl: () => { called = true; return Promise.resolve(new Response("{}")); },
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("manual_fallback");
    expect(called).toBe(false);
    expect(supabase.patches.F1).toBeUndefined();
  });

  it("dry_run never mutates and never calls fetch", async () => {
    let called = false;
    const supabase = fakeSupabase();
    const result = await runOne(
      SOURCE_PLAN.F2,
      { supabase, baseUrl: "https://x.test", jobSecret: "s",
        fetchImpl: () => { called = true; return Promise.resolve(new Response("{}")); } },
      { dry_run: true },
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("dry_run");
    expect(called).toBe(false);
    expect(supabase.patches.F2).toBeUndefined();
  });

  it("F14/F15 are blocked even if forced through runOne", async () => {
    const supabase = fakeSupabase();
    const r = await runOne(SOURCE_PLAN.F14, {
      supabase, baseUrl: "https://x.test", jobSecret: "s",
      fetchImpl: () => Promise.reject(new Error("should not fetch")),
    });
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("premium_on_demand_blocked");
  });

  it("HTTP 200 → success, updates last_success_at + record_count", async () => {
    const supabase = fakeSupabase();
    const r = await runOne(SOURCE_PLAN.F2, {
      supabase, baseUrl: "https://x.test", jobSecret: "s",
      secrets: { AI_CORE_SECRET_CIVIKO: "civiko" },
      attachEvidenceWriter: false,
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ ok: true, records_processed: 42 }), { status: 200 })),
    });
    expect(r.status).toBe("success");
    expect(r.records_processed).toBe(42);
    expect(supabase.patches.F2.last_success_at).toBeTruthy();
    expect(supabase.patches.F2.record_count).toBe(42);
    expect(supabase.patches.F2.last_error).toBeNull();
  });

  it("HTTP 500 → failed, updates last_error", async () => {
    const supabase = fakeSupabase();
    const r = await runOne(SOURCE_PLAN.F2, {
      supabase, baseUrl: "https://x.test", jobSecret: "s",
      secrets: { AI_CORE_SECRET_CIVIKO: "civiko" },
      attachEvidenceWriter: false,
      fetchImpl: () => Promise.resolve(new Response("boom", { status: 500 })),
    });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/HTTP 500/);
    expect(supabase.patches.F2.last_error).toMatch(/HTTP 500/);
    expect(supabase.patches.F2.last_success_at).toBeUndefined();
    expect(supabase.patches.F2.next_run_at).toBeTruthy();
  });

  it("fetch throw → failed and captured", async () => {
    const supabase = fakeSupabase();
    const r = await runOne(SOURCE_PLAN.F5, {
      supabase, baseUrl: "https://x.test", jobSecret: "s",
      secrets: { SUPABASE_SERVICE_ROLE_KEY: "srv" },
      attachEvidenceWriter: false,
      fetchImpl: () => Promise.reject(new Error("network down")),
    });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/network down/);
    expect(supabase.patches.F5.last_error).toMatch(/network down/);
  });
});

describe("sourceJobs.runScheduledSources — isolation + summary", () => {
  it("one failing source does not stop the others", async () => {
    const supabase = fakeSupabase();
    const fetchImpl: typeof fetch = (input) => {
      const url = String(input);
      if (url.includes("istat-sdmx-fetch")) return Promise.resolve(new Response("nope", { status: 500 }));
      return Promise.resolve(new Response(JSON.stringify({ records_processed: 1 }), { status: 200 }));
    };
    const out = await runScheduledSources(
      {
        supabase, baseUrl: "https://x.test", jobSecret: "s", fetchImpl,
        secrets: { AI_CORE_SECRET_CIVIKO: "civiko", SUPABASE_SERVICE_ROLE_KEY: "srv" },
        resolveCoords: async () => ({ lat: 45.4, lng: 11.8 }),
        attachEvidenceWriter: false,
      },
      {},
    );
    expect(out.summary.failed).toBeGreaterThanOrEqual(1);
    expect(out.summary.success).toBeGreaterThanOrEqual(1);
    expect(out.results.find((r) => r.source_code === "F2")?.status).toBe("failed");
    expect(out.results.find((r) => r.source_code === "F5")?.status).toBe("success");
  });

  it("dry_run yields all-skipped and no patches", async () => {
    const supabase = fakeSupabase();
    const out = await runScheduledSources(
      { supabase, baseUrl: "https://x.test", jobSecret: "s",
        fetchImpl: () => Promise.reject(new Error("should not be called")) },
      { dry_run: true },
    );
    expect(out.dry_run).toBe(true);
    expect(out.summary.success).toBe(0);
    expect(out.summary.failed).toBe(0);
    expect(Object.keys(supabase.patches)).toHaveLength(0);
  });

  it("source_code='F14' is rejected at runner level (returns skipped premium block)", async () => {
    const supabase = fakeSupabase();
    const out = await runScheduledSources(
      { supabase, baseUrl: "https://x.test", jobSecret: "s",
        fetchImpl: () => Promise.resolve(new Response("{}")) },
      { source_code: "F14" },
    );
    // F14 is filtered out by eligibleSourcePlans → zero results.
    expect(out.results.length).toBe(0);
  });
});

describe("sourceJobs.isDue — frequency math", () => {
  it("null last_run → due", () => {
    expect(isDue(SOURCE_PLAN.F2, null)).toBe(true);
  });
  it("recent run within frequency → not due", () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    expect(isDue(SOURCE_PLAN.F2, recent)).toBe(false); // F2 monthly
  });
  it("old run beyond frequency → due", () => {
    const old = new Date(Date.now() - 1000 * 86_400_000).toISOString();
    expect(isDue(SOURCE_PLAN.F2, old)).toBe(true);
  });
});

// ─────────────────────────────────────────── opportunity engine
describe("opportunityEngine — evidence → opportunity envelope", () => {
  it("F19 alone → null (forbidden solo source)", () => {
    const out = buildOpportunityFromEvidence("area", "area:padova:35100", [ev("F19", "high")]);
    expect(out).toBeNull();
  });

  it("single non-weak source → medium at best, never high", () => {
    const out = buildOpportunityFromEvidence("opportunity", "op:1", [ev("F16", "high")]);
    expect(out).not.toBeNull();
    expect(out!.evidence_summary.confidence).not.toBe("high");
  });

  it("two independent families with ≥1 non-weak → high confidence allowed", () => {
    const rows = [ev("F16", "high"), ev("F1", "high"), ev("F2", "medium")];
    const out = buildOpportunityFromEvidence("opportunity", "op:2", rows);
    expect(out).not.toBeNull();
    expect(out!.evidence_summary.source_families.length).toBeGreaterThanOrEqual(2);
    expect(out!.evidence_summary.confidence).toBe("high");
  });

  it("two sources in the SAME family cannot reach high (family-independence guard)", () => {
    // F13 and F21 are both portal_market — one family.
    const rows = [ev("F13", "high"), ev("F21", "high")];
    const out = buildOpportunityFromEvidence("opportunity", "op:fam", rows);
    expect(out).not.toBeNull();
    expect(out!.evidence_summary.source_families).toEqual(["portal_market"]);
    expect(out!.evidence_summary.confidence).not.toBe("high");
  });

  it("agency audience strips restricted + aggregate_only evidence from bullets", () => {
    const rows = [
      ev("F16", "high", "admin_only", "PVP auction visible"),
      ev("F14", "high", "restricted", "Catasto premium hidden"),
      ev("F19", "high", "aggregate_only", "necrologi aggregate hidden"),
    ];
    const out = buildOpportunityFromEvidence("opportunity", "op:3", rows, "agency");
    expect(out).not.toBeNull();
    const bullets = out!.evidence_summary.explanation_bullets.join("\n");
    expect(bullets).toContain("F16");
    expect(bullets).not.toContain("F14");
    expect(bullets).not.toContain("F19");
    expect(out!.evidence_summary.contributing_sources).not.toContain("F14");
    expect(out!.evidence_summary.contributing_sources).not.toContain("F19");
  });

  it("owner audience only sees public evidence", () => {
    const rows = [
      ev("F16", "high", "admin_only"),
      ev("F1",  "high", "public", "OMI semestre 2025/2"),
    ];
    const out = buildOpportunityFromEvidence("opportunity", "op:4", rows, "owner");
    expect(out).not.toBeNull();
    expect(out!.evidence_summary.contributing_sources).toEqual(["F1"]);
  });

  it("returns null when no audience-visible evidence remains", () => {
    const rows = [ev("F14", "high", "restricted"), ev("F19", "high", "aggregate_only")];
    expect(buildOpportunityFromEvidence("opportunity", "op:5", rows, "agency")).toBeNull();
  });

  it("filterEvidenceForAudience excludes restricted/aggregate_only for agency", () => {
    const rows = [
      ev("F16", "high", "admin_only"),
      ev("F14", "high", "restricted"),
      ev("F19", "high", "aggregate_only"),
    ];
    const out = filterEvidenceForAudience(rows, "agency");
    expect(out.map((r) => r.source_code)).toEqual(["F16"]);
  });

  it("SOURCE_FAMILY classifies sensitive aggregate sources together", () => {
    expect(SOURCE_FAMILY.F19).toBe("sensitive_aggregate");
    expect(SOURCE_FAMILY.F22).toBe("sensitive_aggregate");
  });
});
