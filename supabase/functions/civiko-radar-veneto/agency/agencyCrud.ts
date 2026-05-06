// ═══════════════════════════════════════════════════════════════
// agencyCrud.ts — Endpoint CRUD sicuri per agencies / operating
// areas / signal preferences. Server-side, service role.
// Nessuna fiducia in user_id da body se manca header x-user-id.
// ═══════════════════════════════════════════════════════════════
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { DEFAULT_PREFERENCES, type AgencySignalPreferences } from "./agencyOperatingContext.ts";

export type CrudResult =
  | { ok: true; status?: number; data: Record<string, unknown> }
  | { ok: false; status: number; error: { code: string; message: string } };

const ERR = (status: number, code: string, message: string): CrudResult => ({
  ok: false, status, error: { code, message },
});

let _client: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (_client) return _client;
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) throw new Error("supabase_service_role_not_configured");
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

// ── helpers ──────────────────────────────────────────────────

function requireUserId(headerUserId: string | null): { ok: true; user_id: string } | CrudResult {
  const v = (headerUserId ?? "").trim();
  if (!v) return ERR(400, "MISSING_USER_ID", "Header x-user-id obbligatorio");
  return { ok: true, user_id: v };
}

export async function getUserAgencyMembership(userId: string, agencyId: string) {
  const { data, error } = await db()
    .from("agency_memberships")
    .select("id, agency_id, user_id, role, status")
    .eq("user_id", userId).eq("agency_id", agencyId).eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function assertAgencyMember(userId: string, agencyId: string): Promise<CrudResult | null> {
  const m = await getUserAgencyMembership(userId, agencyId);
  if (!m) return ERR(403, "UNAUTHORIZED_AGENCY", "User non member attivo della agency");
  return null;
}

export async function assertAgencyAdmin(userId: string, agencyId: string): Promise<CrudResult | null> {
  const m = await getUserAgencyMembership(userId, agencyId);
  if (!m) return ERR(403, "UNAUTHORIZED_AGENCY", "User non member della agency");
  if (!["owner", "admin"].includes(String(m.role))) {
    return ERR(403, "FORBIDDEN_ROLE", "Richiesto ruolo owner/admin");
  }
  return null;
}

export function safeDefaultPreferences(): AgencySignalPreferences {
  return { ...DEFAULT_PREFERENCES };
}

function arr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return Array.from(new Set(v.map((x) => String(x ?? "").trim()).filter(Boolean)));
}

function sanitizeAgencyPayload(input: Record<string, unknown>): {
  label: string | null; province: string[]; comuni: string[];
  microzones: string[]; quartieri: string[]; focus: string[];
  is_default: boolean;
} {
  return {
    label: typeof input.label === "string" ? input.label.trim().slice(0, 200) : null,
    province: arr(input.province).map((p) => p.toUpperCase().slice(0, 4)),
    comuni: arr(input.comuni),
    microzones: arr(input.microzones),
    quartieri: arr(input.quartieri),
    focus: arr(input.focus),
    is_default: input.is_default === true,
  };
}

// ── /agency/personal ─────────────────────────────────────────

export async function ensurePersonalAgency(params: {
  userId: string; email: string | null; agencyName: string | null;
}): Promise<CrudResult> {
  const supa = db();
  // 1. existing membership?
  const { data: existing, error: e1 } = await supa
    .from("agency_memberships")
    .select("id, agency_id, user_id, role, status, created_at")
    .eq("user_id", params.userId).eq("status", "active")
    .order("created_at", { ascending: true }).limit(1);
  if (e1) return ERR(500, "DB_ERROR", e1.message);
  if (existing && existing.length > 0) {
    const m = existing[0];
    const { data: ag, error: eAg } = await supa
      .from("agencies").select("*").eq("id", m.agency_id).maybeSingle();
    if (eAg) return ERR(500, "DB_ERROR", eAg.message);
    return { ok: true, data: { agency: ag, membership: m, created: false } };
  }
  // 2. create agency + owner membership
  const name = (params.agencyName ?? "").trim() || "La mia agenzia";
  const { data: ag, error: eIns } = await supa
    .from("agencies")
    .insert({ name, billing_email: params.email, status: "active" })
    .select("*").single();
  if (eIns) return ERR(500, "DB_ERROR", eIns.message);
  const { data: mem, error: eMem } = await supa
    .from("agency_memberships")
    .insert({ agency_id: ag.id, user_id: params.userId, role: "owner", status: "active" })
    .select("*").single();
  if (eMem) return ERR(500, "DB_ERROR", eMem.message);
  return { ok: true, data: { agency: ag, membership: mem, created: true } };
}

// ── /agency/operating-areas/* ────────────────────────────────

export async function listOperatingAreas(params: {
  userId: string; agency_id: string; include_inactive?: boolean;
}): Promise<CrudResult> {
  if (!params.agency_id) return ERR(400, "VALIDATION_ERROR", "agency_id richiesto");
  const guard = await assertAgencyMember(params.userId, params.agency_id);
  if (guard) return guard;
  let q = db().from("agency_operating_areas").select("*").eq("agency_id", params.agency_id);
  if (!params.include_inactive) q = q.eq("is_active", true);
  const { data, error } = await q.order("is_default", { ascending: false }).order("created_at", { ascending: true });
  if (error) return ERR(500, "DB_ERROR", error.message);
  return { ok: true, data: { areas: data ?? [] } };
}

async function clearDefaultAreas(supa: SupabaseClient, agencyId: string, exceptId?: string) {
  let q = supa.from("agency_operating_areas").update({ is_default: false }).eq("agency_id", agencyId).eq("is_default", true);
  if (exceptId) q = q.neq("id", exceptId);
  await q;
}

export async function createOperatingArea(params: {
  userId: string; agency_id: string; payload: Record<string, unknown>;
}): Promise<CrudResult> {
  if (!params.agency_id) return ERR(400, "VALIDATION_ERROR", "agency_id richiesto");
  const guard = await assertAgencyAdmin(params.userId, params.agency_id);
  if (guard) return guard;
  const p = sanitizeAgencyPayload(params.payload ?? {});
  if (p.province.length === 0 && p.comuni.length === 0) {
    return ERR(400, "VALIDATION_ERROR", "Specificare almeno province o comuni");
  }
  const supa = db();
  if (p.is_default) await clearDefaultAreas(supa, params.agency_id);
  const { data, error } = await supa.from("agency_operating_areas").insert({
    agency_id: params.agency_id,
    created_by: params.userId,
    label: p.label,
    province: p.province,
    comuni: p.comuni,
    microzones: p.microzones,
    quartieri: p.quartieri,
    focus: p.focus,
    is_default: p.is_default,
    is_active: true,
  }).select("*").single();
  if (error) return ERR(500, "DB_ERROR", error.message);
  return { ok: true, data: { area: data } };
}

export async function updateOperatingArea(params: {
  userId: string; agency_id: string; id: string; patch: Record<string, unknown>;
}): Promise<CrudResult> {
  if (!params.agency_id || !params.id) return ERR(400, "VALIDATION_ERROR", "id e agency_id richiesti");
  const guard = await assertAgencyAdmin(params.userId, params.agency_id);
  if (guard) return guard;
  const supa = db();
  const { data: existing, error: eExist } = await supa
    .from("agency_operating_areas").select("id, agency_id")
    .eq("id", params.id).maybeSingle();
  if (eExist) return ERR(500, "DB_ERROR", eExist.message);
  if (!existing || existing.agency_id !== params.agency_id) {
    return ERR(404, "AREA_NOT_FOUND", "Area inesistente o non appartiene alla agency");
  }
  const patch = params.patch ?? {};
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("label" in patch) update.label = typeof patch.label === "string" ? patch.label.trim().slice(0, 200) : null;
  if ("province" in patch) update.province = arr(patch.province).map((p) => p.toUpperCase().slice(0, 4));
  if ("comuni" in patch) update.comuni = arr(patch.comuni);
  if ("microzones" in patch) update.microzones = arr(patch.microzones);
  if ("quartieri" in patch) update.quartieri = arr(patch.quartieri);
  if ("focus" in patch) update.focus = arr(patch.focus);
  if ("is_default" in patch) update.is_default = patch.is_default === true;
  if (update.is_default === true) await clearDefaultAreas(supa, params.agency_id, params.id);
  const { data, error } = await supa.from("agency_operating_areas")
    .update(update).eq("id", params.id).select("*").single();
  if (error) return ERR(500, "DB_ERROR", error.message);
  return { ok: true, data: { area: data } };
}

export async function deactivateOperatingArea(params: {
  userId: string; agency_id: string; id: string;
}): Promise<CrudResult> {
  if (!params.agency_id || !params.id) return ERR(400, "VALIDATION_ERROR", "id e agency_id richiesti");
  const guard = await assertAgencyAdmin(params.userId, params.agency_id);
  if (guard) return guard;
  const supa = db();
  const { data: existing, error: eExist } = await supa
    .from("agency_operating_areas").select("id, agency_id")
    .eq("id", params.id).maybeSingle();
  if (eExist) return ERR(500, "DB_ERROR", eExist.message);
  if (!existing || existing.agency_id !== params.agency_id) {
    return ERR(404, "AREA_NOT_FOUND", "Area inesistente o non appartiene alla agency");
  }
  const { data, error } = await supa.from("agency_operating_areas")
    .update({ is_active: false, is_default: false, updated_at: new Date().toISOString() })
    .eq("id", params.id).select("*").single();
  if (error) return ERR(500, "DB_ERROR", error.message);
  return { ok: true, data: { area: data } };
}

// ── /agency/signal-preferences/* ─────────────────────────────

const ALLOWED_PREF_KEYS: (keyof AgencySignalPreferences)[] = [
  "include_signal_types", "exclude_signal_types", "min_confidence",
  "exclude_auctions", "include_public_alienations",
  "include_sensitive_turnover", "include_sensitive_turnover_aggregated",
  "include_urban_planning", "include_mobility", "include_services",
  "include_green_risk_sentiment", "include_tourism",
];

function sanitizePreferences(input: Record<string, unknown>): Partial<AgencySignalPreferences> {
  const out: Record<string, unknown> = {};
  for (const k of ALLOWED_PREF_KEYS) {
    if (!(k in input)) continue;
    const v = input[k as string];
    if (k === "include_signal_types" || k === "exclude_signal_types") {
      out[k] = arr(v);
    } else if (k === "min_confidence") {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && n <= 1) out[k] = n;
    } else {
      out[k] = v === true;
    }
  }
  // Hard rule: sensitive nominative turnover never auto-true via this surface
  // Accept value but do not silently elevate; default safety
  return out as Partial<AgencySignalPreferences>;
}

export async function getSignalPreferences(params: {
  userId: string; agency_id: string; operating_area_id: string;
}): Promise<CrudResult> {
  if (!params.agency_id || !params.operating_area_id) {
    return ERR(400, "VALIDATION_ERROR", "agency_id e operating_area_id richiesti");
  }
  const guard = await assertAgencyMember(params.userId, params.agency_id);
  if (guard) return guard;
  const { data, error } = await db().from("agency_signal_preferences")
    .select("*").eq("agency_id", params.agency_id).eq("operating_area_id", params.operating_area_id)
    .maybeSingle();
  if (error) return ERR(500, "DB_ERROR", error.message);
  if (!data) return { ok: true, data: { preferences: safeDefaultPreferences(), is_default: true } };
  return { ok: true, data: { preferences: data, is_default: false } };
}

export async function upsertSignalPreferences(params: {
  userId: string; agency_id: string; operating_area_id: string; preferences: Record<string, unknown>;
}): Promise<CrudResult> {
  if (!params.agency_id || !params.operating_area_id) {
    return ERR(400, "VALIDATION_ERROR", "agency_id e operating_area_id richiesti");
  }
  const guard = await assertAgencyAdmin(params.userId, params.agency_id);
  if (guard) return guard;
  const supa = db();
  // Verify area belongs to agency
  const { data: area, error: eArea } = await supa.from("agency_operating_areas")
    .select("id, agency_id").eq("id", params.operating_area_id).maybeSingle();
  if (eArea) return ERR(500, "DB_ERROR", eArea.message);
  if (!area || area.agency_id !== params.agency_id) {
    return ERR(404, "AREA_NOT_FOUND", "Operating area non appartiene alla agency");
  }
  const safe = sanitizePreferences(params.preferences ?? {});
  // Look for existing
  const { data: existing } = await supa.from("agency_signal_preferences")
    .select("id").eq("agency_id", params.agency_id).eq("operating_area_id", params.operating_area_id).maybeSingle();
  if (existing) {
    const { data, error } = await supa.from("agency_signal_preferences")
      .update({ ...safe, updated_at: new Date().toISOString() })
      .eq("id", existing.id).select("*").single();
    if (error) return ERR(500, "DB_ERROR", error.message);
    return { ok: true, data: { preferences: data, created: false } };
  }
  const { data, error } = await supa.from("agency_signal_preferences").insert({
    agency_id: params.agency_id,
    operating_area_id: params.operating_area_id,
    created_by: params.userId,
    ...safeDefaultPreferences(),
    ...safe,
  }).select("*").single();
  if (error) return ERR(500, "DB_ERROR", error.message);
  return { ok: true, data: { preferences: data, created: true } };
}

// ── Dispatcher ───────────────────────────────────────────────

export async function handleAgencyCrudRoute(
  req: Request, pathname: string, debugId: string,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  if (!pathname.includes("/agency/")) return null;
  // Match suffixes
  const map: Record<string, string> = {
    "/agency/personal": "personal",
    "/agency/operating-areas/list": "areas_list",
    "/agency/operating-areas/create": "areas_create",
    "/agency/operating-areas/update": "areas_update",
    "/agency/operating-areas/deactivate": "areas_deactivate",
    "/agency/signal-preferences/get": "prefs_get",
    "/agency/signal-preferences/upsert": "prefs_upsert",
  };
  const route = Object.keys(map).find((suffix) => pathname.endsWith(suffix));
  if (!route) return null;
  const op = map[route];

  const userIdHeader = req.headers.get("x-user-id");
  const u = requireUserId(userIdHeader);
  if ("ok" in u && u.ok === false) return { status: u.status, body: { ok: false, error: u.error, debug_id: debugId } };
  const userId = (u as { ok: true; user_id: string }).user_id;
  const email = (req.headers.get("x-user-email") ?? "").trim() || null;

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  let r: CrudResult;
  try {
    switch (op) {
      case "personal":
        r = await ensurePersonalAgency({
          userId, email,
          agencyName: typeof body.agency_name === "string" ? body.agency_name : null,
        });
        break;
      case "areas_list":
        r = await listOperatingAreas({
          userId,
          agency_id: String(body.agency_id ?? ""),
          include_inactive: body.include_inactive === true,
        });
        break;
      case "areas_create":
        r = await createOperatingArea({
          userId, agency_id: String(body.agency_id ?? ""), payload: body,
        });
        break;
      case "areas_update":
        r = await updateOperatingArea({
          userId, agency_id: String(body.agency_id ?? ""), id: String(body.id ?? ""),
          patch: (body.patch as Record<string, unknown>) ?? {},
        });
        break;
      case "areas_deactivate":
        r = await deactivateOperatingArea({
          userId, agency_id: String(body.agency_id ?? ""), id: String(body.id ?? ""),
        });
        break;
      case "prefs_get":
        r = await getSignalPreferences({
          userId, agency_id: String(body.agency_id ?? ""),
          operating_area_id: String(body.operating_area_id ?? ""),
        });
        break;
      case "prefs_upsert":
        r = await upsertSignalPreferences({
          userId, agency_id: String(body.agency_id ?? ""),
          operating_area_id: String(body.operating_area_id ?? ""),
          preferences: (body.preferences as Record<string, unknown>) ?? {},
        });
        break;
      default:
        return null;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 500, body: { ok: false, error: { code: "INTERNAL_ERROR", message: msg }, debug_id: debugId } };
  }

  if (!r.ok) {
    return { status: r.status, body: { ok: false, error: r.error, debug_id: debugId } };
  }
  return { status: 200, body: { ok: true, ...r.data, debug_id: debugId } };
}
