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

export type QualityBucket = "work_today" | "verify" | "monitor" | "low_value";
export type SourceAccess = "direct" | "cookie_wall_possible" | "unknown";

export interface MarketContext {
  /** map: comune (lowercased) → { min, max, avg } in EUR */
  comune_omi?: Record<string, { min?: number | null; max?: number | null; avg?: number | null } | undefined>;
  /** map: microzone (lowercased) → { min, max, avg } */
  microzone_omi?: Record<string, { min?: number | null; max?: number | null; avg?: number | null } | undefined>;
  /** ISO date when context was computed */
  computed_at?: string;
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
  ask_price: number | null;
  surface_mq: number | null;
  source_name: string | null;
  urgency: "low" | "medium" | "high";
  next_action: string;
  next_actions: string[];
  arguments_to_avoid: string[];
  updated_at: string | null;
  quality_bucket: QualityBucket;
  quality_reasons: string[];
  source_access: SourceAccess;
  price_vs_market_label: string | null;
  market_context: { source: string; min: number | null; max: number | null; avg: number | null } | null;
  data_freshness: { days: number | null; observed_at: string | null };
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
  options: SectionRunnerOptions & { marketContext?: MarketContext } = {},
): OpportunityAuditResult {
  const marketContext: MarketContext = options.marketContext ?? deriveMarketContextFromEvidence(rows);
  const scope = buildScopeMatcher(areas);
  const { groups, removed_outside_scope, removed_outside_comune, removed_stale } = filterAndGroup(rows, scope);
  const dealScope: DealScope = { comuni: scope.comuni, microzones: scope.microzones, fullComune: scope.fullComune };

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

  let ew_candidates_found = 0;
  let leg_candidates_found = 0;
  let ew_removed_no_market = 0;
  let ew_removed_no_target = 0;
  let ew_passed = 0;

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
      const target = extractActionableTarget(safeGroup, key);
      if (!target.ok) { removed_no_actionable_target++; continue; }

      if (!opp) {
        const hasOnlyRestricted = safeGroup.every((r) => r.compliance_visibility === "restricted" || r.compliance_visibility === "aggregate_only");
        if (hasOnlyRestricted) removed_restricted++;
        else removed_insufficient_deal_evidence++;
        continue;
      }

      dist[opp.evidence_summary.confidence]++;
      const meta = extractDealMeta(safeGroup);
      const target_type = target.target_type ?? "listing";
      const microzone = meta.microzone ?? zoneCls.matched_zone;
      const comuneSeg = dealComuneSeg(key);
      const market = lookupMarket(marketContext, comuneSeg, microzone);
      const numericPrice = extractNumericPrice(safeGroup);
      const price_vs_market_label = priceVsMarketLabel(numericPrice, market);
      const source_access = classifySourceAccess(target.target_url);
      const next_actions = nextActionsFor(target_type);
      const arguments_to_avoid = argumentsToAvoidFor(target_type);
      const distress = extractDistressFromGroup(safeGroup);
      const quality = classifyDealQuality({
        target_type,
        target_url: target.target_url,
        target_ref: target.target_ref,
        title: meta.title ?? target.title ?? null,
        address: target.address ?? null,
        microzone,
        price_label: meta.price_label,
        numericPrice,
        hasMarket: !!market,
        source_access,
        sale_date: meta.sale_date,
        distress_strength: distress.strength,
        has_velocity: distress.present,
      });
      deal_opportunities.push({
        ...opp,
        insight_type: "deal_opportunity",
        entity_granularity,
        id: key,
        title: meta.title ?? target.title ?? key,
        area_name: meta.area_name,
        microzone,
        target_type,
        target_ref: target.target_ref,
        target_url: target.target_url,
        address: target.address ?? meta.address ?? undefined,
        price_label: meta.price_label,
        ask_price: meta.ask_price ?? numericPrice ?? null,
        surface_mq: meta.surface_mq,
        source_name: meta.source_name,
        urgency: meta.urgency,
        next_action: next_actions[0]!,
        next_actions,
        arguments_to_avoid,
        updated_at: meta.updated_at,
        quality_bucket: quality.bucket,
        quality_reasons: quality.reasons,
        source_access,
        price_vs_market_label,
        market_context: market
          ? { source: market.source, min: market.min ?? null, max: market.max ?? null, avg: market.avg ?? null }
          : null,
        data_freshness: { days: opp.evidence_summary.freshness_days, observed_at: meta.updated_at },
      });

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`classification_skipped:${key}:${message}`);
      removed_insufficient_evidence++;
      options.onSectionFailure?.({ stage: "STAGE_CLASSIFICATION", entity_key: key, message });
      continue;
    }
  }

  // Post-loop derivations: if we got deals but no area-level coverage,
  // synthesize hot_microzones and commercial_actions from the deal aggregate
  // so the PWA always has territorial intelligence when real evidence exists.
  if (hot_microzones.length === 0) {
    for (const insight of buildDerivedHotMicrozones(deal_opportunities, scope)) {
      hot_microzones.push(insight);
    }
  }
  if (commercial_actions.length === 0 || deal_opportunities.length > 0) {
    for (const action of buildDerivedCommercialActions(deal_opportunities, focus_area, hot_microzones, marketContext)) {
      // dedup by action_code+entity_key
      if (!commercial_actions.some((a) => a.action_code === action.action_code && a.entity_key === action.entity_key)) {
        commercial_actions.push(action);
      }
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

  function dealPriority(o: DealOpportunity): number {
    // Controlla sia id che entity_key perché dipende da come viene mappato
    const k = (o as any).entity_key ?? (o as any).id ?? "";
    if (k.startsWith("ew:") || k.startsWith("leg:")) return 100;
    if (k.startsWith("auct:")) {
      const sd = (o as any).sale_date ?? (o as any).data_freshness?.observed_at ?? null;
      if (sd) {
        const days = (new Date(sd).getTime() - Date.now()) / 86_400_000;
        if (days >= 0 && days <= 60) return 80;
      }
      return 60;
    }
    if (k.startsWith("op:")) {
      if ((o as any).quality_bucket === "work_today") return 40;
      if ((o as any).quality_bucket === "verify") return 20;
      return 10;
    }
    return 5;
  }
  deal_opportunities.sort((a, b) => dealPriority(b) - dealPriority(a));
  const KEEP_ALL_THRESHOLD = 20;
  const filtered = deal_opportunities.length > KEEP_ALL_THRESHOLD
    ? deal_opportunities.filter((o) => dealPriority(o) > 5)
    : deal_opportunities;

  return {
    focus_area,
    hot_microzones,
    commercial_actions,
    deal_opportunities: filtered,
    opportunities: filtered, // backward-compat alias
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
  address: string | null;
  price_label: string | null;
  ask_price: number | null;
  surface_mq: number | null;
  source_name: string | null;
  urgency: "low" | "medium" | "high";
  updated_at: string | null;
  sale_date: string | null;
}

function extractDealMeta(group: EvidenceRow[]): DealMeta {
  let title: string | null = null;
  let area_name: string | null = null;
  let microzone: string | null = null;
  let address: string | null = null;
  let ask_price: number | null = null;
  let base_price: number | null = null;
  let min_offer: number | null = null;
  let surface_mq: number | null = null;
  let source_name: string | null = null;
  let updated_at: string | null = null;
  let sale_date: string | null = null;
  for (const r of group) {
    const v = evidenceValueAsRecord(r.evidence_value);
    title ??= pickString(v, ["title", "name"]);
    area_name ??= pickString(v, ["municipality", "comune", "area_name"]);
    microzone ??= pickString(v, ["microzone", "microzona"]);
    address ??= pickString(v, ["address", "address_text"]);
    ask_price ??= pickNumLoose(v, ["ask_price", "price"]);
    base_price ??= pickNumLoose(v, ["base_price", "base_price_eur"]);
    min_offer ??= pickNumLoose(v, ["minimum_offer_eur"]);
    surface_mq ??= pickNumLoose(v, ["surface_mq", "surface_sqm", "surface"]);
    source_name ??= pickString(v, ["source_name", "source"]);
    sale_date ??= pickString(v, ["sale_date"]);
    const last = pickString(v, ["last_seen_at"]) ?? r.observed_at;
    if (!updated_at || (last && last > updated_at)) updated_at = last;
  }
  const price = ask_price ?? min_offer ?? base_price;
  const explicit_price_label = firstString(group, ["price_label"]);
  const price_label = explicit_price_label ?? (price != null
    ? new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(price)
    : null);
  let urgency: DealMeta["urgency"] = "low";
  if (sale_date) {
    const days = (new Date(sale_date).getTime() - Date.now()) / 86400_000;
    if (days >= 0 && days <= 14) urgency = "high";
    else if (days >= 0 && days <= 45) urgency = "medium";
  }
  return { title, area_name, microzone, address, price_label, ask_price: price, surface_mq, source_name, urgency, updated_at, sale_date };
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
function firstString(group: EvidenceRow[], keys: string[]): string | null {
  for (const r of group) {
    const picked = pickString(evidenceValueAsRecord(r.evidence_value), keys);
    if (picked) return picked;
  }
  return null;
}
function pickNum(o: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) { const v = o[k]; if (typeof v === "number" && Number.isFinite(v)) return v; }
  return null;
}
function pickNumLoose(o: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const cleaned = v.replace(/[€$\s.]/g, "").replace(",", ".");
      const n = Number(cleaned);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Quality + market + action helpers
// ---------------------------------------------------------------------------

const COOKIE_WALL_DOMAINS = ["asteimmobili.it", "astalegale.it", "astegiudiziarie.it"];

export function classifySourceAccess(target_url: string | undefined): SourceAccess {
  if (!target_url) return "unknown";
  try {
    const host = new URL(target_url).hostname.toLowerCase();
    if (COOKIE_WALL_DOMAINS.some((d) => host.endsWith(d))) return "cookie_wall_possible";
    return "direct";
  } catch {
    return "unknown";
  }
}

export function nextActionsFor(target_type: string): string[] {
  switch (target_type) {
    case "auction": return [
      "Verifica documenti, calendario e prezzo base",
      "Prepara shortlist clienti interessati",
      "Confronta base asta con valori di zona",
    ];
    case "listing": return [
      "Verifica l'annuncio sul portale di origine",
      "Confronta prezzo richiesto con valori OMI di zona",
      "Prepara contatto con l'agenzia/inserzionista",
    ];
    case "property": return ["Verifica titolarità su pubblici registri", "Pianifica sopralluogo"];
    case "address":  return ["Avvia ricerca proprietario su pubblici registri"];
    case "lead":     return ["Qualifica lead e pianifica primo contatto"];
    default:         return ["Valuta opportunità e definisci prossimo passo"];
  }
}

export function argumentsToAvoidFor(target_type: string): string[] {
  if (target_type === "auction") {
    return [
      "Non promettere contatto diretto con il proprietario",
      "Non dichiarare sconto senza confronto OMI",
      "Non dare certezze legali senza documenti",
    ];
  }
  if (target_type === "listing") {
    return [
      "Non dichiarare sconto senza confronto OMI",
      "Non promettere esclusiva senza mandato",
    ];
  }
  return [];
}

export function extractNumericPrice(group: EvidenceRow[]): number | null {
  let ask: number | null = null, base: number | null = null, min: number | null = null;
  for (const r of group) {
    const v = evidenceValueAsRecord(r.evidence_value);
    ask ??= pickNum(v, ["ask_price", "price"]);
    base ??= pickNum(v, ["base_price", "base_price_eur"]);
    min ??= pickNum(v, ["minimum_offer_eur"]);
  }
  return ask ?? min ?? base ?? null;
}

export function lookupMarket(
  ctx: MarketContext,
  comune: string,
  microzone: string | null,
): { source: string; min: number | null; max: number | null; avg: number | null } | null {
  const mz = microzone ? norm(microzone) : null;
  if (mz && ctx.microzone_omi?.[mz]) {
    const m = ctx.microzone_omi[mz]!;
    return { source: `omi_microzone:${mz}`, min: m.min ?? null, max: m.max ?? null, avg: m.avg ?? null };
  }
  if (comune && ctx.comune_omi?.[comune]) {
    const c = ctx.comune_omi[comune]!;
    return { source: `omi_comune:${comune}`, min: c.min ?? null, max: c.max ?? null, avg: c.avg ?? null };
  }
  return null;
}

export function priceVsMarketLabel(
  price: number | null,
  market: { min: number | null; max: number | null; avg: number | null } | null,
): string | null {
  if (price == null || !market) return null;
  const ref = market.avg ?? (market.min != null && market.max != null ? (market.min + market.max) / 2 : null);
  if (ref == null || ref <= 0) return null;
  const delta = (price - ref) / ref;
  if (delta <= -0.15) return "sotto_mercato";
  if (delta >= 0.15) return "sopra_mercato";
  return "in_linea";
}

export function extractDistressFromGroup(group: EvidenceRow[]): {
  present: boolean;
  strength: "nessuno" | "lieve" | "medio" | "forte" | null;
} {
  for (const r of group) {
    if (r.evidence_type !== "listing_velocity") continue;
    const v = evidenceValueAsRecord(r.evidence_value);
    const raw = v["distress_strength"];
    const s = typeof raw === "string" ? raw : null;
    const strength = (s === "forte" || s === "medio" || s === "lieve" || s === "nessuno") ? s : null;
    return { present: true, strength };
  }
  return { present: false, strength: null };
}



export function classifyDealQuality(input: {
  target_type: string;
  target_url?: string;
  target_ref?: string;
  title: string | null;
  address: string | null;
  microzone: string | null;
  price_label: string | null;
  numericPrice: number | null;
  hasMarket: boolean;
  source_access: SourceAccess;
  sale_date: string | null;
  distress_strength?: "nessuno" | "lieve" | "medio" | "forte" | null;
  has_velocity?: boolean;
}): { bucket: QualityBucket; reasons: string[] } {
  const reasons: string[] = [];
  if (input.target_url) reasons.push("source_url_present");
  if (input.numericPrice != null && input.target_type === "auction") reasons.push("auction_price_present");
  else if (input.numericPrice != null) reasons.push("price_present");
  if (input.microzone) reasons.push("microzone_known");
  if (input.address || input.title) reasons.push("area_known");
  if (input.hasMarket) reasons.push("market_context_available");
  if (input.source_access === "cookie_wall_possible") reasons.push("cookie_wall_likely");
  if (!input.address) reasons.push("missing_address");
  if (!input.numericPrice && !input.title && !input.target_url) reasons.push("thin_record");
  if (input.distress_strength) reasons.push(`distress_${input.distress_strength}`);

  const hasPrice = input.numericPrice != null;
  const hasUrl = !!input.target_url;
  const hasContext = !!input.title || !!input.address;

  let bucket: QualityBucket;
  if (input.target_type === "auction" && hasPrice && hasUrl && input.sale_date) bucket = "work_today";
  else if (hasPrice && hasUrl && hasContext) bucket = "work_today";
  else if (hasUrl && hasContext) bucket = "verify";
  else if (hasUrl || hasPrice || hasContext) bucket = "monitor";
  else bucket = "low_value";

  // When listing-velocity evidence is present, only verified "forte" distress
  // is allowed to surface in "Da lavorare oggi". Solo "ripubblicato" (medio)
  // or weak signals are downgraded to "Da verificare".
  if (input.has_velocity && bucket === "work_today" && input.distress_strength !== "forte") {
    bucket = "verify";
    reasons.push("downgraded_distress_below_forte");
  }

  return { bucket, reasons };
}

// ---------------------------------------------------------------------------
// Market context derivation from in-scope evidence (F1/F12 area scores)
// ---------------------------------------------------------------------------

export function deriveMarketContextFromEvidence(rows: EvidenceRow[]): MarketContext {
  const comune_omi: NonNullable<MarketContext["comune_omi"]> = {};
  const microzone_omi: NonNullable<MarketContext["microzone_omi"]> = {};
  for (const r of rows) {
    if (r.source_code !== "F1" && r.source_code !== "F12") continue;
    const v = evidenceValueAsRecord(r.evidence_value);
    const min = pickNum(v, ["omi_min", "min_eur_mq", "valore_min", "min"]);
    const max = pickNum(v, ["omi_max", "max_eur_mq", "valore_max", "max"]);
    const avg = pickNum(v, ["omi_avg", "avg_eur_mq", "valore_medio", "avg"]);
    if (min == null && max == null && avg == null) continue;
    if (r.entity_key.startsWith("c:")) {
      const c = r.entity_key.slice(2);
      comune_omi[c] = { min, max, avg };
    } else if (r.entity_key.startsWith("mz:")) {
      const parts = r.entity_key.split(":");
      const mz = parts[2] ?? "";
      if (mz) microzone_omi[mz] = { min, max, avg };
    }
  }
  return { comune_omi, microzone_omi, computed_at: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Derived hot microzones + commercial actions from deal aggregates
// ---------------------------------------------------------------------------

export function buildDerivedHotMicrozones(
  deals: DealOpportunity[],
  scope: ScopeMatcher,
): AreaInsight[] {
  const counts = new Map<string, { count: number; comune: string }>();
  for (const d of deals) {
    if (!d.microzone) continue;
    const mz = norm(d.microzone);
    if (!scope.microzones.has(mz)) continue;
    const comune = dealComuneSeg(d.id) || [...scope.comuni][0] || "";
    const cur = counts.get(`${comune}:${mz}`) ?? { count: 0, comune };
    cur.count++;
    counts.set(`${comune}:${mz}`, cur);
  }
  const out: AreaInsight[] = [];
  for (const [key, { count, comune }] of counts) {
    if (count < 1) continue;
    const mz = key.split(":")[1]!;
    out.push({
      entity_type: "microzone",
      entity_key: `mz:${comune}:${mz}`,
      audience: "agency",
      insight_type: "area_insight",
      entity_granularity: "microzone",
      evidence_summary: {
        source_count: 1,
        source_families: ["deal_concentration"],
        confidence: count >= 3 ? "medium" : "low",
        score: Math.min(100, count * 10),
        freshness_days: null,
        explanation_bullets: [`[deal_concentration] ${count} deal attivi in ${mz}`],
        contributing_sources: ["deal_aggregate"],
        warnings: [],
      },
    });
  }
  return out;
}

export function buildDerivedCommercialActions(
  deals: DealOpportunity[],
  focus_area: AreaInsight[],
  hot_microzones: AreaInsight[],
  marketContext: MarketContext,
): CommercialAction[] {
  const out: CommercialAction[] = [];
  const auctions = deals.filter((d) => d.target_type === "auction");
  const listings = deals.filter((d) => d.target_type === "listing");
  const listingsWithPrice = listings.filter((d) => d.price_label);
  const comuneKeyGuess = focus_area[0]?.entity_key ?? (deals[0] ? `c:${dealComuneSeg(deals[0].id)}` : "c:padova");

  if (auctions.length > 0) {
    out.push({
      entity_key: comuneKeyGuess,
      entity_granularity: "comune",
      action_code: "monitora_aste",
      label: `Monitora ${auctions.length} aste immobiliari`,
      rationale: `Rilevate ${auctions.length} aste attive con calendario e prezzo base.`,
    });
  }
  if (listingsWithPrice.length > 0) {
    out.push({
      entity_key: comuneKeyGuess,
      entity_granularity: "comune",
      action_code: "verifica_annunci_prezzo",
      label: `Verifica ${listingsWithPrice.length} annunci con prezzo disponibile`,
      rationale: "Annunci con prezzo richiesto pronti per qualifica.",
    });
  }
  const hasOmi = Object.keys(marketContext.comune_omi ?? {}).length > 0
    || Object.keys(marketContext.microzone_omi ?? {}).length > 0;
  if (hasOmi && (auctions.length > 0 || listings.length > 0)) {
    out.push({
      entity_key: comuneKeyGuess,
      entity_granularity: "comune",
      action_code: "confronta_omi",
      label: "Confronta prezzi con valori OMI",
      rationale: "Valori OMI disponibili per benchmark di zona.",
    });
  }
  if (hot_microzones.length > 0) {
    out.push({
      entity_key: comuneKeyGuess,
      entity_granularity: "comune",
      action_code: "presidia_microzone_attive",
      label: `Presidia ${hot_microzones.length} microzone con più segnali`,
      rationale: "Microzone con maggior concentrazione di evidenze operative.",
    });
  }
  return out;
}

