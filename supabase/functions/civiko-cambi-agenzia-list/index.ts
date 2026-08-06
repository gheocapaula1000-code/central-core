// civiko-cambi-agenzia-list
// Elenca i cambi agenzia recenti a Padova come lead autonomo.
//
// Contratto autorevole:
//  - server-to-server: `x-source-app` + segreto condiviso, `x-workspace-id`;
//  - perimetro dati risolto SEMPRE server-side: il tenant vede solo le zone
//    che gli sono assegnate, il full-city è riservato all'admin/owner;
//  - `commercial_zone_slug` accettato solo come match ESATTO nelle 8 zone
//    ufficiali: wildcard, pattern e slug sconosciuti sono rifiutati;
//  - `total` è il COUNT esatto globale sui filtri, non la pagina;
//  - offset oltre il totale ⇒ items=[] e has_more=false (mai clamp a total-1);
//  - `snapshot_complete` prova conteggio esatto e assenza di troncamenti ed è
//    indipendente da items.length;
//  - nessun placeholder: titolo/indirizzo assenti restano null.

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { makeDebugId, requireSecret } from "../_shared/http.ts";
import {
  listEnvelope,
  nullableText,
  pageWindow,
  parseZoneSlug,
  resolveTenantScope,
  snapshotComplete,
} from "../_shared/listContracts.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret, x-app-secret, x-core-secret, x-source-app, x-workspace-id, x-tenant-id",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200, did?: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", ...(did ? { "x-debug-id": did } : {}) },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const did = makeDebugId();
  if (req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405, did);

  const secretFail = requireSecret(req, did);
  if (secretFail) return secretFail;

  const workspaceId = (req.headers.get("x-workspace-id") ?? req.headers.get("x-tenant-id") ?? "").trim();
  if (!UUID_RE.test(workspaceId)) {
    return json(
      { ok: false, debug_id: did, error: { code: "WORKSPACE_REQUIRED", message: "Missing or invalid workspace id" } },
      401,
      did,
    );
  }

  const url = new URL(req.url);
  const quartiere = url.searchParams.get("quartiere");
  const zonaOmi = url.searchParams.get("zona_omi");
  const daysRaw = parseInt(url.searchParams.get("days") ?? "30", 10);
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 90) : 30;
  const slugRaw = url.searchParams.get("commercial_zone_slug") ?? url.searchParams.get("zone_slug");

  // Slug fuori contratto: rifiuto prima di toccare il DB.
  if (slugRaw !== null && !parseZoneSlug(slugRaw).ok) {
    return json(
      { ok: false, debug_id: did, error: { code: "SLUG_OUT_OF_CONTRACT", message: "Zona non riconosciuta." } },
      400,
      did,
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    // ─── Perimetro tenant risolto server-side (mai dal client) ──────────
    const { data: adminRes } = await supabase.rpc("civiko_is_admin_agency", { _agency_id: workspaceId });
    const isAdmin = adminRes === true;

    const { data: zoneRows, error: zoneErr } = await supabase
      .from("civiko_commercial_zones")
      .select("slug,status,occupied_agency_id,trial_agency_id,trial_reserved_until")
      .or(
        `and(status.eq.occupata,occupied_agency_id.eq.${workspaceId}),` +
          `and(status.eq.in_trial,trial_agency_id.eq.${workspaceId})`,
      );
    if (zoneErr) throw zoneErr;
    const now = Date.now();
    const assignedSlugs = (zoneRows ?? [])
      .filter((z: Record<string, unknown>) =>
        (z.status === "occupata" && z.occupied_agency_id === workspaceId) ||
        (z.status === "in_trial" && z.trial_agency_id === workspaceId &&
          typeof z.trial_reserved_until === "string" &&
          new Date(z.trial_reserved_until as string).getTime() > now)
      )
      .map((z: Record<string, unknown>) => String(z.slug ?? ""));

    const scope = resolveTenantScope({ isAdmin, assignedSlugs, requestedSlug: slugRaw ?? undefined });
    if (!scope.ok) {
      return json({ ok: false, debug_id: did, error: { code: scope.code, message: "Zone access denied" } }, 403, did);
    }

    const applyFilters = <T extends { eq: unknown }>(q: T): T => {
      let out = q as unknown as {
        eq: (c: string, v: unknown) => typeof out;
        gte: (c: string, v: unknown) => typeof out;
        in: (c: string, v: unknown[]) => typeof out;
      };
      out = out.eq("is_active", true).gte("data_cambio", sinceIso);
      // Isolamento zona SEMPRE nel database, mai in memoria.
      out = out.in("commercial_zone_slug", scope.slugs);
      if (quartiere) out = out.eq("quartiere", quartiere);
      if (zonaOmi) out = out.eq("zona_omi", zonaOmi);
      return out as unknown as T;
    };

    // Totale globale esatto (head) con gli stessi identici filtri.
    const { count, error: countErr } = await applyFilters(
      supabase.from("padova_cambi_agenzia_by_zone_v").select("id", { count: "exact", head: true }),
    );
    if (countErr) throw countErr;
    const total = typeof count === "number" ? count : 0;
    const countExact = typeof count === "number";

    const page = pageWindow(
      url.searchParams.get("limit"),
      url.searchParams.get("offset"),
      total,
      MAX_LIMIT,
      DEFAULT_LIMIT,
    );

    let rows: Array<Record<string, unknown>> = [];
    if (!page.beyond_eof) {
      const { data, error } = await applyFilters(
        supabase
          .from("padova_cambi_agenzia_by_zone_v")
          .select(
            "id, data_cambio, portale, agenzia_precedente, agenzia_nuova, titolo, indirizzo, quartiere, zona_omi, commercial_zone_slug, prezzo_eur, mq, locali, contendibile_overlap",
          ),
      )
        .order("data_cambio", { ascending: false })
        .order("id", { ascending: false })
        .range(page.from, page.to);
      if (error) throw error;
      rows = (data ?? []) as Array<Record<string, unknown>>;
    }

    const nowMs = Date.now();
    const items = rows.map((r) => {
      const dc = r.data_cambio ? new Date(r.data_cambio as string).getTime() : nowMs;
      return {
        id: r.id,
        data_cambio: r.data_cambio ?? null,
        giorni_fa: Math.max(0, Math.floor((nowMs - dc) / (24 * 60 * 60 * 1000))),
        portale: nullableText(r.portale),
        agenzia_nuova: nullableText(r.agenzia_nuova),
        agenzia_precedente: nullableText(r.agenzia_precedente),
        // Nessun dato inventato: assente resta assente.
        titolo: nullableText(r.titolo),
        indirizzo: nullableText(r.indirizzo),
        quartiere: nullableText(r.quartiere),
        zona_omi: nullableText(r.zona_omi),
        commercial_zone_slug: nullableText(r.commercial_zone_slug),
        prezzo_eur: r.prezzo_eur !== null && r.prezzo_eur !== undefined ? Number(r.prezzo_eur) : null,
        mq: r.mq !== null && r.mq !== undefined ? Number(r.mq) : null,
        locali: r.locali ?? null,
        contendibile_overlap: r.contendibile_overlap === true,
      };
    });

    return json(
      {
        ...listEnvelope({
          items,
          total,
          limit: page.limit,
          offset: page.offset,
          // Indipendente da items.length: conteggio esatto e nessun troncamento.
          snapshot_complete: snapshotComplete({ countExact, truncated: false }),
          extra: {
            updated_at: new Date().toISOString(),
            window_days: days,
            zone_scope: scope.slugs,
            full_city: scope.full_city,
          },
        }),
        debug_id: did,
      },
      200,
      did,
    );
  } catch (e) {
    return json(
      { ok: false, debug_id: did, error: { code: "INTERNAL_ERROR", message: (e as Error).message }, items: [] },
      500,
      did,
    );
  }
});
