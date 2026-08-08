// padova-privati-list — Edge Function
// Server-to-server authenticated endpoint for the PWA (via core-proxy).
//
// Authentication contract:
//   - x-source-app        (used by requireSecret to resolve per-app secret)
//   - x-internal-secret   (constant-time compared to AI_CORE_SECRET_<APP>)
//   - x-workspace-id      (UUID; the ONLY source of workspace identity)
//   - x-user-id           (forwarded from proxy; not authoritative here)
//
// Zone authorization:
//   - The commercial zone is derived server-side from
//     public.civiko_commercial_zones matching the verified x-workspace-id.
//   - Never trust `commercial_zone_slug` or `workspace_id` from client query
//     string or body. They are always ignored.
//
// Data filter:
//   - Always applies .eq("commercial_zone_slug", assignedSlug) to every
//     query (list, total, con_telefono).
//   - Optional quartiere filter must resolve (via commercialZoneForQuartiere)
//     to the assigned zone; otherwise fail-closed 403.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, handleOptions, requireSecret, makeDebugId } from "../_shared/http.ts";
import { isCivikoCommercialZoneSlug } from "../_shared/civikoCommercialZoneContract.ts";
import { commercialZoneForQuartiere } from "../_shared/civikoCommercialZoneByQuartiere.ts";
import {
  applyCivikoSingleZoneGate,
} from "../_shared/civikoZoneAccessGate.ts";

const BANNED = /\b(AI|IA|intelligenza|stima|perizia|valutazione|valore reale|prezzo giusto|garantito)\b/gi;
function sanitize<T>(v: T): T {
  if (typeof v === "string") return v.replace(BANNED, "rilevato") as unknown as T;
  if (Array.isArray(v)) return v.map(sanitize) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = sanitize(val);
    return out as unknown as T;
  }
  return v;
}

const SELECT_COLS =
  "fonte,url,telefono,mq,locali,bagni,prezzo,lat,lng,indirizzo," +
  "quartiere,imported_at,tipo_lead,comune,omi_zone,commercial_zone_slug," +
  "zone_match_method,zone_match_confidence";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const cors = corsHeaders(req);
  const debugId = makeDebugId();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json", "x-debug-id": debugId },
    });

  // ────────────────────────────────────────────────────────────
  // 1) Secret verification MUST happen before any DB client or query.
  //    Reuses the shared per-app secret pattern (AI_CORE_SECRET_<APP>).
  // ────────────────────────────────────────────────────────────
  const secretFail = requireSecret(req, debugId);
  if (secretFail) return secretFail;

  // ────────────────────────────────────────────────────────────
  // 2) Workspace identity — from x-workspace-id ONLY.
  //    Never from body/query. Never from commercial_zone_slug.
  // ────────────────────────────────────────────────────────────
  const workspaceId = (req.headers.get("x-workspace-id") ?? "").trim();
  if (!UUID_RE.test(workspaceId)) {
    return json(
      { ok: false, error: { code: "WORKSPACE_REQUIRED", message: "Missing or invalid x-workspace-id" } },
      401,
    );
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    // ──────────────────────────────────────────────────────────
    // 3) Resolve the authorized zone server-side.
    //    Accept only: occupata+occupied_agency_id, or
    //                 in_trial+trial_agency_id+trial_reserved_until > now().
    //    Never fall back to legacy `agency_id`.
    // ──────────────────────────────────────────────────────────
    const { data: zonesRows, error: zoneErr } = await supabase
      .from("civiko_commercial_zones")
      .select("slug,status,occupied_agency_id,trial_agency_id,trial_reserved_until")
      .or(
        `and(status.eq.occupata,occupied_agency_id.eq.${workspaceId}),` +
          `and(status.eq.in_trial,trial_agency_id.eq.${workspaceId})`,
      );
    if (zoneErr) {
      return json({ ok: false, error: { code: "DB_ERROR", message: "zone lookup failed" } }, 500);
    }

    const now = Date.now();
    const valid = (zonesRows ?? []).filter((z: Record<string, unknown>) => {
      if (z.status === "occupata" && z.occupied_agency_id === workspaceId) return true;
      if (
        z.status === "in_trial" &&
        z.trial_agency_id === workspaceId &&
        typeof z.trial_reserved_until === "string" &&
        new Date(z.trial_reserved_until).getTime() > now
      ) return true;
      return false;
    });

    // Il bypass admin resta solo per strumenti interni, mai per Civiko One.
    let isAdmin = false;
    {
      const { data: adminRes } = await supabase.rpc("civiko_is_admin_agency", { _agency_id: workspaceId });
      isAdmin = adminRes === true;
    }

    let assignedSlugs: string[];
    if (isAdmin) {
      assignedSlugs = [
        "centro-storico", "nord-arcella", "est-brenta", "nord-est",
        "sud-est-sant-osvaldo", "sud-voltabarozzo-guizza", "sud-ovest-mandria",
        "ovest-chiesanuova-brentelle",
      ];
    } else {
      if (valid.length === 0) {
        return json(
          { ok: false, error: { code: "NO_ZONE_ASSIGNED", message: "No active zone for workspace" } },
          403,
        );
      }
      assignedSlugs = valid
        .map((z) => String(z.slug ?? ""))
        .filter((s) => isCivikoCommercialZoneSlug(s));
      if (assignedSlugs.length === 0) {
        return json(
          { ok: false, error: { code: "SLUG_OUT_OF_CONTRACT", message: "Assigned slug not in contract" } },
          403,
        );
      }
    }

    // ──────────────────────────────────────────────────────────
    // 4) Parse client params. IGNORE workspace_id and
    //    commercial_zone_slug from body/query. They are never authority.
    // ──────────────────────────────────────────────────────────
    const url = new URL(req.url);
    const qp = url.searchParams;
    let bodyPayload: Record<string, unknown> = {};
    if (req.method === "POST") {
      try { bodyPayload = await req.json(); } catch { /* empty */ }
    }
    const pickStr = (k: string): string | undefined => {
      const v = qp.get(k) ?? bodyPayload[k];
      return typeof v === "string" && v.length > 0 ? v : undefined;
    };
    const pickNum = (k: string): number | undefined => {
      const v = qp.get(k) ?? bodyPayload[k];
      if (v === null || v === undefined || v === "") return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const pickBool = (k: string): boolean => {
      const v = qp.get(k) ?? bodyPayload[k];
      return v === true || v === "true" || v === "1";
    };

    const offset = Math.max(0, pickNum("offset") ?? 0);
    const limit = Math.min(500, Math.max(1, pickNum("limit") ?? 200));
    const soloConTel = pickBool("solo_con_telefono");
    const tipoLead = pickStr("tipo_lead");
    const quartiereRaw = pickStr("quartiere");
    const zoneSlugRaw = pickStr("zone_slug") ?? pickStr("commercial_zone_slug");

    // Checkpoint 11B-A — gate "una sola zona ufficiale assegnata" (fail-closed).
    // Lo slug del client puo' solo restringere entro le zone autorizzate.
    // L'admin owner verificato server-side non e' un'agenzia cliente: nessun gate monozona.
    if (!isAdmin) {
      const gate = applyCivikoSingleZoneGate(req.headers.get("x-source-app"), assignedSlugs, zoneSlugRaw);
      if (gate.civiko) {
        if (!gate.ok) {
          return json({ ok: false, error: { code: gate.code, message: "Zone access denied" } }, 403);
        }
        assignedSlugs = gate.slugs;
        isAdmin = false;
      }
    }

    // If client requests a specific zone, it must be in the authorized set.
    let activeSlugs = assignedSlugs;
    if (zoneSlugRaw) {
      if (!assignedSlugs.includes(zoneSlugRaw)) {
        return json(
          { ok: false, error: { code: "ZONE_NOT_ASSIGNED", message: "Requested zone not assigned to workspace" } },
          403,
        );
      }
      activeSlugs = [zoneSlugRaw];
    }

    let quartiereFilter: string | undefined;
    if (quartiereRaw) {
      const resolved = commercialZoneForQuartiere(quartiereRaw);
      if (!resolved || !activeSlugs.includes(resolved)) {
        return json(
          { ok: false, error: { code: "QUARTIERE_OUT_OF_ZONE", message: "Quartiere not in assigned zone" } },
          403,
        );
      }
      quartiereFilter = quartiereRaw;
      activeSlugs = [resolved];
    }

    const tipoList = tipoLead ? [tipoLead] : ["PRIVATO", "privato", "privato_stanco"];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyFilters = (q: any): any => {
      q = q.in("tipo_lead", tipoList)
           .eq("comune", "Padova")
           .in("commercial_zone_slug", activeSlugs);
      if (quartiereFilter) q = q.eq("quartiere", quartiereFilter);
      if (soloConTel) q = q.not("telefono", "is", null);
      return q;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let listQ: any = applyFilters(
      (supabase.from("padova_listings") as any).select(SELECT_COLS, { count: "exact" }),
    );
    listQ = listQ
      .order("telefono", { ascending: false, nullsFirst: false })
      .order("prezzo", { ascending: true, nullsFirst: false })
      .range(offset, offset + limit - 1);
    const { data, count, error } = await listQ;
    if (error) return json({ ok: false, error: { code: "DB_ERROR", message: error.message } }, 500);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const telQ: any = applyFilters(
      (supabase.from("padova_listings") as any).select("id", { count: "exact", head: true }),
    ).not("telefono", "is", null);
    const { count: conTel } = await telQ;

    const privati = sanitize(data ?? []);
    const total = count ?? privati.length;
    const con_telefono = conTel ?? 0;
    const body = {
      ok: true,
      privati,
      total,
      con_telefono,
      offset,
      limit,
      assigned_zone: activeSlugs.length === 1 ? activeSlugs[0] : null,
      assigned_zones: assignedSlugs,
      active_zones: activeSlugs,
      data: { privati, total, con_telefono },
    };
    return json(body, 200);
  } catch (e) {
    return json(
      { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : "error" } },
      500,
    );
  }
});
