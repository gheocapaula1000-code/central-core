// Pure helpers for civiko-agency-opportunities-v2 — extracted so vitest can
// import them WITHOUT pulling Deno-only imports from index.ts.
//
// Keep this file free of any Deno / npm: imports.

import type { AgencyArea, OpportunityAuditResult } from "./audit.ts";

export interface EvidenceCounts {
  area: number;
  microzone: number;
  deal: number;
  auction: number;
  listing: number;
}

export interface FrontendReadiness {
  ready: boolean;
  score: number;
  missing: string[];
  required_actions: string[];
  last_successful_ingestion_at: string | null;
  evidence_counts: EvidenceCounts;
  auto_heal_attempted: boolean;
}

export interface BuildOptions {
  evidence_counts?: EvidenceCounts;
  last_successful_ingestion_at?: string | null;
  auto_heal_attempted?: boolean;
}

export function buildFrontendReadiness(
  data: {
    focus_area: unknown[];
    hot_microzones: unknown[];
    commercial_actions: unknown[];
    deal_opportunities: unknown[];
  },
  opts: BuildOptions = {},
): FrontendReadiness {
  const counts: EvidenceCounts = opts.evidence_counts ?? { area: 0, microzone: 0, deal: 0, auction: 0, listing: 0 };
  const missing: string[] = [];
  const required_actions: string[] = [];

  if ((data.focus_area?.length ?? 0) < 1) {
    missing.push("focus_area");
    if (counts.area === 0) required_actions.push("ingest_area_opportunity_scores");
    else required_actions.push("auto_heal_area_evidence");
  }
  if ((data.hot_microzones?.length ?? 0) < 1) {
    missing.push("hot_microzones");
    if (counts.microzone === 0 && counts.deal === 0) required_actions.push("ingest_microzone_evidence");
  }
  if ((data.commercial_actions?.length ?? 0) < 1) {
    missing.push("commercial_actions");
    required_actions.push("derive_commercial_actions");
  }
  if ((data.deal_opportunities?.length ?? 0) < 1) {
    missing.push("deal_opportunities");
    if (counts.deal === 0 && counts.auction === 0 && counts.listing === 0) {
      required_actions.push("ingest_normalized_opportunities_and_auctions");
    } else {
      required_actions.push("backfill_deal_evidence");
    }
  }

  // Weighted score: deals 40, focus 20, microzones 20, actions 20
  let score = 0;
  if ((data.deal_opportunities?.length ?? 0) > 0) score += 40;
  if ((data.focus_area?.length ?? 0) > 0) score += 20;
  if ((data.hot_microzones?.length ?? 0) > 0) score += 20;
  if ((data.commercial_actions?.length ?? 0) > 0) score += 20;

  return {
    ready: missing.length === 0,
    score,
    missing,
    required_actions: [...new Set(required_actions)],
    last_successful_ingestion_at: opts.last_successful_ingestion_at ?? null,
    evidence_counts: counts,
    auto_heal_attempted: !!opts.auto_heal_attempted,
  };
}


export const DEFAULT_AUDIT = {
  candidates_before_filters: 0,
  removed_insufficient_evidence: 0,
  removed_weak_only: 0,
  removed_restricted: 0,
  removed_outside_scope: 0,
  removed_stale: 0,
  final_opportunities_count: 0,
  confidence_distribution: { low: 0, medium: 0, high: 0 },
  empty_reason: null as string | null,
  area_insights_count: 0,
  commercial_actions_count: 0,
  deal_candidates_before_filters: 0,
  removed_area_only: 0,
  removed_no_actionable_target: 0,
  removed_insufficient_deal_evidence: 0,
  final_deal_opportunities_count: 0,
  removed_outside_comune: 0,
  removed_unmapped_zone: 0,
  removed_zone_mismatch: 0,
  deal_rows_missing_geo: 0,
  deal_rows_inside_comune_unmapped: 0,
  deal_rows_inside_agency_zone: 0,
};

export const EMPTY_PAYLOAD = {
  focus_area: [] as unknown[],
  hot_microzones: [] as unknown[],
  commercial_actions: [] as unknown[],
  deal_opportunities: [] as unknown[],
  opportunities: [] as unknown[],
  audit: DEFAULT_AUDIT,
  frontend_readiness: {
    ready: false,
    score: 0,
    missing: ["focus_area", "hot_microzones", "commercial_actions", "deal_opportunities"],
    required_actions: [],
    last_successful_ingestion_at: null,
    evidence_counts: { area: 0, microzone: 0, deal: 0, auction: 0, listing: 0 },
    auto_heal_attempted: false,
  } satisfies FrontendReadiness,
};


/**
 * Pure response-builder. Given audit result + scope, produce a JSON-safe payload.
 * Defensive against null/undefined fields on `result` so the handler never crashes
 * even if a future audit refactor returns a partial object.
 */
export function buildResponseData(
  result: Partial<OpportunityAuditResult> | null | undefined,
  areaList: AgencyArea[] | null | undefined,
  opts: BuildOptions = {},
) {
  const focus_area = sanitizeArray(result?.focus_area);

  const hot_microzones_raw = sanitizeArray(result?.hot_microzones);
  const commercial_actions_raw = sanitizeArray(result?.commercial_actions);
  const deal_opportunities = sanitizeArray(result?.deal_opportunities);
  const opportunities = Array.isArray(result?.opportunities) ? sanitizeArray(result!.opportunities!) : deal_opportunities;
  const audit = toJsonSafe(result?.audit && typeof result.audit === "object" ? result.audit : DEFAULT_AUDIT);
  const warnings = sanitizeArray(result?.warnings);

  // Enrich with frontend-readable fields derived from REAL signal counts
  // (no fabricated text). title is always populated from the canonical slug.
  const hot_microzones = hot_microzones_raw.map((mz) => enrichHotMicrozone(mz, deal_opportunities));
  const commercial_actions = commercial_actions_raw.map((a) => enrichCommercialAction(a, hot_microzones));

  const frontend_readiness = buildFrontendReadiness(
    { focus_area, hot_microzones, commercial_actions, deal_opportunities },
    opts,
  );

  const hasDeals = deal_opportunities.length > 0;
  const hasArea = (Array.isArray(focus_area) ? focus_area.length : 0) + hot_microzones.length > 0;
  // Never claim "ok" if readiness is not satisfied — partial covers the gap.
  let data_status: "ok" | "partial" | "empty";
  if (frontend_readiness.ready) data_status = "ok";
  else if (hasDeals || hasArea) data_status = "partial";
  else data_status = "empty";

  const empty_reason = hasDeals
    ? null
    : ((audit as { empty_reason?: string | null })?.empty_reason ?? "no_deal_level_opportunities");
  const message = data_status === "ok"
    ? null
    : data_status === "partial"
      ? "Dati reali presenti ma copertura incompleta."
      : "Nessuna evidenza disponibile per le zone configurate.";

  const safeAreas = (Array.isArray(areaList) ? areaList : []).filter(
    (a): a is AgencyArea => !!a && typeof a === "object",
  );

  return {
    data_status,
    message,
    empty_reason,
    focus_area,
    hot_microzones,
    commercial_actions,
    deal_opportunities,
    opportunities,
    audit,
    warnings,
    frontend_readiness,
    scope: {
      comuni: [...new Set(safeAreas.flatMap((a) => (Array.isArray(a.comuni) ? a.comuni : [])))],
      microzones: [
        ...new Set(
          safeAreas.flatMap((a) => [
            ...(Array.isArray(a.microzones) ? a.microzones : []),
            ...(Array.isArray(a.quartieri) ? a.quartieri : []),
          ]),
        ),
      ],
    },
  };
}


export function buildControlledErrorBody(debug_id: string, error_stage?: string, error_message?: string, error_name?: string) {
  return {
    ok: false,
    data_status: "error",
    error_code: "OPPORTUNITY_V2_RUNTIME_ERROR",
    message: "Non riesco a caricare le opportunità in questo momento.",
    debug_id,
    ...(error_stage ? { error_stage } : {}),
    ...(error_name ? { error_name } : {}),
    ...(error_message ? { error_message } : {}),
    ...EMPTY_PAYLOAD,
  };
}

function sanitizeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map((item) => toJsonSafe(item)) : [];
}

export function toJsonSafe<T>(value: T, seen = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJsonSafe(v, seen);
  seen.delete(value as object);
  return out;
}

export function safeStringify(value: unknown): string {
  return JSON.stringify(toJsonSafe(value));
}
