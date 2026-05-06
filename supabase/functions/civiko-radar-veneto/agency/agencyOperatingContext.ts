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

// ── Tenant resolution helpers (service role) ─────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
function svc() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("supabase service role missing");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function getUserAgencyContext(user_id: string | null | undefined): Promise<{
  user_id: string | null;
  agency_ids: string[];
  default_agency_id: string | null;
  default_operating_area_id: string | null;
}> {
  if (!user_id) return { user_id: null, agency_ids: [], default_agency_id: null, default_operating_area_id: null };
  const c = svc();
  const { data: mems } = await c.from("agency_memberships")
    .select("agency_id, role, status").eq("user_id", user_id).eq("status", "active");
  const agency_ids = Array.from(new Set((mems ?? []).map((m: any) => m.agency_id).filter(Boolean)));
  const default_agency_id = agency_ids[0] ?? null;
  let default_operating_area_id: string | null = null;
  if (default_agency_id) {
    const { data: aoa } = await c.from("agency_operating_areas")
      .select("id, is_default, is_active").eq("agency_id", default_agency_id).eq("is_active", true)
      .order("is_default", { ascending: false }).limit(1);
    default_operating_area_id = aoa?.[0]?.id ?? null;
  } else {
    const { data: aoa } = await c.from("agency_operating_areas")
      .select("id, is_default, is_active").eq("user_id", user_id).eq("is_active", true)
      .order("is_default", { ascending: false }).limit(1);
    default_operating_area_id = aoa?.[0]?.id ?? null;
  }
  return { user_id, agency_ids, default_agency_id, default_operating_area_id };
}

export async function validateOperatingAreaAccess(
  params: { user_id?: string | null; agency_id?: string | null; operating_area_id: string },
): Promise<{ allowed: boolean; area: any | null; reason?: string }> {
  if (!params.operating_area_id) return { allowed: false, area: null, reason: "missing_operating_area_id" };
  const c = svc();
  const { data: area, error } = await c.from("agency_operating_areas")
    .select("*").eq("id", params.operating_area_id).maybeSingle();
  if (error || !area) return { allowed: false, area: null, reason: "not_found" };
  if (area.agency_id) {
    if (!params.user_id) return { allowed: false, area: null, reason: "auth_required" };
    const { data: mem } = await c.from("agency_memberships")
      .select("user_id").eq("agency_id", area.agency_id).eq("user_id", params.user_id).eq("status", "active").maybeSingle();
    if (!mem) return { allowed: false, area: null, reason: "not_member" };
    return { allowed: true, area };
  }
  if (area.user_id) {
    if (params.user_id && area.user_id === params.user_id) return { allowed: true, area };
    return { allowed: false, area: null, reason: "not_owner" };
  }
  return { allowed: false, area: null, reason: "no_tenant_binding" };
}

export async function resolveOperatingAreaInput(
  body: { operating_area_id?: string | null; user_id?: string | null; agency_id?: string | null } & OperatingAreaInput,
): Promise<{ area: OperatingAreaInput; preferences: Partial<AgencySignalPreferences>; source: "explicit"|"area_id"|"none"; reason?: string }> {
  if (body.operating_area_id) {
    const v = await validateOperatingAreaAccess({
      user_id: body.user_id ?? null, agency_id: body.agency_id ?? null,
      operating_area_id: body.operating_area_id,
    });
    if (!v.allowed) return { area: {}, preferences: {}, source: "none", reason: v.reason };
    const a = v.area;
    let prefs: Partial<AgencySignalPreferences> = {};
    const c = svc();
    const { data: p } = await c.from("agency_signal_preferences")
      .select("*").or(`operating_area_id.eq.${a.id},and(agency_id.eq.${a.agency_id ?? "00000000-0000-0000-0000-000000000000"})`)
      .limit(1).maybeSingle();
    if (p) prefs = p as any;
    return {
      area: {
        province: a.province, comuni: a.comuni, microzones: a.microzones,
        quartieri: a.quartieri, focus: a.focus, radius_km: a.radius_km, label: a.label,
      },
      preferences: prefs, source: "area_id",
    };
  }
  if ((body.province?.length ?? 0) > 0 || (body.comuni?.length ?? 0) > 0) {
    return {
      area: {
        province: body.province ?? [], comuni: body.comuni ?? [],
        microzones: body.microzones ?? [], quartieri: body.quartieri ?? [],
        focus: body.focus ?? [], radius_km: body.radius_km ?? null, label: body.label ?? null,
      },
      preferences: {}, source: "explicit",
    };
  }
  return { area: {}, preferences: {}, source: "none" };
}
