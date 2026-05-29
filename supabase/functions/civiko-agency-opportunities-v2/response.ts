// Pure helpers for civiko-agency-opportunities-v2 — extracted so vitest can
// import them WITHOUT pulling Deno-only imports from index.ts.
//
// Keep this file free of any Deno / npm: imports.

import type { AgencyArea, OpportunityAuditResult } from "./audit.ts";

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
};

/**
 * Pure response-builder. Given audit result + scope, produce a JSON-safe payload.
 * Defensive against null/undefined fields on `result` so the handler never crashes
 * even if a future audit refactor returns a partial object.
 */
export function buildResponseData(
  result: Partial<OpportunityAuditResult> | null | undefined,
  areaList: AgencyArea[] | null | undefined,
) {
  const focus_area = Array.isArray(result?.focus_area) && result.focus_area.length > 0
    ? sanitizeArray(result.focus_area)
    : null;
  const hot_microzones = sanitizeArray(result?.hot_microzones);
  const commercial_actions = sanitizeArray(result?.commercial_actions);
  const deal_opportunities = sanitizeArray(result?.deal_opportunities);
  const opportunities = Array.isArray(result?.opportunities) ? sanitizeArray(result!.opportunities!) : deal_opportunities;
  const audit = toJsonSafe(result?.audit && typeof result.audit === "object" ? result.audit : DEFAULT_AUDIT);
  const warnings = sanitizeArray(result?.warnings);

  const hasDeals = deal_opportunities.length > 0;
  const hasArea = (Array.isArray(focus_area) ? focus_area.length : 0) + hot_microzones.length > 0;
  const data_status = hasDeals ? "ok" : (hasArea ? "partial" : "empty");
  const empty_reason = hasDeals
    ? null
    : ((audit as { empty_reason?: string | null })?.empty_reason ?? "no_deal_level_opportunities");
  const message = hasDeals
    ? null
    : hasArea
      ? "Civiko ha rilevato segnali di zona, ma non ancora immobili o aste azionabili."
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
