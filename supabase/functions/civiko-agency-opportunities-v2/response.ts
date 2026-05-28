// Pure helpers for civiko-agency-opportunities-v2 — extracted so vitest can
// import them WITHOUT pulling Deno-only imports from index.ts.
//
// Keep this file free of any Deno / npm: imports.

import type { AgencyArea, OpportunityAuditResult } from "./audit.ts";

export const DEFAULT_AUDIT = {
  area_insights_count: 0,
  commercial_actions_count: 0,
  deal_candidates_before_filters: 0,
  final_deal_opportunities_count: 0,
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
  const focus_area = Array.isArray(result?.focus_area) ? result!.focus_area! : [];
  const hot_microzones = Array.isArray(result?.hot_microzones) ? result!.hot_microzones! : [];
  const commercial_actions = Array.isArray(result?.commercial_actions) ? result!.commercial_actions! : [];
  const deal_opportunities = Array.isArray(result?.deal_opportunities) ? result!.deal_opportunities! : [];
  const opportunities = Array.isArray(result?.opportunities) ? result!.opportunities! : deal_opportunities;
  const audit = result?.audit && typeof result.audit === "object" ? result.audit : DEFAULT_AUDIT;

  const hasDeals = deal_opportunities.length > 0;
  const hasArea = focus_area.length + hot_microzones.length > 0;
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

export function buildControlledErrorBody(debug_id: string) {
  return {
    ok: false,
    data_status: "error",
    error_code: "OPPORTUNITY_V2_RUNTIME_ERROR",
    message: "Non riesco a caricare le opportunità in questo momento.",
    debug_id,
    ...EMPTY_PAYLOAD,
  };
}
