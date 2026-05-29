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
  safeStringify,
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
// Full canonical Padova zones — used when tests need a Padova-wide scope so
// deals without a specific microzone hint are still eligible.
const ALL_PADOVA_MZ = [
  "arcella","brusegana","camin","centro storico","chiesanuova","forcellini",
  "guizza","mandria","mortise","pontevigodarzere","prato della valle",
  "sacra famiglia","sant'osvaldo","stazione","voltabarozzo",
];
const allPadovaAreas: AgencyArea[] = [
  { agency_id: "a1", user_id: null, comuni: ["Padova"], microzones: ALL_PADOVA_MZ, quartieri: ALL_PADOVA_MZ },
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
    expect(data.focus_area).toEqual([]);
    expect(Array.isArray(data.hot_microzones)).toBe(true);
    expect(Array.isArray(data.deal_opportunities)).toBe(true);
    expect(data.scope.comuni).toContain("Padova");
  });

  it("buildResponseData survives malformed areaList", () => {
    expect(() => buildResponseData(null, undefined as unknown as AgencyArea[])).not.toThrow();
    expect(() => buildResponseData(null, [null as unknown as AgencyArea])).not.toThrow();
  });

  it("missing zone_slugs column and null area arrays do not crash", () => {
    const legacyArea = {
      agency_id: "a1",
      user_id: null,
      comuni: null,
      microzones: null,
      quartieri: ["Arcella"],
    } as unknown as AgencyArea;
    const data = buildResponseData(null, [legacyArea]);
    expect(data.scope.comuni).toEqual([]);
    expect(data.scope.microzones).toEqual(["Arcella"]);
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
        confidence: "high",
        observed_at: new Date().toISOString(),
        explanation: "test", compliance_visibility: "public",
      }),
      buildEvidenceRow({
        entity_type: "microzone",
        entity_key: "mz:padova:arcella",
        source_code: "F1",
        evidence_type: "area_score",
        evidence_value: { score: 65 },
        confidence: "high",
        observed_at: new Date().toISOString(),
        explanation: "test", compliance_visibility: "public",
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

  it("evidence JSON strings and objects are both handled", () => {
    const rows: EvidenceRow[] = [
      buildEvidenceRow({
        entity_type: "opportunity",
        entity_key: "op:padova:json-string",
        source_code: "F13",
        evidence_type: "listing",
        evidence_value: JSON.stringify({ listing_url: "https://example.test/1", title: "String listing" }),
        confidence: "medium",
        explanation: "portal listing",
        compliance_visibility: "admin_only",
      }),
      buildEvidenceRow({
        entity_type: "opportunity",
        entity_key: "op:padova:json-object",
        source_code: "F13",
        evidence_type: "listing",
        evidence_value: { listing_url: "https://example.test/2", title: "Object listing" },
        confidence: "medium",
        explanation: "portal listing",
        compliance_visibility: "admin_only",
      }),
    ];
    const data = buildResponseData(runOpportunityAudit(rows, allPadovaAreas), allPadovaAreas);
    expect(data.deal_opportunities.map((d) => (d as { title: string }).title)).toContain("String listing");
    expect(data.deal_opportunities.map((d) => (d as { title: string }).title)).toContain("Object listing");
  });

  it("missing target_url does not crash and keeps listing when title/ref exists", () => {
    const rows: EvidenceRow[] = [
      buildEvidenceRow({
        entity_type: "opportunity",
        entity_key: "op:padova:no-target",
        source_code: "F13",
        evidence_type: "listing",
        evidence_value: { title: "No target" },
        confidence: "medium",
        explanation: "portal listing",
        compliance_visibility: "admin_only",
      }),
    ];
    expect(() => runOpportunityAudit(rows, allPadovaAreas)).not.toThrow();
    const result = runOpportunityAudit(rows, allPadovaAreas);
    expect(result.deal_opportunities).toHaveLength(1);
    expect(result.deal_opportunities[0]!.target_ref).toBe("op:padova:no-target");
    expect(result.deal_opportunities[0]!.title).toBe("No target");
  });

  it("BigInt and Date values are serialization safe", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const body = buildResponseData({
      focus_area: [{ count: 1n, when: new Date("2026-05-01T00:00:00Z"), circular }] as never,
    }, arcellaAreas);
    expect(() => safeStringify({ ok: true, data: body })).not.toThrow();
    const parsed = JSON.parse(safeStringify(body));
    expect(parsed.focus_area[0].count).toBe("1");
    expect(parsed.focus_area[0].when).toBe("2026-05-01T00:00:00.000Z");
  });

  it("malformed single evidence row is skipped, not endpoint failure", () => {
    const rows = [
      { entity_key: "op:padova:bad", source_code: null },
      buildEvidenceRow({
        entity_type: "microzone",
        entity_key: "mz:padova:arcella",
        source_code: "F1",
        evidence_type: "area_score",
        evidence_value: { score: 70 },
        confidence: "high",
        explanation: "area score",
        compliance_visibility: "public",
      }),
      buildEvidenceRow({
        entity_type: "microzone",
        entity_key: "mz:padova:arcella",
        source_code: "F2",
        evidence_type: "demographics",
        evidence_value: { score: 60 },
        confidence: "medium",
        explanation: "demographics",
        compliance_visibility: "public",
      }),
    ] as unknown as EvidenceRow[];
    const result = runOpportunityAudit(rows, arcellaAreas);
    expect(result.hot_microzones.length).toBeGreaterThan(0);
    expect(result.deal_opportunities).toHaveLength(0);
  });

  it("partial classification failures still return available sections", () => {
    const rows = [
      { entity_key: "op:padova:malformed", source_code: "F13", evidence_value: { listing_url: "https://x" }, confidence: "broken" },
      buildEvidenceRow({
        entity_type: "opportunity",
        entity_key: "op:padova:good",
        source_code: "F13",
        evidence_type: "listing",
        evidence_value: { listing_url: "https://example.test/good", title: "Good listing" },
        confidence: "medium",
        explanation: "portal listing",
        compliance_visibility: "admin_only",
      }),
      buildEvidenceRow({
        entity_type: "comune",
        entity_key: "c:padova",
        source_code: "F1",
        evidence_type: "area_score",
        evidence_value: { score: 70 },
        confidence: "high",
        explanation: "area score",
        compliance_visibility: "public",
      }),
      buildEvidenceRow({
        entity_type: "comune",
        entity_key: "c:padova",
        source_code: "F2",
        evidence_type: "demographics",
        evidence_value: { score: 60 },
        confidence: "medium",
        explanation: "demographics",
        compliance_visibility: "public",
      }),
    ] as unknown as EvidenceRow[];
    const result = runOpportunityAudit(rows, allPadovaAreas);
    const data = buildResponseData(result, allPadovaAreas);
    expect(Array.isArray(data.focus_area) ? data.focus_area.length : 0).toBeGreaterThan(0);
    expect(data.deal_opportunities.length).toBeGreaterThan(0);
  });

  it("EMPTY_PAYLOAD matches documented defaults", () => {
    expect(EMPTY_PAYLOAD.focus_area).toBeNull();
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
    const envelope = buildControlledErrorBody("test-debug-id", "STAGE_SCOPE", "boom", "Error");
    expect(() => JSON.stringify(envelope)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(envelope));
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("OPPORTUNITY_V2_RUNTIME_ERROR");
    expect(parsed.debug_id).toBe("test-debug-id");
    expect(parsed.error_stage).toBe("STAGE_SCOPE");
    expect(parsed.error_name).toBe("Error");
    expect(parsed.error_message).toBe("boom");
    expect(parsed.deal_opportunities).toEqual([]);
  });

  describe("intelligence enrichment", () => {
    const mkAuction = (id: string) => buildEvidenceRow({
      entity_type: "opportunity",
      entity_key: `auct:padova:${id}`,
      source_code: "F16",
      evidence_type: "auction",
      evidence_value: {
        title: `Asta ${id}`,
        listing_url: "https://www.asteimmobili.it/Aste/Detail/X",
        base_price_eur: 200000, minimum_offer_eur: 150000,
        sale_date: "2026-06-30", municipality: "Padova",
      },
      confidence: "medium", explanation: "auction", compliance_visibility: "admin_only",
    });
    const mkListing = (id: string, withUrl = true) => buildEvidenceRow({
      entity_type: "opportunity",
      entity_key: `op:padova:${id}`,
      source_code: "F13",
      evidence_type: "listing",
      evidence_value: {
        title: `Annuncio ${id}`,
        ...(withUrl ? { listing_url: "https://example.test/listing" } : {}),
        ask_price: 250000, municipality: "Padova",
      },
      confidence: "medium", explanation: "listing", compliance_visibility: "admin_only",
    });

    it("auctions get non-owner next_actions and arguments_to_avoid", () => {
      const result = runOpportunityAudit([mkAuction("a1")], allPadovaAreas);
      const d = result.deal_opportunities[0]!;
      expect(d.target_type).toBe("auction");
      const joined = (d.next_actions ?? [d.next_action]).join(" | ").toLowerCase();
      expect(joined).not.toMatch(/proprietario|owner/);
      expect(d.arguments_to_avoid).toEqual(expect.arrayContaining([
        expect.stringMatching(/proprietario/i),
      ]));
    });

    it("asteimmobili.it links flagged cookie_wall_possible", () => {
      const result = runOpportunityAudit([mkAuction("a2")], allPadovaAreas);
      expect(result.deal_opportunities[0]!.source_access).toBe("cookie_wall_possible");
    });

    it("plain external urls flagged direct", () => {
      const result = runOpportunityAudit([mkListing("l1")], allPadovaAreas);
      expect(result.deal_opportunities[0]!.source_access).toBe("direct");
    });

    it("deals carry quality_bucket and quality_reasons", () => {
      const result = runOpportunityAudit([mkAuction("a3"), mkListing("l2")], allPadovaAreas);
      for (const d of result.deal_opportunities) {
        expect(["work_today", "verify", "monitor", "low_value"]).toContain(d.quality_bucket);
        expect(Array.isArray(d.quality_reasons)).toBe(true);
        expect(d.quality_reasons.length).toBeGreaterThan(0);
      }
    });

    it("missing OMI yields null price_vs_market_label", () => {
      const result = runOpportunityAudit([mkListing("l3")], allPadovaAreas);
      expect(result.deal_opportunities[0]!.price_vs_market_label).toBeNull();
      expect(result.deal_opportunities[0]!.market_context).toBeNull();
    });

    it("commercial_actions derived when deals exist", () => {
      const result = runOpportunityAudit([mkAuction("a4"), mkListing("l4")], allPadovaAreas);
      const codes = result.commercial_actions.map((a) => a.action_code);
      expect(codes).toEqual(expect.arrayContaining(["monitora_aste", "verifica_annunci_prezzo"]));
    });

    it("focus_area derived from c:padova evidence", () => {
      const rows: EvidenceRow[] = [
        buildEvidenceRow({
          entity_type: "comune", entity_key: "c:padova", source_code: "F1",
          evidence_type: "area_score", evidence_value: { score: 70 },
          confidence: "high", explanation: "score", compliance_visibility: "public",
        }),
        buildEvidenceRow({
          entity_type: "comune", entity_key: "c:padova", source_code: "F2",
          evidence_type: "demographics", evidence_value: { score: 60 },
          confidence: "medium", explanation: "demo", compliance_visibility: "public",
        }),
        mkAuction("a5"),
      ];
      const result = runOpportunityAudit(rows, allPadovaAreas);
      expect(result.focus_area.length).toBeGreaterThan(0);
    });

    it("hot_microzones derived from deal concentration when no mz:* insights", () => {
      const rows = [
        buildEvidenceRow({
          entity_type: "opportunity",
          entity_key: "op:padova:c1",
          source_code: "F13",
          evidence_type: "listing",
          evidence_value: { title: "x", listing_url: "https://example.test/c1", microzone: "Arcella", ask_price: 100000 },
          confidence: "medium", explanation: "x", compliance_visibility: "admin_only",
        }),
        buildEvidenceRow({
          entity_type: "opportunity",
          entity_key: "op:padova:c2",
          source_code: "F13",
          evidence_type: "listing",
          evidence_value: { title: "y", listing_url: "https://example.test/c2", microzone: "Arcella", ask_price: 110000 },
          confidence: "medium", explanation: "y", compliance_visibility: "admin_only",
        }),
      ];
      const result = runOpportunityAudit(rows, allPadovaAreas);
      expect(result.hot_microzones.length).toBeGreaterThan(0);
      expect(result.hot_microzones[0]!.entity_key).toMatch(/mz:padova:arcella/);
    });
  });
});
