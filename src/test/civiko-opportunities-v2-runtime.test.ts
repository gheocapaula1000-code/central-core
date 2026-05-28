// Regression tests for civiko-agency-opportunities-v2 runtime safety.
// Validates:
//   1. buildResponseData never throws on null/empty input
//   2. Defensive defaults match the documented contract
//   3. c:/mz: entities never leak into deal_opportunities
//   4. Response payload is JSON-serialisable (no BigInt / circular refs)
//   5. Controlled error envelope shape

import { describe, it, expect } from "vitest";
import {
  buildResponseData,
  buildControlledErrorBody,
  DEFAULT_AUDIT,
  EMPTY_PAYLOAD,
} from "../../supabase/functions/civiko-agency-opportunities-v2/response.ts";
import {
  runOpportunityAudit,
  type AgencyArea,
} from "../../supabase/functions/civiko-agency-opportunities-v2/audit.ts";
import {
  buildEvidenceRow,
  type EvidenceRow,
} from "../../supabase/functions/_shared/evidenceLedger.ts";

const arcellaAreas: AgencyArea[] = [
  { agency_id: "a1", user_id: null, comuni: ["Padova"], microzones: ["Arcella"], quartieri: [] },
];

describe("civiko-agency-opportunities-v2 runtime safety", () => {
  it("buildResponseData survives null result", () => {
    const data = buildResponseData(null, []);
    expect(data.focus_area).toEqual([]);
    expect(data.hot_microzones).toEqual([]);
    expect(data.commercial_actions).toEqual([]);
    expect(data.deal_opportunities).toEqual([]);
    expect(data.opportunities).toEqual([]);
    expect(data.audit).toBeDefined();
    expect(data.data_status).toBe("empty");
  });

  it("buildResponseData survives undefined arrays inside result", () => {
    const data = buildResponseData({} as never, arcellaAreas);
    expect(Array.isArray(data.focus_area)).toBe(true);
    expect(Array.isArray(data.hot_microzones)).toBe(true);
    expect(Array.isArray(data.deal_opportunities)).toBe(true);
    expect(data.scope.comuni).toContain("Padova");
  });

  it("buildResponseData survives malformed areaList", () => {
    expect(() => buildResponseData(null, undefined as unknown as AgencyArea[])).not.toThrow();
    expect(() => buildResponseData(null, [null as unknown as AgencyArea])).not.toThrow();
  });

  it("does not throw on empty evidence", () => {
    const result = runOpportunityAudit([], arcellaAreas);
    expect(() => buildResponseData(result, arcellaAreas)).not.toThrow();
    const data = buildResponseData(result, arcellaAreas);
    expect(data.deal_opportunities.length).toBe(0);
    expect(data.empty_reason).toBeTruthy();
  });

  it("does not throw on area-only insights (c:/mz:)", () => {
    const rows: EvidenceRow[] = [
      buildEvidenceRow({
        entity_type: "comune",
        entity_key: "c:padova",
        source_code: "F1",
        evidence_type: "area_score",
        evidence_value: { score: 70 },
        confidence: 0.8,
        observed_at: new Date().toISOString(),
        compliance_visibility: "public",
      }),
      buildEvidenceRow({
        entity_type: "microzone",
        entity_key: "mz:padova:arcella",
        source_code: "F1",
        evidence_type: "area_score",
        evidence_value: { score: 65 },
        confidence: 0.8,
        observed_at: new Date().toISOString(),
        compliance_visibility: "public",
      }),
    ];
    const result = runOpportunityAudit(rows, arcellaAreas);
    const data = buildResponseData(result, arcellaAreas);
    // c:/mz: MUST NOT leak into deal_opportunities
    const dealKeys = data.deal_opportunities.map((d) => (d as { entity_key: string }).entity_key);
    expect(dealKeys.every((k) => !k.startsWith("c:") && !k.startsWith("mz:"))).toBe(true);
    expect(data.opportunities.length).toBe(data.deal_opportunities.length);
  });

  it("response payload is JSON-serialisable", () => {
    const result = runOpportunityAudit([], arcellaAreas);
    const data = buildResponseData(result, arcellaAreas);
    expect(() => JSON.stringify({ ok: true, data })).not.toThrow();
    const round = JSON.parse(JSON.stringify(data));
    expect(round.data_status).toBe(data.data_status);
  });

  it("EMPTY_PAYLOAD matches documented defaults", () => {
    expect(EMPTY_PAYLOAD.focus_area).toEqual([]);
    expect(EMPTY_PAYLOAD.hot_microzones).toEqual([]);
    expect(EMPTY_PAYLOAD.commercial_actions).toEqual([]);
    expect(EMPTY_PAYLOAD.deal_opportunities).toEqual([]);
    expect(EMPTY_PAYLOAD.opportunities).toEqual([]);
    expect(EMPTY_PAYLOAD.audit).toEqual(DEFAULT_AUDIT);
    expect(DEFAULT_AUDIT.area_insights_count).toBe(0);
    expect(DEFAULT_AUDIT.commercial_actions_count).toBe(0);
    expect(DEFAULT_AUDIT.deal_candidates_before_filters).toBe(0);
    expect(DEFAULT_AUDIT.final_deal_opportunities_count).toBe(0);
  });

  it("controlled error envelope shape is JSON-safe", () => {
    const envelope = {
      ok: false,
      data_status: "error",
      error_code: "OPPORTUNITY_V2_RUNTIME_ERROR",
      message: "Non riesco a caricare le opportunità in questo momento.",
      debug_id: "test-debug-id",
      ...EMPTY_PAYLOAD,
    };
    expect(() => JSON.stringify(envelope)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(envelope));
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("OPPORTUNITY_V2_RUNTIME_ERROR");
    expect(parsed.debug_id).toBe("test-debug-id");
    expect(parsed.deal_opportunities).toEqual([]);
  });
});
