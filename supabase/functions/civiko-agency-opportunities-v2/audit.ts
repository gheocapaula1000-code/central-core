// civiko-agency-opportunities-v2/audit.ts
// Pure pipeline logic — no Deno, no DB. Imported by the edge function and by
// vitest. Builds a scope matcher from agency_operating_areas and produces a
// FULL classification audit that splits:
//   - focus_area          (comune-level insights)
//   - hot_microzones      (microzone-level insights)
//   - commercial_actions  (derived suggestions on top of area insights)
//   - deal_opportunities  (listing / auction / property / address / lead)
//
// HARD CONTRACTS:
//   - c:* / mz:* entities NEVER appear in deal_opportunities.
//   - deal_opportunities require an actionable target AND a deal-eligible
//     market source (F13/F14/F15/F16/F18/F21).
//   - F19/F22 alone cannot drive a deal.
//   - Restricted/aggregate-only evidence is filtered for audience=agency.
//   - Geography is bounded by the agency's configured zones — never widened.

import { buildOpportunityFromEvidence, type OpportunityFromEvidence } from "../_shared/opportunityEngine.ts";
import type { EvidenceRow } from "../_shared/evidenceLedger.ts";
import { microzoneKey, comuneKey } from "../_shared/entityKey.ts";
import {
  classifyEntityKey,
  extractActionableTarget,
  deriveCommercialActions,
  DEAL_ELIGIBLE_SOURCES,
  DEAL_FORBIDDEN_SOLO_SOURCES,
  type EntityGranularity,
  type InsightType,
} from "../_shared/opportunityClassification.ts";
import { classifyDealZoneScope, isDealKey, type DealScope } from "../_shared/dealZoneScope.ts";
import { coversFullComune } from "../_shared/comuneRegistry.ts";

export interface AgencyArea {
  agency_id: string | null;
  user_id: string | null;
  comuni: string[];
  microzones: string[];
  quartieri: string[];
}

export interface OpportunityAudit {
  // legacy fields (kept for backward compat with v2 callers)
  candidates_before_filters: number;
  removed_insufficient_evidence: number;
  removed_weak_only: number;
  removed_restricted: number;
  removed_outside_scope: number;
  removed_stale: number;
  final_opportunities_count: number;
  confidence_distribution: { low: number; medium: number; high: number };
  empty_reason: string | null;

  // new classification breakdown
  area_insights_count: number;
  commercial_actions_count: number;
  deal_candidates_before_filters: number;
  removed_area_only: number;
  removed_no_actionable_target: number;
  removed_insufficient_deal_evidence: number;
  final_deal_opportunities_count: number;

  // deal-level scope breakdown (split from removed_outside_scope so the PWA
  // can tell "outside comune" apart from "inside comune but no microzone").
  removed_outside_comune: number;
  removed_unmapped_zone: number;
  removed_zone_mismatch: number;
  deal_rows_missing_geo: number;
  deal_rows_inside_comune_unmapped: number;
  deal_rows_inside_agency_zone: number;
}

export interface ScopeMatcher {
  comuni: Set<string>;
  microzones: Set<string>;
  expectedKeys: Set<string>;
  fullComune: Set<string>;
}

export interface AreaInsight extends OpportunityFromEvidence {
  insight_type: InsightType;
  entity_granularity: EntityGranularity;
}

export interface CommercialAction {
  entity_key: string;
  entity_granularity: EntityGranularity;
  action_code: string;
  label: string;
  rationale: string;
}

export interface DealOpportunity extends OpportunityFromEvidence {
  insight_type: "deal_opportunity";
  entity_granularity: EntityGranularity;
  id: string;
  title: string;
  area_name: string | null;
  microzone: string | null;
  target_type: string;
  target_ref?: string;
  target_url?: string;
  address?: string;
  price_label: string | null;
  urgency: "low" | "medium" | "high";
  next_action: string;
  updated_at: string | null;
}

const norm = (s: string) => s.trim().toLowerCase();

export function buildScopeMatcher(areas: AgencyArea[]): ScopeMatcher {
  const comuni = new Set<string>();
  const microzones = new Set<string>();
  const expectedKeys = new Set<string>();
  for (const a of areas) {
    if (!a || typeof a !== "object") continue;
    for (const c of (Array.isArray(a.comuni) ? a.comuni : [])) {
      if (typeof c !== "string") continue;
      const cn = norm(c);
      if (!cn) continue;
      comuni.add(cn);
      expectedKeys.add(comuneKey({ comune: c }));
    }
    const configuredMicrozones = [
      ...(Array.isArray(a.microzones) ? a.microzones : []),
      ...(Array.isArray(a.quartieri) ? a.quartieri : []),
    ];
    for (const mz of configuredMicrozones) {
      if (typeof mz !== "string") continue;
      const mn = norm(mz);
      if (!mn) continue;
      microzones.add(mn);
      for (const c of (Array.isArray(a.comuni) ? a.comuni : [])) {
        if (typeof c !== "string") continue;
        expectedKeys.add(microzoneKey({ comune: c, microzona: mz }));
      }
      expectedKeys.add(microzoneKey({ comune: "", microzona: mz }));
    }
  }
  // Detect comuni whose configured zones cover the entire canonical comune.
  const configuredByComune = new Map<string, Set<string>>();
  for (const a of areas) {
    if (!a || typeof a !== "object") continue;
    const mzs = [
      ...(Array.isArray(a.microzones) ? a.microzones : []),
      ...(Array.isArray(a.quartieri) ? a.quartieri : []),
    ].filter((m): m is string => typeof m === "string" && m.trim().length > 0);
    for (const c of (Array.isArray(a.comuni) ? a.comuni : [])) {
      if (typeof c !== "string") continue;
      const cn = norm(c);
      if (!cn) continue;
      const set = configuredByComune.get(cn) ?? new Set<string>();
      for (const m of mzs) set.add(norm(m));
      configuredByComune.set(cn, set);
    }
  }
  const fullComune = new Set<string>();
  for (const [c, set] of configuredByComune) {
    if (coversFullComune(c, set)) fullComune.add(c);
  }
  return { comuni, microzones, expectedKeys, fullComune };
}

function inAreaScope(r: EvidenceRow, scope: ScopeMatcher): boolean {
  // Area-level keys: match expectedKeys directly or by microzone suffix.
  if (scope.expectedKeys.has(r.entity_key)) return true;
  if ([...scope.microzones].some((mz) => r.entity_key.endsWith(`:${mz}`))) return true;
  return false;
}

function dealComuneSeg(entity_key: string): string {
  const parts = entity_key.split(":");
  return norm(parts[1] ?? "");
}

export function filterAndGroup(
  rows: EvidenceRow[],
  scope: ScopeMatcher,
  staleAfterDays = 365,
): {
  groups: Map<string, EvidenceRow[]>;
  removed_outside_scope: number;
  removed_outside_comune: number;
  removed_stale: number;
} {
  const groups = new Map<string, EvidenceRow[]>();
  let removed_outside_scope = 0;
  let removed_outside_comune = 0;
  let removed_stale = 0;
  for (let r of rows) {
    const safeRow = sanitizeEvidenceRow(r);
    if (!safeRow) { removed_outside_scope++; continue; }
    r = safeRow;
    if (isDealKey(r.entity_key)) {
      // Deal-level keys: comune segment must belong to the agency. Microzone
      // verification happens later (per-group) in runOpportunityAudit so we
      // can distinguish inside_comune_unmapped from outside_comune.
      const comuneSeg = dealComuneSeg(r.entity_key);
      if (!comuneSeg || !scope.comuni.has(comuneSeg)) {
        removed_outside_comune++;
        removed_outside_scope++;
        continue;
      }
    } else if (!inAreaScope(r, scope)) {
      removed_outside_scope++;
      continue;
    }
    if (typeof r.freshness_days === "number" && r.freshness_days > staleAfterDays) {
      removed_stale++; continue;
    }
    const arr = groups.get(r.entity_key) ?? [];
    arr.push(r);
    groups.set(r.entity_key, arr);
  }
  return { groups, removed_outside_scope, removed_outside_comune, removed_stale };
}

export interface OpportunityAuditResult {
  focus_area: AreaInsight[];
  hot_microzones: AreaInsight[];
  commercial_actions: CommercialAction[];
  deal_opportunities: DealOpportunity[];
  /** Backward-compat alias — contains ONLY deal_opportunities, never area insights. */
  opportunities: DealOpportunity[];
  audit: OpportunityAudit;
  warnings?: string[];
}

export interface SectionFailure {
  stage: string;
  entity_key?: string;
  message: string;
}

export interface SectionRunnerOptions {
  onSectionFailure?: (failure: SectionFailure) => void;
}

export function runOpportunityAudit(
  rows: EvidenceRow[],
  areas: AgencyArea[],
  options: SectionRunnerOptions = {},
): OpportunityAuditResult {
  const scope = buildScopeMatcher(areas);
  const { groups, removed_outside_scope, removed_outside_comune, removed_stale } = filterAndGroup(rows, scope);
  const dealScope: DealScope = { comuni: scope.comuni, microzones: scope.microzones };

  const focus_area: AreaInsight[] = [];
  const hot_microzones: AreaInsight[] = [];
  const commercial_actions: CommercialAction[] = [];
  const deal_opportunities: DealOpportunity[] = [];

  let candidates_before_filters = 0;
  let removed_insufficient_evidence = 0;
  let removed_weak_only = 0;
  let removed_restricted = 0;

  let deal_candidates_before_filters = 0;
  let removed_area_only = 0;
  let removed_no_actionable_target = 0;
  let removed_insufficient_deal_evidence = 0;

  // Deal-level scope breakdown
  let removed_unmapped_zone = 0;
  let removed_zone_mismatch = 0;
  let deal_rows_missing_geo = 0;
  let deal_rows_inside_comune_unmapped = 0;
  let deal_rows_inside_agency_zone = 0;

  const dist = { low: 0, medium: 0, high: 0 };

  const warnings: string[] = [];

  for (const [key, group] of groups) {
    candidates_before_filters++;
    try {
      const { insight_type, entity_granularity } = classifyEntityKey(key);
      const entity_type = sanitizeEntityType(group[0]?.entity_type);
      const safeGroup = group.map(sanitizeEvidenceRow).filter((r): r is EvidenceRow => !!r);
      if (safeGroup.length === 0) { removed_insufficient_evidence++; continue; }
      const opp = buildOpportunityFromEvidence(entity_type, key, safeGroup, "agency");

      if (insight_type === "area_insight") {
        // Area-level: NEVER a deal. Track as insight + derive actions.
        removed_area_only++;
        if (!opp) {
          const hasOnlyRestricted = safeGroup.every((r) => r.compliance_visibility === "restricted" || r.compliance_visibility === "aggregate_only");
          if (hasOnlyRestricted) removed_restricted++;
          else if (new Set(safeGroup.map((r) => r.source_code)).size < 2) removed_insufficient_evidence++;
          else removed_weak_only++;
          continue;
        }
        const insight: AreaInsight = { ...opp, insight_type, entity_granularity };
        if (entity_granularity === "comune") focus_area.push(insight);
        else hot_microzones.push(insight);
        for (const a of deriveCommercialActions(key, entity_granularity, safeGroup)) {
          commercial_actions.push({ entity_key: key, entity_granularity, ...a });
        }
        continue;
      }

      // deal_opportunity path
      deal_candidates_before_filters++;

      // Zone-level scope verification (comune was already filtered upstream).
      const zoneCls = classifyDealZoneScope(key, safeGroup, dealScope);
      if (zoneCls.status === "inside_comune_unmapped") {
        deal_rows_inside_comune_unmapped++;
        deal_rows_missing_geo++;
        removed_unmapped_zone++;
        continue;
      }
      if (zoneCls.status === "zone_mismatch") {
        removed_zone_mismatch++;
        continue;
      }
      // inside_agency_zone OR comune_scope_only → proceed.
      deal_rows_inside_agency_zone++;

      // Forbidden-solo guard at the deal layer (F19/F22 alone never a deal).
      const codes = new Set(safeGroup.map((r) => r.source_code));
      const onlyForbidden = [...codes].every((c) => DEAL_FORBIDDEN_SOLO_SOURCES.has(c));
      if (onlyForbidden) { removed_insufficient_deal_evidence++; continue; }

      // Need at least one deal-eligible market source.
      const hasMarketSrc = [...codes].some((c) => DEAL_ELIGIBLE_SOURCES.has(c));
      if (!hasMarketSrc) { removed_insufficient_deal_evidence++; continue; }

      // Actionable target required.
      const target = extractActionableTarget(safeGroup);
      if (!target.ok) { removed_no_actionable_target++; continue; }

      if (!opp) {
        const hasOnlyRestricted = safeGroup.every((r) => r.compliance_visibility === "restricted" || r.compliance_visibility === "aggregate_only");
        if (hasOnlyRestricted) removed_restricted++;
        else removed_insufficient_deal_evidence++;
        continue;
      }

      dist[opp.evidence_summary.confidence]++;
      const meta = extractDealMeta(safeGroup);
      deal_opportunities.push({
        ...opp,
        insight_type: "deal_opportunity",
        entity_granularity,
        id: key,
        title: meta.title ?? key,
        area_name: meta.area_name,
        microzone: meta.microzone ?? zoneCls.matched_zone,
        target_type: target.target_type ?? "listing",
        target_ref: target.target_ref,
        target_url: target.target_url,
        address: target.address,
        price_label: meta.price_label,
        urgency: meta.urgency,
        next_action: nextActionFor(target.target_type ?? "listing"),
        updated_at: meta.updated_at,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`classification_skipped:${key}:${message}`);
      removed_insufficient_evidence++;
      options.onSectionFailure?.({ stage: "STAGE_CLASSIFICATION", entity_key: key, message });
      continue;
    }
  }

  let empty_reason: string | null = null;
  if (deal_opportunities.length === 0) {
    if (rows.length === 0) empty_reason = "evidence_ledger_empty";
    else if (candidates_before_filters === 0 && removed_outside_scope > 0) empty_reason = "no_evidence_inside_agency_scope";
    else if (deal_candidates_before_filters === 0) empty_reason = "no_deal_level_opportunities";
    else if (removed_unmapped_zone > 0 && deal_rows_inside_agency_zone === 0) empty_reason = "deals_inside_comune_unmapped_to_agency_zone";
    else if (removed_no_actionable_target > 0 && removed_insufficient_deal_evidence === 0) empty_reason = "no_actionable_target";
    else if (removed_restricted > 0 && removed_insufficient_deal_evidence === 0 && removed_no_actionable_target === 0) empty_reason = "all_candidates_restricted";
    else empty_reason = "no_deal_level_opportunities";
  }

  const audit: OpportunityAudit = {
    candidates_before_filters,
    removed_insufficient_evidence,
    removed_weak_only,
    removed_restricted,
    removed_outside_scope,
    removed_stale,
    final_opportunities_count: deal_opportunities.length,
    confidence_distribution: dist,
    empty_reason,

    area_insights_count: focus_area.length + hot_microzones.length,
    commercial_actions_count: commercial_actions.length,
    deal_candidates_before_filters,
    removed_area_only,
    removed_no_actionable_target,
    removed_insufficient_deal_evidence,
    final_deal_opportunities_count: deal_opportunities.length,

    removed_outside_comune,
    removed_unmapped_zone,
    removed_zone_mismatch,
    deal_rows_missing_geo,
    deal_rows_inside_comune_unmapped,
    deal_rows_inside_agency_zone,
  };

  return {
    focus_area,
    hot_microzones,
    commercial_actions,
    deal_opportunities,
    opportunities: deal_opportunities, // backward-compat alias
    audit,
    warnings,
  };
}

function sanitizeEntityType(value: unknown): EvidenceRow["entity_type"] {
  return value === "property" || value === "area" || value === "microzone" || value === "comune" || value === "opportunity"
    ? value
    : "area";
}

function sanitizeEvidenceRow(row: EvidenceRow | null | undefined): EvidenceRow | null {
  if (!row || typeof row !== "object") return null;
  const source_code = typeof row.source_code === "string" && row.source_code.trim() ? row.source_code.trim() : null;
  const entity_key = typeof row.entity_key === "string" && row.entity_key.trim() ? row.entity_key.trim() : null;
  if (!source_code || !entity_key) return null;
  return {
    entity_type: sanitizeEntityType(row.entity_type),
    entity_key,
    source_code,
    evidence_type: typeof row.evidence_type === "string" ? row.evidence_type : "unknown",
    evidence_value: row.evidence_value ?? null,
    confidence: row.confidence === "high" || row.confidence === "medium" || row.confidence === "low" ? row.confidence : "low",
    freshness_days: typeof row.freshness_days === "number" && Number.isFinite(row.freshness_days) ? row.freshness_days : null,
    observed_at: typeof row.observed_at === "string" && row.observed_at ? row.observed_at : new Date(0).toISOString(),
    explanation: typeof row.explanation === "string" && row.explanation.trim() ? row.explanation.trim() : "Evidenza disponibile.",
    raw_ref_id: typeof row.raw_ref_id === "string" ? row.raw_ref_id : null,
    compliance_visibility: row.compliance_visibility === "public" || row.compliance_visibility === "admin_only" || row.compliance_visibility === "restricted" || row.compliance_visibility === "aggregate_only"
      ? row.compliance_visibility
      : "admin_only",
  };
}

function nextActionFor(target_type: string): string {
  switch (target_type) {
    case "auction":  return "Verifica calendario asta e prepara dossier acquirente";
    case "listing":  return "Contatta proprietario / agenzia di riferimento";
    case "property": return "Verifica titolarità e pianifica visita";
    case "address":  return "Avvia ricerca proprietario su pubblici registri";
    case "lead":     return "Qualifica lead e pianifica primo contatto";
    default:         return "Valuta opportunità e definisci prossimo passo";
  }
}

interface DealMeta {
  title: string | null;
  area_name: string | null;
  microzone: string | null;
  price_label: string | null;
  urgency: "low" | "medium" | "high";
  updated_at: string | null;
}

function extractDealMeta(group: EvidenceRow[]): DealMeta {
  let title: string | null = null;
  let area_name: string | null = null;
  let microzone: string | null = null;
  let ask_price: number | null = null;
  let base_price: number | null = null;
  let min_offer: number | null = null;
  let updated_at: string | null = null;
  let sale_date: string | null = null;
  for (const r of group) {
    const v = evidenceValueAsRecord(r.evidence_value);
    title ??= pickString(v, ["title"]);
    area_name ??= pickString(v, ["municipality", "comune", "area_name"]);
    microzone ??= pickString(v, ["microzone", "microzona"]);
    ask_price ??= pickNum(v, ["ask_price"]);
    base_price ??= pickNum(v, ["base_price_eur"]);
    min_offer ??= pickNum(v, ["minimum_offer_eur"]);
    sale_date ??= pickString(v, ["sale_date"]);
    const last = pickString(v, ["last_seen_at"]) ?? r.observed_at;
    if (!updated_at || (last && last > updated_at)) updated_at = last;
  }
  const price = ask_price ?? min_offer ?? base_price;
  const price_label = price != null
    ? new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(price)
    : null;
  let urgency: DealMeta["urgency"] = "low";
  if (sale_date) {
    const days = (new Date(sale_date).getTime() - Date.now()) / 86400_000;
    if (days >= 0 && days <= 14) urgency = "high";
    else if (days >= 0 && days <= 45) urgency = "medium";
  }
  return { title, area_name, microzone, price_label, urgency, updated_at };
}

function evidenceValueAsRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function pickString(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) { const v = o[k]; if (typeof v === "string" && v.trim()) return v.trim(); }
  return null;
}
function pickNum(o: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) { const v = o[k]; if (typeof v === "number" && Number.isFinite(v)) return v; }
  return null;
}
