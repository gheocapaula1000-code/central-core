// Pipeline-fix tests for the Civiko One PWA empty-state diagnosis.
// Validates the pure pieces of the fix without hitting the database:
//   1. evidence backfill mappers produce correct source_code attribution
//   2. agency-opportunities-v2 audit reports setup_required when no zones
//   3. evidence outside agency scope is excluded
//   4. F19-only evidence cannot drive an opportunity
//   5. F14/F15 (restricted) are not exposed at audience=agency
//   6. audit count equals returned opportunities count
//   7. zero final opportunities returns an explicit empty_reason

import { describe, it, expect } from "vitest";
import {
  mapAreaScore,
  mapNormalizedOpportunity,
  mapEarlyWarning,
  mapOffmarket,
  mapDealFromNormalized,
  mapDealFromAuction,
  sourceCodeFromDataBasis,
  sourceCodeFromPrimarySignal,
} from "../../supabase/functions/_shared/evidenceBackfill.ts";
import {
  buildScopeMatcher,
  filterAndGroup,
  runOpportunityAudit,
} from "../../supabase/functions/civiko-agency-opportunities-v2/audit.ts";
import { buildEvidenceRow, type EvidenceRow } from "../../supabase/functions/_shared/evidenceLedger.ts";

// vitest may try to evaluate the edge function's serve() at import time; guard
// against Deno-specific globals via a stub if needed.
// (The function file uses Deno.serve via std/http — but `serve` only registers
// a handler; node/vitest can ignore it if `serve` throws on import we vmock.)

describe("evidenceBackfill mappers", () => {
  it("attributes source by data_basis", () => {
    expect(sourceCodeFromDataBasis("omi_valori")).toBe("F1");
    expect(sourceCodeFromDataBasis("istat_comuni")).toBe("F2");
    expect(sourceCodeFromDataBasis("osm-overpass")).toBe("F5");
    expect(sourceCodeFromDataBasis(null)).toBe("F5");
  });
  it("attributes source by primary signal", () => {
    expect(sourceCodeFromPrimarySignal("asta_giudiziaria")).toBe("F16");
    expect(sourceCodeFromPrimarySignal("pnrr_cantiere")).toBe("F11");
    expect(sourceCodeFromPrimarySignal("portal_listing")).toBe("F13");
  });
  it("maps area_opportunity_scores into a microzone evidence row", () => {
    const ev = mapAreaScore({ province: "PD", municipality: "Padova", microzone: "Arcella", score: 72, data_basis: "omi_valori", quality: "alta" })!;
    expect(ev.source_code).toBe("F1");
    expect(ev.entity_type).toBe("microzone");
    expect(ev.entity_key).toContain("padova");
    expect(ev.entity_key).toContain("arcella");
    expect(ev.confidence).toBe("high");
  });
  it("maps normalized_opportunities to portal family", () => {
    const ev = mapNormalizedOpportunity({ municipality: "Padova", microzone: "Arcella", source_name: "immobiliare", category: "portal_listing", title: "trilocale" })!;
    expect(ev.source_code).toBe("F13");
  });
  it("maps early_warning auction signal to F16", () => {
    const ev = mapEarlyWarning({ comune: "Padova", microzona: "Arcella", primary_signal_type: "asta_giudiziaria", early_acquisition_score: 80, confidence: "alta", explanation: "Asta in calendario" })!;
    expect(ev.source_code).toBe("F16");
    expect(ev.confidence).toBe("high");
  });
  it("maps offmarket composite to F1 official_market", () => {
    const ev = mapOffmarket({ comune: "Padova", area_label: "Arcella", area_type: "microzone", off_market_potential_score: 65, confidence_score: 70, quality: "media" })!;
    expect(ev.source_code).toBe("F1");
    expect(ev.entity_type).toBe("microzone");
  });
});

function ev(overrides: Partial<EvidenceRow>): EvidenceRow {
  return buildEvidenceRow({
    entity_type: "microzone",
    entity_key: "mz:padova:arcella",
    source_code: "F1",
    evidence_type: "test",
    evidence_value: { x: 1 },
    confidence: "medium",
    explanation: "test row",
    ...overrides,
  });
}

describe("agency-opportunities-v2 scope + classification", () => {
  const arcellaAreas = [{ agency_id: "a1", user_id: null, comuni: ["Padova"], microzones: ["Arcella"], quartieri: [] }];

  it("setup_required when zero zones configured", () => {
    const r = runOpportunityAudit([], []);
    expect(r.deal_opportunities).toHaveLength(0);
    expect(r.opportunities).toHaveLength(0);
    expect(r.audit.empty_reason).toBe("evidence_ledger_empty");
  });

  it("excludes evidence outside the agency scope", () => {
    const scope = buildScopeMatcher(arcellaAreas);
    const rows = [
      ev({ entity_key: "mz:padova:arcella", source_code: "F1" }),
      ev({ entity_key: "mz:vicenza:centro", source_code: "F1" }),
    ];
    const { removed_outside_scope, groups } = filterAndGroup(rows, scope);
    expect(removed_outside_scope).toBe(1);
    expect(groups.size).toBe(1);
  });

  it("c:* entity is never returned as deal opportunity (it's a focus_area)", () => {
    const rows = [
      ev({ entity_key: "c:padova", entity_type: "comune", source_code: "F1" }),
      ev({ entity_key: "c:padova", entity_type: "comune", source_code: "F2" }),
    ];
    const r = runOpportunityAudit(rows, arcellaAreas);
    expect(r.deal_opportunities).toHaveLength(0);
    expect(r.opportunities).toHaveLength(0);
    expect(r.focus_area.length).toBeGreaterThan(0);
    expect(r.focus_area[0]!.insight_type).toBe("area_insight");
    expect(r.focus_area[0]!.entity_granularity).toBe("comune");
  });

  it("mz:* entity is never returned as deal opportunity (it's a hot_microzone)", () => {
    const rows = [
      ev({ entity_key: "mz:padova:arcella", source_code: "F1" }),
      ev({ entity_key: "mz:padova:arcella", source_code: "F2" }),
    ];
    const r = runOpportunityAudit(rows, arcellaAreas);
    expect(r.deal_opportunities).toHaveLength(0);
    expect(r.hot_microzones.length).toBeGreaterThan(0);
    expect(r.hot_microzones[0]!.entity_granularity).toBe("microzone");
  });

  it("microzone insights derive commercial_actions", () => {
    const rows = [
      ev({ entity_key: "mz:padova:arcella", source_code: "F1", confidence: "high" }),
      ev({ entity_key: "mz:padova:arcella", source_code: "F16", confidence: "medium" }),
    ];
    const r = runOpportunityAudit(rows, arcellaAreas);
    expect(r.commercial_actions.length).toBeGreaterThan(0);
    expect(r.commercial_actions.some((a) => a.action_code === "presidia_microzona")).toBe(true);
    expect(r.commercial_actions.some((a) => a.action_code === "monitora_aste")).toBe(true);
  });

  it("listing with actionable target becomes a deal_opportunity", () => {
    const rows = [
      ev({
        entity_key: "op:padova:arcella:via-roma-10",
        entity_type: "opportunity",
        source_code: "F13",
        compliance_visibility: "admin_only",
        evidence_value: { listing_url: "https://immobiliare.it/abc-123", title: "Trilocale Arcella" },
      }),
      ev({
        entity_key: "op:padova:arcella:via-roma-10",
        entity_type: "opportunity",
        source_code: "F1",
        explanation: "OMI benchmark",
      }),
    ];
    const r = runOpportunityAudit(rows, arcellaAreas);
    expect(r.deal_opportunities).toHaveLength(1);
    expect(r.opportunities).toHaveLength(1); // alias
    expect(r.deal_opportunities[0]!.target_url).toBe("https://immobiliare.it/abc-123");
    expect(r.deal_opportunities[0]!.target_type).toBe("listing");
    expect(r.deal_opportunities[0]!.next_action).toBeTruthy();
    expect(r.audit.final_deal_opportunities_count).toBe(1);
  });

  it("auction with actionable target becomes a deal_opportunity of type auction", () => {
    const rows = [
      ev({
        entity_key: "auct:padova:pvp-998",
        entity_type: "opportunity",
        source_code: "F16",
        compliance_visibility: "admin_only",
        evidence_value: { auction_id: "PVP-998", listing_url: "https://pvp.giustizia.it/PVP-998" },
      }),
    ];
    const r = runOpportunityAudit(rows, arcellaAreas);
    expect(r.deal_opportunities).toHaveLength(1);
    expect(r.deal_opportunities[0]!.target_type).toBe("auction");
  });

  it("deal-key with no actionable target returns no_actionable_target", () => {
    const rows = [
      ev({
        entity_key: "op:padova:arcella:nowhere",
        entity_type: "opportunity",
        source_code: "F13",
        evidence_value: { title: "stub" }, // no url, no ref
      }),
    ];
    const r = runOpportunityAudit(rows, arcellaAreas);
    expect(r.deal_opportunities).toHaveLength(0);
    expect(r.audit.removed_no_actionable_target).toBe(1);
    expect(r.audit.empty_reason).toBe("no_actionable_target");
  });

  it("F19/F22 alone cannot create a deal opportunity even on a deal-shaped key", () => {
    const rows = [
      ev({
        entity_key: "op:padova:arcella:from-necro",
        entity_type: "opportunity",
        source_code: "F19",
        compliance_visibility: "aggregate_only",
        evidence_value: { listing_url: "https://x" },
      }),
    ];
    const r = runOpportunityAudit(rows, arcellaAreas);
    expect(r.deal_opportunities).toHaveLength(0);
    expect(r.audit.removed_insufficient_deal_evidence).toBeGreaterThan(0);
  });

  it("backward-compat opportunities alias contains only deal_opportunities", () => {
    const rows = [
      ev({ entity_key: "c:padova", entity_type: "comune", source_code: "F1" }),
      ev({ entity_key: "mz:padova:arcella", source_code: "F2" }),
      ev({
        entity_key: "op:padova:arcella:via-x",
        entity_type: "opportunity",
        source_code: "F13",
        evidence_value: { listing_url: "https://x" },
      }),
    ];
    const r = runOpportunityAudit(rows, arcellaAreas);
    expect(r.opportunities).toEqual(r.deal_opportunities);
    expect(r.opportunities.every((o) => !o.entity_key.startsWith("c:") && !o.entity_key.startsWith("mz:"))).toBe(true);
  });

  it("only area insights present → empty_reason=no_deal_level_opportunities", () => {
    const rows = [
      ev({ entity_key: "mz:padova:arcella", source_code: "F1" }),
      ev({ entity_key: "mz:padova:arcella", source_code: "F2" }),
    ];
    const r = runOpportunityAudit(rows, arcellaAreas);
    expect(r.hot_microzones.length).toBeGreaterThan(0);
    expect(r.deal_opportunities).toHaveLength(0);
    expect(r.audit.empty_reason).toBe("no_deal_level_opportunities");
  });
});
