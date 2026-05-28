// Deal-level scope classification tests for civiko-agency-opportunities-v2.
// Verifies the new split between outside_comune, inside_comune_unmapped,
// inside_agency_zone, and zone_mismatch.

import { describe, it, expect } from "vitest";
import { runOpportunityAudit } from "../../supabase/functions/civiko-agency-opportunities-v2/audit.ts";
import { classifyDealZoneScope } from "../../supabase/functions/_shared/dealZoneScope.ts";
import { buildEvidenceRow, type EvidenceRow } from "../../supabase/functions/_shared/evidenceLedger.ts";

const arcellaAreas = [{ agency_id: "a1", user_id: null, comuni: ["Padova"], microzones: ["Arcella"], quartieri: [] }];
const padovaOnlyAreas = [{ agency_id: "a1", user_id: null, comuni: ["Padova"], microzones: [], quartieri: [] }];

function ev(overrides: Partial<EvidenceRow>): EvidenceRow {
  return buildEvidenceRow({
    entity_type: "opportunity",
    entity_key: "op:padova:abc",
    source_code: "F13",
    evidence_type: "listing",
    evidence_value: { listing_url: "https://x" },
    confidence: "medium",
    explanation: "test",
    compliance_visibility: "admin_only",
    ...overrides,
  });
}

describe("classifyDealZoneScope", () => {
  const scope = { comuni: new Set(["padova"]), microzones: new Set(["arcella"]) };

  it("outside_comune when comune segment not in agency", () => {
    const r = classifyDealZoneScope("op:vicenza:xyz", [ev({ entity_key: "op:vicenza:xyz" })], scope);
    expect(r.status).toBe("outside_comune");
  });

  it("inside_agency_zone via evidence_value.microzone", () => {
    const r = classifyDealZoneScope("op:padova:uuid", [ev({ evidence_value: { microzone: "Arcella", listing_url: "https://x" } })], scope);
    expect(r.status).toBe("inside_agency_zone");
    expect(r.matched_zone).toBe("arcella");
  });

  it("inside_agency_zone via address keyword (Arcella token)", () => {
    const r = classifyDealZoneScope("op:padova:uuid", [ev({ evidence_value: { address: "Via Tiziano Aspetti 12", listing_url: "https://x" } })], scope);
    expect(r.status).toBe("inside_agency_zone");
    expect(r.method).toBe("address_keyword");
  });

  it("inside_comune_unmapped when no microzone hint", () => {
    const r = classifyDealZoneScope("op:padova:uuid", [ev({ evidence_value: { title: "Trilocale", listing_url: "https://x" } })], scope);
    expect(r.status).toBe("inside_comune_unmapped");
  });

  it("comune_scope_only when agency has no microzones", () => {
    const r = classifyDealZoneScope("op:padova:uuid", [ev()], { comuni: new Set(["padova"]), microzones: new Set() });
    expect(r.status).toBe("comune_scope_only");
  });

  it("zone_mismatch when microzone identified but not agency's", () => {
    const r = classifyDealZoneScope("op:padova:uuid", [ev({ evidence_value: { microzone: "Centro", listing_url: "https://x" } })], scope);
    expect(r.status).toBe("zone_mismatch");
  });
});

describe("runOpportunityAudit deal-level scope counters", () => {
  it("Arcella-mapped listing survives scope", () => {
    const rows = [ev({ entity_key: "op:padova:uuid1", evidence_value: { listing_url: "https://x", microzone: "Arcella" } })];
    const r = runOpportunityAudit(rows, arcellaAreas);
    expect(r.deal_opportunities).toHaveLength(1);
    expect(r.audit.deal_rows_inside_agency_zone).toBe(1);
  });

  it("Padova listing without microzone is unmapped_within_comune (not outside_scope)", () => {
    const rows = [ev({ entity_key: "op:padova:uuid2", evidence_value: { listing_url: "https://x", title: "Trilocale" } })];
    const r = runOpportunityAudit(rows, arcellaAreas);
    expect(r.deal_opportunities).toHaveLength(0);
    expect(r.audit.deal_rows_inside_comune_unmapped).toBe(1);
    expect(r.audit.removed_unmapped_zone).toBe(1);
    expect(r.audit.removed_outside_comune).toBe(0);
    expect(r.audit.empty_reason).toBe("deals_inside_comune_unmapped_to_agency_zone");
  });

  it("listing outside Padova is removed_outside_comune", () => {
    const rows = [ev({ entity_key: "op:vicenza:uuid", evidence_value: { listing_url: "https://x" } })];
    const r = runOpportunityAudit(rows, arcellaAreas);
    expect(r.audit.removed_outside_comune).toBe(1);
    expect(r.audit.removed_outside_scope).toBeGreaterThanOrEqual(1);
  });

  it("Arcella token in address maps to arcella (low confidence)", () => {
    const rows = [ev({ entity_key: "op:padova:uuid3", evidence_value: { listing_url: "https://x", address: "via curzola 5" } })];
    const r = runOpportunityAudit(rows, arcellaAreas);
    expect(r.deal_opportunities).toHaveLength(1);
  });

  it("non-Arcella Padova listing is not forced into Arcella", () => {
    const rows = [ev({ entity_key: "op:padova:uuid4", evidence_value: { listing_url: "https://x", microzone: "Centro Storico" } })];
    const r = runOpportunityAudit(rows, arcellaAreas);
    expect(r.deal_opportunities).toHaveLength(0);
    expect(r.audit.removed_zone_mismatch).toBe(1);
  });

  it("auct:padova auction with Arcella hint survives scope", () => {
    const rows = [ev({ entity_key: "auct:padova:fp-1", source_code: "F16", evidence_value: { listing_url: "https://pvp", microzone: "Arcella" } })];
    const r = runOpportunityAudit(rows, arcellaAreas);
    expect(r.deal_opportunities).toHaveLength(1);
    expect(r.deal_opportunities[0]!.target_type).toBe("auction");
  });

  it("comune-only agency scope accepts all Padova deals regardless of microzone", () => {
    const rows = [ev({ entity_key: "op:padova:uuidX", evidence_value: { listing_url: "https://x", title: "Trilocale" } })];
    const r = runOpportunityAudit(rows, padovaOnlyAreas);
    expect(r.deal_opportunities).toHaveLength(1);
  });
});
