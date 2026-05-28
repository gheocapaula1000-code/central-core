// _shared/scoringOrchestration.ts
// Multi-source corroboration rules.
// Strong opportunities REQUIRE evidence from at least 2 independent sources
// AND at least one non-weak signal. Single weak signals never produce
// "high" confidence outputs. F19 alone is never sufficient.

import type { EvidenceRow } from "./evidenceLedger.ts";

export type StrongnessTier = "strong" | "medium" | "weak";

/** Per-source strength used for corroboration math. Conservative by default. */
export const SOURCE_STRENGTH: Record<string, StrongnessTier> = {
  F1: "strong",   F2: "medium",   F3: "medium",   F4: "medium",
  F5: "weak",     F6: "weak",     F7: "weak",     F8: "weak",
  F9: "weak",     F10:"medium",   F11:"medium",   F12:"strong",
  F13:"medium",   F14:"strong",   F15:"strong",   F16:"strong",
  F17:"medium",   F18:"medium",
  F19:"weak",     // aggregate area-level signal only
  F20:"medium",   F21:"medium",   F22:"weak",
};

export interface OpportunityScore {
  score: number;             // 0..100
  confidence: "low" | "medium" | "high";
  contributing_sources: string[];
  reasoning: string[];
  warnings: string[];
}

export const MIN_SOURCES_FOR_STRONG = 2;
export const FORBIDDEN_SOLO_SOURCES = new Set(["F19"]);

/**
 * Compute an opportunity score from raw evidence rows, applying the
 * corroboration policy. Pure function, easy to unit-test.
 */
export function scoreOpportunity(evidence: EvidenceRow[]): OpportunityScore {
  const warnings: string[] = [];
  const reasoning: string[] = [];

  const bySource = new Map<string, EvidenceRow[]>();
  for (const e of evidence) {
    const arr = bySource.get(e.source_code) ?? [];
    arr.push(e);
    bySource.set(e.source_code, arr);
  }
  const sources = [...bySource.keys()];

  // Hard rule: a forbidden solo source (e.g. F19) cannot alone drive a score.
  const onlyForbidden = sources.length > 0 && sources.every((s) => FORBIDDEN_SOLO_SOURCES.has(s));
  if (onlyForbidden) {
    warnings.push("solo_aggregate_signal_blocked");
    return { score: 0, confidence: "low", contributing_sources: sources, reasoning: ["Only aggregate-only sources present; corroboration required."], warnings };
  }

  // Weight contributions by strength + confidence.
  const tierWeight: Record<StrongnessTier, number> = { strong: 1.0, medium: 0.6, weak: 0.25 };
  const confWeight = { high: 1.0, medium: 0.7, low: 0.4 } as const;

  let raw = 0;
  let maxPossible = 0;
  let hasNonWeak = false;
  for (const [code, rows] of bySource) {
    const tier = SOURCE_STRENGTH[code] ?? "weak";
    if (tier !== "weak") hasNonWeak = true;
    for (const r of rows) {
      const w = tierWeight[tier] * confWeight[r.confidence];
      raw += w;
      maxPossible += tierWeight.strong;
      reasoning.push(`${code} (${tier}/${r.confidence}): ${r.explanation}`);
    }
  }
  const score = maxPossible === 0 ? 0 : Math.round((raw / maxPossible) * 100);

  // Confidence escalation policy.
  let confidence: OpportunityScore["confidence"] = "low";
  if (sources.length >= MIN_SOURCES_FOR_STRONG && hasNonWeak && score >= 60) confidence = "high";
  else if (sources.length >= MIN_SOURCES_FOR_STRONG || hasNonWeak) confidence = "medium";
  else warnings.push("single_source_only");

  return { score, confidence, contributing_sources: sources, reasoning, warnings };
}
