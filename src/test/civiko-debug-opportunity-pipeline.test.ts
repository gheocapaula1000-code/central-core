import { describe, it, expect } from "vitest";
import {
  buildDiagnostic,
  buildScopeMatchers,
  type AgencyScope,
} from "../../supabase/functions/civiko-debug-opportunity-pipeline/diagnostic.ts";
import type { EvidenceRow } from "../../supabase/functions/_shared/evidenceLedger.ts";

const padovaScope: AgencyScope = {
  agency_id: "ag-1",
  workspace_id: null,
  user_id: null,
  comune: "Padova",
  comuni: ["Padova"],
  microzones: ["centro storico"],
  zone_slugs: [],
  province: ["PD"],
  configured: true,
};

const emptyScope: AgencyScope = {
  agency_id: null, workspace_id: null, user_id: null,
  comune: null, comuni: [], microzones: [], zone_slugs: [], province: [],
  configured: false,
};

const registry22 = Array.from({ length: 22 }, (_, i) => ({
  source_code: `F${i + 1}`,
  automation_status: i === 0 ? "manual_fallback" : "automated",
  implementation_status: "live",
  last_run_at: null,
  last_success_at: null,
  last_error: null,
  record_count: 0,
  stale_after_days: 30,
}));

function ev(partial: Partial<EvidenceRow> & Pick<EvidenceRow, "source_code" | "entity_key">): EvidenceRow {
  return {
    entity_type: "area",
    entity_key: partial.entity_key,
    source_code: partial.source_code,
    evidence_type: partial.evidence_type ?? "test",
    evidence_value: partial.evidence_value ?? null,
    confidence: partial.confidence ?? "medium",
    freshness_days: partial.freshness_days ?? 5,
    observed_at: partial.observed_at ?? new Date().toISOString(),
    explanation: partial.explanation ?? "test",
    raw_ref_id: partial.raw_ref_id ?? null,
    compliance_visibility: partial.compliance_visibility ?? "public",
  };
}

describe("civiko-debug-opportunity-pipeline diagnostic", () => {
  it("returns setup_required when agency zones are not configured", () => {
    const r = buildDiagnostic({ scope: emptyScope, registry: registry22, evidence: [] });
    expect(r.data_status).toBe("setup_required");
    expect(r.pwa_payload.empty_reason).toBe("setup_required");
    expect(r.message).toMatch(/zone operative/);
  });

  it("exposes all pipeline stages with the expected shape", () => {
    const r = buildDiagnostic({ scope: padovaScope, registry: registry22, evidence: [] });
    expect(r).toHaveProperty("agency_scope");
    expect(r).toHaveProperty("source_registry");
    expect(r).toHaveProperty("ingestion_status");
    expect(r).toHaveProperty("evidence_status");
    expect(r).toHaveProperty("opportunity_engine");
    expect(r).toHaveProperty("pwa_payload");
    expect(r).toHaveProperty("recommended_fixes");
    expect(r.ingestion_status).toHaveLength(22);
    expect(r.source_registry.total_sources).toBe(22);
  });

  it("reports no_evidence_ingested when registry exists but evidence empty", () => {
    const r = buildDiagnostic({ scope: padovaScope, registry: registry22, evidence: [] });
    expect(r.data_status).toBe("empty");
    expect(r.pwa_payload.empty_reason).toBe("no_evidence_ingested");
    expect(r.opportunity_engine.final_opportunities_count).toBe(0);
    expect(r.recommended_fixes.some((f) => f.includes("civiko-scheduler"))).toBe(true);
  });

  it("does not generate opportunities from evidence outside agency scope", () => {
    const evidence = [
      ev({ source_code: "F1", entity_key: "area:verona:37100:centro" }),
      ev({ source_code: "F21", entity_key: "area:verona:37100:centro" }),
    ];
    const r = buildDiagnostic({ scope: padovaScope, registry: registry22, evidence });
    expect(r.evidence_status.evidence_rows_in_agency_scope).toBe(0);
    expect(r.opportunity_engine.removed_outside_scope).toBe(2);
    expect(r.opportunity_engine.final_opportunities_count).toBe(0);
    expect(r.pwa_payload.empty_reason).toBe("evidence_outside_agency_scope");
  });

  it("creates a high-confidence candidate when 2 strong families exist in scope", () => {
    const evidence = [
      ev({ source_code: "F1", entity_key: "area:padova:35100:centro storico", confidence: "high" }),
      ev({ source_code: "F16", entity_key: "area:padova:35100:centro storico", confidence: "high" }),
    ];
    const r = buildDiagnostic({ scope: padovaScope, registry: registry22, evidence });
    expect(r.evidence_status.evidence_rows_in_agency_scope).toBe(2);
    expect(r.opportunity_engine.final_opportunities_count).toBe(1);
    expect(r.opportunity_engine.confidence_distribution.high).toBe(1);
    expect(r.pwa_payload.returned_count).toBe(r.opportunity_engine.final_opportunities_count);
  });

  it("weak-only evidence does not produce a high-confidence opportunity", () => {
    // F5 + F8 are both weak but in different families (open_geo, infrastructure).
    const evidence = [
      ev({ source_code: "F5", entity_key: "area:padova:35100:centro storico" }),
      ev({ source_code: "F8", entity_key: "area:padova:35100:centro storico" }),
    ];
    const r = buildDiagnostic({ scope: padovaScope, registry: registry22, evidence });
    expect(r.opportunity_engine.confidence_distribution.high ?? 0).toBe(0);
    expect(r.opportunity_engine.removed_weak_only).toBeGreaterThan(0);
    expect(r.opportunity_engine.final_opportunities_count).toBe(0);
    expect(r.pwa_payload.empty_reason).toBe("only_weak_aggregate_sources");
  });

  it("F19 alone never creates an opportunity", () => {
    const evidence = [
      ev({ source_code: "F19", entity_key: "area:padova:35100:centro storico", compliance_visibility: "aggregate_only" }),
    ];
    const r = buildDiagnostic({ scope: padovaScope, registry: registry22, evidence });
    expect(r.opportunity_engine.final_opportunities_count).toBe(0);
  });

  it("source registry presence alone does not imply opportunities", () => {
    const r = buildDiagnostic({ scope: padovaScope, registry: registry22, evidence: [] });
    expect(r.source_registry.total_sources).toBe(22);
    expect(r.opportunity_engine.final_opportunities_count).toBe(0);
  });

  it("pwa_payload count matches final opportunity engine count", () => {
    const evidence = [
      ev({ source_code: "F1", entity_key: "area:padova:35100:centro storico", confidence: "high" }),
      ev({ source_code: "F21", entity_key: "area:padova:35100:centro storico" }),
      ev({ source_code: "F1", entity_key: "area:verona:37100:centro" }),
    ];
    const r = buildDiagnostic({ scope: padovaScope, registry: registry22, evidence });
    expect(r.pwa_payload.returned_count).toBe(r.opportunity_engine.final_opportunities_count);
  });

  it("buildScopeMatchers refuses to match comuni outside the agency scope", () => {
    const m = buildScopeMatchers(padovaScope);
    expect(m.matchesEntityKey("area:padova:35100:centro storico")).toBe(true);
    expect(m.matchesEntityKey("area:verona:37100:centro")).toBe(false);
    expect(m.matchesEntityKey("area:venezia:30100:cannaregio")).toBe(false);
  });
});
