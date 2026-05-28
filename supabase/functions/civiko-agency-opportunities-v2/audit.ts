// civiko-agency-opportunities-v2/audit.ts
// Pure pipeline logic — no Deno, no DB. Imported by the edge function and by
// vitest. Builds a scope matcher from agency_operating_areas and produces a
// full filter audit (candidates → removed_* → final + empty_reason).

import { buildOpportunityFromEvidence } from "../_shared/opportunityEngine.ts";
import type { EvidenceRow } from "../_shared/evidenceLedger.ts";
import { microzoneKey, comuneKey } from "../_shared/entityKey.ts";

export interface AgencyArea {
  agency_id: string | null;
  user_id: string | null;
  comuni: string[];
  microzones: string[];
  quartieri: string[];
}

export interface OpportunityAudit {
  candidates_before_filters: number;
  removed_insufficient_evidence: number;
  removed_weak_only: number;
  removed_restricted: number;
  removed_outside_scope: number;
  removed_stale: number;
  final_opportunities_count: number;
  confidence_distribution: { low: number; medium: number; high: number };
  empty_reason: string | null;
}

export interface ScopeMatcher {
  comuni: Set<string>;
  microzones: Set<string>;
  expectedKeys: Set<string>;
}

const norm = (s: string) => s.trim().toLowerCase();

export function buildScopeMatcher(areas: AgencyArea[]): ScopeMatcher {
  const comuni = new Set<string>();
  const microzones = new Set<string>();
  const expectedKeys = new Set<string>();
  for (const a of areas) {
    for (const c of a.comuni ?? []) {
      const cn = norm(c);
      if (!cn) continue;
      comuni.add(cn);
      expectedKeys.add(comuneKey({ comune: c }));
    }
    for (const mz of [...(a.microzones ?? []), ...(a.quartieri ?? [])]) {
      const mn = norm(mz);
      if (!mn) continue;
      microzones.add(mn);
      for (const c of a.comuni ?? []) {
        expectedKeys.add(microzoneKey({ comune: c, microzona: mz }));
      }
      expectedKeys.add(microzoneKey({ comune: "", microzona: mz }));
    }
  }
  return { comuni, microzones, expectedKeys };
}

export function filterAndGroup(
  rows: EvidenceRow[],
  scope: ScopeMatcher,
  staleAfterDays = 365,
): { groups: Map<string, EvidenceRow[]>; removed_outside_scope: number; removed_stale: number } {
  const groups = new Map<string, EvidenceRow[]>();
  let removed_outside_scope = 0;
  let removed_stale = 0;
  for (const r of rows) {
    const inScope = scope.expectedKeys.has(r.entity_key) ||
      [...scope.microzones].some((mz) => r.entity_key.endsWith(`:${mz}`));
    if (!inScope) { removed_outside_scope++; continue; }
    if (typeof r.freshness_days === "number" && r.freshness_days > staleAfterDays) {
      removed_stale++; continue;
    }
    const arr = groups.get(r.entity_key) ?? [];
    arr.push(r);
    groups.set(r.entity_key, arr);
  }
  return { groups, removed_outside_scope, removed_stale };
}

export function runOpportunityAudit(
  rows: EvidenceRow[],
  areas: AgencyArea[],
): { opportunities: NonNullable<ReturnType<typeof buildOpportunityFromEvidence>>[]; audit: OpportunityAudit } {
  const scope = buildScopeMatcher(areas);
  const { groups, removed_outside_scope, removed_stale } = filterAndGroup(rows, scope);

  let candidates_before_filters = 0;
  let removed_insufficient_evidence = 0;
  let removed_weak_only = 0;
  let removed_restricted = 0;
  const dist = { low: 0, medium: 0, high: 0 };
  const final: NonNullable<ReturnType<typeof buildOpportunityFromEvidence>>[] = [];

  for (const [key, group] of groups) {
    candidates_before_filters++;
    const entity_type = (group[0]?.entity_type ?? "area") as EvidenceRow["entity_type"];
    const opp = buildOpportunityFromEvidence(entity_type, key, group, "agency");
    if (!opp) {
      const hasOnlyRestricted = group.every((r) => r.compliance_visibility === "restricted" || r.compliance_visibility === "aggregate_only");
      if (hasOnlyRestricted) { removed_restricted++; continue; }
      const families = new Set(group.map((r) => r.source_code));
      if (families.size < 2) { removed_insufficient_evidence++; continue; }
      removed_weak_only++;
      continue;
    }
    dist[opp.evidence_summary.confidence]++;
    final.push(opp);
  }

  let empty_reason: string | null = null;
  if (final.length === 0) {
    if (candidates_before_filters === 0 && removed_outside_scope === 0 && rows.length === 0) {
      empty_reason = "evidence_ledger_empty";
    } else if (candidates_before_filters === 0 && removed_outside_scope > 0) {
      empty_reason = "no_evidence_inside_agency_scope";
    } else if (removed_restricted > 0 && removed_weak_only === 0 && removed_insufficient_evidence === 0) {
      empty_reason = "all_candidates_restricted";
    } else if (removed_insufficient_evidence > 0 && removed_weak_only === 0 && removed_restricted === 0) {
      empty_reason = "all_candidates_single_source";
    } else {
      empty_reason = "all_candidates_filtered";
    }
  }

  return {
    opportunities: final,
    audit: {
      candidates_before_filters,
      removed_insufficient_evidence,
      removed_weak_only,
      removed_restricted,
      removed_outside_scope,
      removed_stale,
      final_opportunities_count: final.length,
      confidence_distribution: dist,
      empty_reason,
    },
  };
}
