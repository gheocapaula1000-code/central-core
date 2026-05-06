// ═══════════════════════════════════════════════════════════════
// agencyOperatingContext.ts — area operativa agenzia.
// Nessuno scraping. Nessun import. Solo filtri e normalizzazione.
// Default: NON usare tutto il Veneto. Se manca area → needs_operating_area.
// ═══════════════════════════════════════════════════════════════

export interface OperatingAreaInput {
  province?: string[] | null;
  comuni?: string[] | null;
  microzones?: string[] | null;
  quartieri?: string[] | null;
  focus?: string[] | null;
  radius_km?: number | null;
  label?: string | null;
}

export interface OperatingArea {
  province: string[];
  comuni: string[];
  microzones: string[];
  quartieri: string[];
  focus: string[];
  radius_km: number | null;
  label: string | null;
}

export interface AgencySignalPreferences {
  include_signal_types: string[];
  exclude_signal_types: string[];
  min_confidence: number;
  exclude_auctions: boolean;
  include_public_alienations: boolean;
  include_sensitive_turnover: boolean;
  include_sensitive_turnover_aggregated: boolean;
  include_urban_planning: boolean;
  include_mobility: boolean;
  include_services: boolean;
  include_green_risk_sentiment: boolean;
  include_tourism: boolean;
}

export const DEFAULT_PREFERENCES: AgencySignalPreferences = {
  include_signal_types: [],
  exclude_signal_types: [],
  min_confidence: 0.55,
  exclude_auctions: true,
  include_public_alienations: false,
  include_sensitive_turnover: false,
  include_sensitive_turnover_aggregated: true,
  include_urban_planning: true,
  include_mobility: true,
  include_services: true,
  include_green_risk_sentiment: true,
  include_tourism: false,
};

const AUCTION_LIKE_TYPES = new Set([
  "pre_auction_signal", "auction_signal", "judicial_auction",
]);
const ALIENATION_LIKE_TYPES = new Set([
  "pre_alienation_signal", "public_asset_disposal_signal", "alienazione",
]);
const SENSITIVE_NOMINATIVE = new Set([
  "obituary_signal", "succession_individual_signal", "inheritance_personal",
]);

export function normalizeOperatingArea(input: OperatingAreaInput | null | undefined): OperatingArea {
  const norm = (arr?: string[] | null) =>
    Array.from(new Set((arr ?? []).map((s) => String(s ?? "").trim()).filter(Boolean)));
  const provinceUpper = norm(input?.province).map((p) => p.toUpperCase());
  return {
    province: provinceUpper,
    comuni: norm(input?.comuni),
    microzones: norm(input?.microzones),
    quartieri: norm(input?.quartieri),
    focus: norm(input?.focus),
    radius_km: input?.radius_km ?? null,
    label: input?.label ?? null,
  };
}

export interface AgencyOperatingContext {
  area: OperatingArea;
  preferences: AgencySignalPreferences;
  needs_operating_area: boolean;
}

export function getAgencyOperatingContext(params: {
  area?: OperatingAreaInput | null;
  preferences?: Partial<AgencySignalPreferences> | null;
}): AgencyOperatingContext {
  const area = normalizeOperatingArea(params?.area ?? null);
  const preferences: AgencySignalPreferences = { ...DEFAULT_PREFERENCES, ...(params?.preferences ?? {}) };
  const needs_operating_area = area.province.length === 0 && area.comuni.length === 0;
  return { area, preferences, needs_operating_area };
}

export function isSignalInOperatingArea(
  signal: { comune?: string | null; provincia?: string | null; municipality?: string | null; province?: string | null; area_label?: string | null; microzona?: string | null; },
  ctx: AgencyOperatingContext,
): boolean {
  const { area } = ctx;
  if (area.province.length === 0 && area.comuni.length === 0) return false;
  const sCom = (signal.comune ?? signal.municipality ?? "").trim().toLowerCase();
  const sProv = (signal.provincia ?? signal.province ?? "").trim().toUpperCase();
  if (area.comuni.length > 0 && sCom && area.comuni.some((c) => c.toLowerCase() === sCom)) return true;
  if (area.province.length > 0 && sProv && area.province.includes(sProv)) {
    if (area.comuni.length === 0) return true;
  }
  if (area.microzones.length > 0 && signal.microzona && area.microzones.includes(signal.microzona)) return true;
  return false;
}

export function isSignalAllowedByPreferences(
  signal: { signal_type?: string | null; confidence_score?: number | null },
  prefs: AgencySignalPreferences,
): { allowed: boolean; reason?: string } {
  const t = (signal.signal_type ?? "").toLowerCase();
  if (SENSITIVE_NOMINATIVE.has(t)) return { allowed: false, reason: "sensitive_nominative_blocked" };
  if (prefs.exclude_auctions && AUCTION_LIKE_TYPES.has(t)) return { allowed: false, reason: "auctions_excluded" };
  if (!prefs.include_public_alienations && ALIENATION_LIKE_TYPES.has(t)) return { allowed: false, reason: "alienations_excluded" };
  if (prefs.include_signal_types.length > 0 && !prefs.include_signal_types.includes(t)) return { allowed: false, reason: "not_in_include_list" };
  if (prefs.exclude_signal_types.includes(t)) return { allowed: false, reason: "in_exclude_list" };
  const conf = Number(signal.confidence_score ?? 0);
  if (!Number.isNaN(conf) && conf > 0 && conf < prefs.min_confidence) return { allowed: false, reason: "below_min_confidence" };
  return { allowed: true };
}

export function filterSignalsForAgencyArea<T extends Record<string, any>>(
  signals: T[],
  ctx: AgencyOperatingContext,
): T[] {
  return signals.filter((s) => isSignalInOperatingArea(s as any, ctx) && isSignalAllowedByPreferences(s as any, ctx.preferences).allowed);
}
