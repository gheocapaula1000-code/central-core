// _shared/evidenceLedger.ts
// Append-only writer for the civiko_evidence cross-source table.
// Centralises compliance defaults and confidence vocabulary so every
// caller produces the same envelope.

import { assertAggregateOnly } from "./compliance.ts";

export type EntityType = "property" | "area" | "microzone" | "comune" | "opportunity";
export type Confidence = "low" | "medium" | "high";
export type ComplianceVisibility = "public" | "admin_only" | "restricted" | "aggregate_only";

export interface EvidenceInput {
  entity_type: EntityType;
  entity_key: string;
  source_code: string;          // e.g. "F2", "F19", "F21"
  source_name?: string;         // optional human label, NOT used as join key
  evidence_type: string;        // e.g. "elderly_rate", "auction_price", "aggregate_count"
  evidence_value: unknown;      // arbitrary JSON; NO person-level fields
  confidence: Confidence;
  freshness_days?: number | null;
  observed_at?: string;         // ISO; defaults to now
  explanation: string;          // required for attribution
  raw_ref_id?: string | null;
  compliance_visibility?: ComplianceVisibility;
}

export interface EvidenceRow {
  entity_type: EntityType;
  entity_key: string;
  source_code: string;
  evidence_type: string;
  evidence_value: unknown;
  confidence: Confidence;
  freshness_days: number | null;
  observed_at: string;
  explanation: string;
  raw_ref_id: string | null;
  compliance_visibility: ComplianceVisibility;
}

/** Default visibility per source code. Sensitive sources lock down by default. */
function defaultVisibility(sourceCode: string): ComplianceVisibility {
  if (sourceCode === "F19") return "aggregate_only";
  if (sourceCode === "F14" || sourceCode === "F15") return "restricted";
  if (sourceCode === "F17" || sourceCode === "F18" || sourceCode === "F22") return "admin_only";
  return "admin_only";
}

export function buildEvidenceRow(input: EvidenceInput): EvidenceRow {
  if (!input.source_code) throw new Error("evidence: source_code required");
  if (!input.entity_key)  throw new Error("evidence: entity_key required");
  if (!input.explanation) throw new Error("evidence: explanation required");

  // Compliance guard: no person-level fields inside evidence_value.
  if (input.evidence_value && typeof input.evidence_value === "object") {
    assertAggregateOnly(input.evidence_value as Record<string, unknown>, input.source_code);
  }

  return {
    entity_type: input.entity_type,
    entity_key: input.entity_key,
    source_code: input.source_code,
    evidence_type: input.evidence_type,
    evidence_value: input.evidence_value ?? null,
    confidence: input.confidence,
    freshness_days: input.freshness_days ?? null,
    observed_at: input.observed_at ?? new Date().toISOString(),
    explanation: input.explanation,
    raw_ref_id: input.raw_ref_id ?? null,
    compliance_visibility: input.compliance_visibility ?? defaultVisibility(input.source_code),
  };
}

/** Insert one or many evidence rows via the service-role client. */
// deno-lint-ignore no-explicit-any
export async function recordEvidence(supabase: any, inputs: EvidenceInput | EvidenceInput[]) {
  const arr = Array.isArray(inputs) ? inputs : [inputs];
  const rows = arr.map(buildEvidenceRow);
  if (rows.length === 0) return { inserted: 0 };
  const { error } = await supabase.from("civiko_evidence").insert(rows);
  if (error) throw error;
  return { inserted: rows.length };
}

/**
 * Idempotent upsert keyed on (entity_type, entity_key, source_code, evidence_type).
 * Used by scheduled jobs so re-runs do not duplicate evidence rows.
 */
// deno-lint-ignore no-explicit-any
export async function upsertEvidenceRows(supabase: any, rows: EvidenceRow[]): Promise<number> {
  if (!rows.length) return 0;
  let total = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500);
    const { error } = await supabase
      .from("civiko_evidence")
      .upsert(slice, { onConflict: "entity_type,entity_key,source_code,evidence_type" });
    if (error) throw error;
    total += slice.length;
  }
  return total;
}
