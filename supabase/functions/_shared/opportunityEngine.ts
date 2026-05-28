// _shared/opportunityEngine.ts
// Evidence-driven opportunity builder. Consumes civiko_evidence rows for a
// single entity_key and produces an agency-safe opportunity envelope using
// the existing scoringOrchestration corroboration rules.
//
// Hard contracts enforced here:
//   - Restricted / aggregate_only evidence is stripped from the agency-facing
//     output. It still contributes to scoring (counts as corroboration) but is
//     never serialised in the explanation bullets.
//   - High-confidence opportunities require at least 2 independent source
//     families and at least one non-weak source.
//   - F19 (and any FORBIDDEN_SOLO_SOURCES) can never drive an opportunity alone.
//   - Returns null when evidence is insufficient — "meglio assente che fragile".

import type { EvidenceRow, ComplianceVisibility } from "./evidenceLedger.ts";
import {
  scoreOpportunity,
  SOURCE_STRENGTH,
  FORBIDDEN_SOLO_SOURCES,
  MIN_SOURCES_FOR_STRONG,
} from "./scoringOrchestration.ts";

export type Audience = "internal" | "agency" | "owner";

/** Per-source family classification used for "independent source families" math. */
export const SOURCE_FAMILY: Record<string, string> = {
  F1: "official_market",   F12: "official_market",   F17: "official_market",
  F2: "demographics",      F4:  "demographics",      F20: "demographics",
  F3: "mobility",
  F5: "open_geo",          F6:  "open_geo",          F7:  "open_geo",
  F8: "infrastructure",    F9:  "infrastructure",
  F10:"public_works",      F11: "public_works",
  F13:"portal_market",     F21: "portal_market",
  F14:"premium_records",   F15: "premium_records",
  F16:"auctions",
  F18:"permits",
  F19:"sensitive_aggregate", F22:"sensitive_aggregate",
};

export interface OpportunityEvidenceSummary {
  source_count: number;
  source_families: string[];
  confidence: "low" | "medium" | "high";
  score: number;
  freshness_days: number | null;
  explanation_bullets: string[];
  contributing_sources: string[];
  warnings: string[];
}

export interface OpportunityFromEvidence {
  entity_type: EvidenceRow["entity_type"];
  entity_key: string;
  audience: Audience;
  evidence_summary: OpportunityEvidenceSummary;
}

/** Strip rows the given audience must never see. Internal sees everything. */
export function filterEvidenceForAudience(rows: EvidenceRow[], audience: Audience): EvidenceRow[] {
  if (audience === "internal") return rows.slice();
  const allowed = new Set<ComplianceVisibility>(
    audience === "owner" ? ["public"] : ["public", "admin_only"],
  );
  return rows.filter((r) => allowed.has(r.compliance_visibility));
}

function independentFamilies(rows: EvidenceRow[]): string[] {
  const fams = new Set<string>();
  for (const r of rows) {
    const f = SOURCE_FAMILY[r.source_code] ?? `unknown:${r.source_code}`;
    fams.add(f);
  }
  return [...fams];
}

function freshestDays(rows: EvidenceRow[]): number | null {
  const ds = rows
    .map((r) => (typeof r.freshness_days === "number" ? r.freshness_days : null))
    .filter((d): d is number => d != null);
  return ds.length === 0 ? null : Math.min(...ds);
}

/**
 * Build an opportunity envelope from evidence. Returns null when:
 *   - no evidence remains after compliance filtering for this audience
 *   - the only evidence is from forbidden-solo sources
 *   - high-confidence requested but corroboration is insufficient
 */
export function buildOpportunityFromEvidence(
  entity_type: EvidenceRow["entity_type"],
  entity_key: string,
  evidence: EvidenceRow[],
  audience: Audience = "agency",
): OpportunityFromEvidence | null {
  // 1) Score using ALL evidence (sensitive sources still corroborate internally).
  const scored = scoreOpportunity(evidence);

  // 2) Build presentation set with audience-safe rows only.
  const visible = filterEvidenceForAudience(evidence, audience);
  if (visible.length === 0) return null;

  // 3) Solo-forbidden guard at the visible layer too.
  const visibleCodes = new Set(visible.map((r) => r.source_code));
  const onlyForbidden = visible.length > 0 && [...visibleCodes].every((c) => FORBIDDEN_SOLO_SOURCES.has(c));
  if (onlyForbidden) return null;

  // 4) Family-independence guard: high requires ≥2 families AND ≥1 non-weak.
  const families = independentFamilies(visible);
  const hasNonWeak = [...visibleCodes].some((c) => (SOURCE_STRENGTH[c] ?? "weak") !== "weak");
  let confidence = scored.confidence;
  if (confidence === "high" && (families.length < MIN_SOURCES_FOR_STRONG || !hasNonWeak)) {
    confidence = "medium";
  }

  const bullets = visible.map(
    (r) => `[${r.source_code}/${r.confidence}] ${r.explanation}`,
  );

  return {
    entity_type,
    entity_key,
    audience,
    evidence_summary: {
      source_count: visibleCodes.size,
      source_families: families,
      confidence,
      score: scored.score,
      freshness_days: freshestDays(visible),
      explanation_bullets: bullets,
      contributing_sources: [...visibleCodes],
      warnings: scored.warnings,
    },
  };
}
