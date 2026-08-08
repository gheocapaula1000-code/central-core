// padova-quartieri-stats — Edge Function
// Legge padova_contendibili_by_zone_v + viste riassuntive e applica lo stesso
// isolamento server-side degli endpoint feed/list. Admin owner vede full-city
// senza assegnazione zone.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { requireSecret, makeDebugId } from "../_shared/http.ts";
import {
  applyCivikoSingleZoneGate,
  isCivikoSourceApp,
} from "../_shared/civikoZoneAccessGate.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret, x-app-secret, x-core-secret, x-source-app, x-workspace-id, x-tenant-id, x-user-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OFFICIAL_ZONES = [
  { slug: "centro-storico", nome: "Centro Storico" },
  { slug: "nord-arcella", nome: "Nord - Arcella" },
  { slug: "est-brenta", nome: "Est - Brenta" },
  { slug: "nord-est", nome: "Nord-Est" },
  { slug: "sud-est-sant-osvaldo", nome: "Sud-Est - Sant'Osvaldo" },
  { slug: "sud-voltabarozzo-guizza", nome: "Sud - Voltabarozzo / Guizza" },
  { slug: "sud-ovest-mandria", nome: "Sud-Ovest - Mandria" },
  { slug: "ovest-chiesanuova-brentelle", nome: "Ovest - Chiesanuova / Brentelle" },
] as const;

const NAME_TO_ZONE = new Map(OFFICIAL_ZONES.map((z) => [z.nome.toLowerCase(), z]));

async function fetchAll<T>(query: () => any, pageSize = 1000): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await query().range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const did = makeDebugId();

  const secretFail = requireSecret(req, did);
  if (secretFail) return secretFail;

  const workspaceId = (req.headers.get("x-workspace-id") ?? req.headers.get("x-tenant-id") ?? "").trim();
  if (!UUID_RE.test(workspaceId)) {
    return new Response(JSON.stringify({
      ok: false, data: null, debug_id: did,
      error: { code: "WORKSPACE_REQUIRED", message: "Missing or invalid workspace id" },
    }), { status: 401, headers: CORS });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: adminRes } = await supabase.rpc("civiko_is_admin_agency", { _agency_id: workspaceId });
    let isAdmin = adminRes === true;

    let authorizedSlugs: string[] = [];
    if (isAdmin) {
      authorizedSlugs = OFFICIAL_ZONES.map((z) => z.slug);
    } else {
      const { data: zonesRows, error: zoneErr } = await supabase
        .from("civiko_commercial_zones")
        .select("slug,status,occupied_agency_id,trial_agency_id,trial_reserved_until")
        .or(
          `and(status.eq.occupata,occupied_agency_id.eq.${workspaceId}),` +
            `and(status.eq.in_trial,trial_agency_id.eq.${workspaceId})`,
        );
      if (zoneErr) {
        return new Response(JSON.stringify({
          ok: false, data: null, debug_id: did,
          error: { code: "DB_ERROR", message: "zone lookup failed" },
        }), { status: 500, headers: CORS });
      }
      const now = Date.now();
      authorizedSlugs = (zonesRows ?? [])
        .filter((z: Record<string, unknown>) => {
          if (z.status === "occupata" && z.occupied_agency_id === workspaceId) return true;
          return z.status === "in_trial" &&
            z.trial_agency_id === workspaceId &&
            typeof z.trial_reserved_until === "string" &&
            new Date(z.trial_reserved_until).getTime() > now;
        })
        .map((z: Record<string, unknown>) => String(z.slug ?? ""))
        .filter((slug) => OFFICIAL_ZONES.some((z) => z.slug === slug));
      if (authorizedSlugs.length === 0) {
        return new Response(JSON.stringify({
          ok: false, data: null, debug_id: did,
          error: { code: "NO_ZONE_ASSIGNED", message: "No active zone for workspace" },
        }), { status: 403, headers: CORS });
      }
    }

    // Checkpoint 11B-A — gate "una sola zona ufficiale assegnata" (fail-closed).
    const url0 = new URL(req.url);
    const requestedZoneSlug = url0.searchParams.get("zone_slug") ?? url0.searchParams.get("commercial_zone_slug");
    // L'admin owner verificato server-side non e' un'agenzia cliente: nessun gate monozona.
    const gate = isAdmin
      ? ({ civiko: false, ok: true, slugs: authorizedSlugs } as const)
      : applyCivikoSingleZoneGate(req.headers.get("x-source-app"), authorizedSlugs, requestedZoneSlug);
    const isCivikoScope = gate.civiko;
    if (gate.civiko) {
      if (!gate.ok) {
        return new Response(JSON.stringify({
          ok: false, data: null, debug_id: did,
          error: { code: gate.code, message: "Zone access denied" },
        }), { status: 403, headers: CORS });
      }
      authorizedSlugs = gate.slugs;
      isAdmin = false;
    }

    // 1) Stats annuncio/privati/ribassi — filtro zona applicato DB-side
    //    sui nomi ufficiali delle sole zone autorizzate.
    const authorizedNames = OFFICIAL_ZONES
      .filter((z) => authorizedSlugs.includes(z.slug))
      .map((z) => z.nome);
    const rows = await fetchAll<{
      zona: string | null;
      n_contendibili: number | null;
      n_annunci: number | null;
      n_agenzie: number | null;
      n_ribassi: number | null;
      n_privati: number | null;
      prezzo_min: number | null;
      prezzo_max: number | null;
    }>(() => supabase
      .from("padova_quartieri_stats_v")
      .select("zona, n_contendibili, n_annunci, n_agenzie, n_ribassi, n_privati, prezzo_min, prezzo_max")
      .in("zona", authorizedNames));

    // 1b) Contendibili canonici dalla view by-zone, filtro zona DB-side.
    const contendibiliRows = await fetchAll<{
      commercial_zone_slug: string | null;
      n_agenzie: number | null;
    }>(() => supabase
      .from("padova_contendibili_by_zone_v")
      .select("commercial_zone_slug, n_agenzie")
      .in("commercial_zone_slug", authorizedSlugs));


    const contendibiliBySlug = new Map<string, number>();
    for (const r of contendibiliRows) {
      const slug = String(r.commercial_zone_slug ?? "");
      if (!authorizedSlugs.includes(slug)) continue;
      contendibiliBySlug.set(slug, (contendibiliBySlug.get(slug) ?? 0) + 1);
    }

    // 2) Totali globali (unica riga)
    const { data: totalsRow, error: totalsErr } = await supabase
      .from("padova_listings_totali_v")
      .select("tot_annunci, tot_agenzie")
      .maybeSingle();
    if (totalsErr) throw totalsErr;

    // 3) Totali dall'anagrafe listings (mai bloccante per le zone)
    let totali: { tot_annunci: number; tot_agenzie: number } | null = null;
    try {
      const { data: totaliRow, error: totaliErr } = await supabase
        .from("padova_totali_v")
        .select("tot_annunci, tot_agenzie")
        .maybeSingle();
      if (!totaliErr && totaliRow) {
        totali = {
          tot_annunci: Number(totaliRow.tot_annunci ?? 0),
          tot_agenzie: Number(totaliRow.tot_agenzie ?? 0),
        };
      }
    } catch (e) {
      console.error(`[padova-quartieri-stats] totali error ${did}`, e);
    }

    const statsBySlug = new Map<string, {
      n_annunci: number; n_agenzie: number; n_ribassi: number; n_privati: number;
      prezzo_min: number | null; prezzo_max: number | null;
    }>();
    for (const r of rows) {
      const z = NAME_TO_ZONE.get(String(r.zona ?? "").toLowerCase());
      if (!z || !authorizedSlugs.includes(z.slug)) continue;
      statsBySlug.set(z.slug, {
        n_annunci: Number(r.n_annunci ?? 0),
        n_agenzie: Number(r.n_agenzie ?? 0),
        n_ribassi: Number(r.n_ribassi ?? 0),
        n_privati: Number(r.n_privati ?? 0),
        prezzo_min: r.prezzo_min,
        prezzo_max: r.prezzo_max,
      });
    }

    const quartieri = OFFICIAL_ZONES
      .filter((z) => authorizedSlugs.includes(z.slug))
      .map((z) => {
        const s = statsBySlug.get(z.slug);
        return {
          quartiere: z.nome,
          commercial_zone_slug: z.slug,
          n_contendibili: contendibiliBySlug.get(z.slug) ?? 0,
          n_annunci: s?.n_annunci ?? 0,
          n_agenzie: s?.n_agenzie ?? 0,
          n_ribassi: s?.n_ribassi ?? 0,
          n_privati: s?.n_privati ?? 0,
          prezzo_min: s?.prezzo_min ?? null,
          prezzo_max: s?.prezzo_max ?? null,
        };
      })
      .sort((a, b) => b.n_contendibili - a.n_contendibili || a.quartiere.localeCompare(b.quartiere));

    // Pilot Civiko One: nessun totale globale di Padova nella risposta.
    // Tutti i totali derivano esclusivamente dalle zone autorizzate.
    const totals = isCivikoScope
      ? {
        tot_annunci: quartieri.reduce((a, q) => a + q.n_annunci, 0),
        tot_agenzie: quartieri.reduce((a, q) => a + q.n_agenzie, 0),
        tot_contendibili: quartieri.reduce((a, q) => a + q.n_contendibili, 0),
        tot_quartieri_con_contendibili: quartieri.filter((q) => q.n_contendibili > 0).length,
        scope_zones: authorizedSlugs.length,
      }
      : {
        tot_annunci: Number(totalsRow?.tot_annunci ?? 0),
        tot_agenzie: Number(totalsRow?.tot_agenzie ?? 0),
        tot_quartieri_con_contendibili: quartieri.filter((q) => q.n_contendibili > 0).length,
        scope_zones: authorizedSlugs.length,
      };
    const totaliOut = isCivikoScope ? null : totali;

    return new Response(JSON.stringify({
      ok: true,
      quartieri,
      ...totals,
      totali: totaliOut,
      assigned_zone: authorizedSlugs.length === 1 ? authorizedSlugs[0] : null,
      assigned_zones: authorizedSlugs,
      data: { quartieri, totals, totali: totaliOut, assigned_zones: authorizedSlugs },
      diagnostics: { scope: isCivikoScope ? "civiko_single_zone" : (isAdmin ? "admin_full_city" : "commercial_zone_isolated"), workspace_id: workspaceId, authorized_zones: authorizedSlugs },
      debug_id: did,
    }), { status: 200, headers: CORS });
  } catch (e) {
    console.error(`[padova-quartieri-stats] ${did}`, e);
    return new Response(JSON.stringify({
      ok: false, data: null, debug_id: did,
      error: { code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : "unknown" },
    }), { status: 500, headers: CORS });
  }
});
