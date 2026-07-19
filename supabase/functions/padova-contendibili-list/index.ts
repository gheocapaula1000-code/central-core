// padova-contendibili-list — Edge Function
// Ritorna le righe da public.padova_contendibili con filtri opzionali.
// Auth: verify_jwt=false (default Lovable). Chiamata via core-proxy della PWA.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret, x-source-app",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

const BANNED = /\b(AI|IA|intelligenza|stima|perizia|valutazione|valore reale|prezzo giusto|garantito|garantita|garantiti|garantite)\b/gi;
function sanitize(s: unknown): unknown {
  if (typeof s === "string") return s.replace(BANNED, "rilevato");
  if (Array.isArray(s)) return s.map(sanitize);
  if (s && typeof s === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) o[k] = sanitize(v);
    return o;
  }
  return s;
}

const debugId = () => crypto.randomUUID().slice(0, 8);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const did = debugId();

  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const url = new URL(req.url);
    const quartiere = (body.quartiere ?? url.searchParams.get("quartiere") ?? null) as string | null;
    const min_agenzie = Number(body.min_agenzie ?? url.searchParams.get("min_agenzie") ?? 2) || 2;
    const limit = Math.min(Math.max(Number(body.limit ?? url.searchParams.get("limit") ?? 500) || 500, 1), 1000);
    const offset = Math.max(Number(body.offset ?? url.searchParams.get("offset") ?? 0) || 0, 0);
    const tenantAgencyRaw = (body.tenant_agency_name ?? url.searchParams.get("tenant_agency_name") ?? null) as string | null;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let q = supabase
      .from("padova_contendibili")
      .select("id, chiave_match, n_agenzie, agenzie, agencies_normalized, fonti, confidenza, prezzo_min, prezzo_max, mq, locali, bagni, quartiere, lat, lng, urls, prezzo_medio_zona_eur_mq, prezzo_immobile_eur_mq, differenza_zona_pct, giorni_sul_mercato, data_primo_annuncio, ribasso_pct, n_ribassi, is_ripubblicato, cambio_agenzia, giorni_fermo, n_portali, score_pressione", { count: "exact" })
      .gte("n_agenzie", min_agenzie);
    if (quartiere) q = q.eq("quartiere", quartiere);

    // Ordinamento: score_pressione DESC (segnali pressione), poi rank confidenza lato JS
    q = q.order("score_pressione", { ascending: false }).range(offset, offset + limit - 1);

    const { data, error, count } = await q;
    if (error) throw error;

    const rank: Record<string, number> = { ALTA: 0, MEDIA: 1, DA_CONFERMARE: 2 };
    const rows = (data ?? []).slice().sort((a, b) => {
      if (b.n_agenzie !== a.n_agenzie) return b.n_agenzie - a.n_agenzie;
      return (rank[a.confidenza] ?? 9) - (rank[b.confidenza] ?? 9);
    });

    // ── Reachability layer (argento/oro/bronzo) ──────────────────────────
    const ids = rows.map((r) => r.id).filter((v) => v != null);
    const reachMap = new Map<number, { argento: boolean; count: number; hasPhone: boolean; bestListingId: number | null }>();
    if (ids.length > 0) {
      const { data: reachRows, error: reachErr } = await supabase
        .from("padova_contendibili_reachability_v")
        .select("id, reachability_argento, argento_match_count, argento_has_phone, argento_best_listing_id")
        .in("id", ids);
      if (reachErr) console.error(`[padova-contendibili-list] ${did} reach`, reachErr);
      for (const r of (reachRows ?? []) as Array<Record<string, unknown>>) {
        reachMap.set(Number(r.id), {
          argento: Boolean(r.reachability_argento),
          count: Number(r.argento_match_count ?? 0),
          hasPhone: Boolean(r.argento_has_phone),
          bestListingId: r.argento_best_listing_id == null ? null : Number(r.argento_best_listing_id),
        });
      }
    }

    // Normalizza tenant (se fornito) usando la stessa norm_agency() del recompute
    let tenantNorm: string | null = null;
    if (tenantAgencyRaw && tenantAgencyRaw.trim()) {
      const { data: nn } = await supabase.rpc("norm_agency", { p: tenantAgencyRaw });
      tenantNorm = typeof nn === "string" && nn.trim() ? nn.trim() : null;
    }

    const enrichedRows = rows.map((r) => {
      const rr = reachMap.get(Number(r.id)) ?? { argento: false, count: 0, hasPhone: false, bestListingId: null };
      const agNorm = Array.isArray(r.agencies_normalized) ? r.agencies_normalized as string[] : [];
      const isOro = tenantNorm ? agNorm.some((a) => (a || "").toLowerCase().trim() === tenantNorm!.toLowerCase().trim()) : false;
      const tier = isOro ? "oro" : (rr.argento ? "argento" : "bronzo");
      return {
        ...r,
        reachability: {
          tier,
          argento_match_count: rr.count,
          argento_has_phone: rr.hasPhone,
          argento_best_listing_id: rr.bestListingId,
        },
      };
    });

    // hot_3plus = totale (non solo pagina) con n_agenzie>=3
    const { count: hot } = await supabase
      .from("padova_contendibili")
      .select("chiave_match", { count: "exact", head: true })
      .gte("n_agenzie", 3);

    // ── Diagnostics scope Padova OMI ─────────────────────────────────────
    // padova_contendibili è già per costruzione SOLO Padova Comune; il filtro
    // qui resta a livello di quartiere (alias leggibile). La granularità
    // ufficiale è 22 zone OMI: il count delle zone-con-dati è derivato dal
    // breakdown geografico ufficiale via point-in-polygon.
    const sourceBreakdown: Record<string, number> = {};
    const omiAliasBreakdown: Record<string, number> = {};
    for (const r of rows) {
      for (const f of (r.fonti ?? [])) sourceBreakdown[f] = (sourceBreakdown[f] ?? 0) + 1;
      const q = (r.quartiere ?? "n/d").toString();
      omiAliasBreakdown[q] = (omiAliasBreakdown[q] ?? 0) + 1;
    }
    let omiZonesWithData = 0;
    try {
      const since = new Date(Date.now() - 14 * 86400 * 1000).toISOString();
      const { data: omiB } = await supabase.rpc("padova_omi_snapshot_breakdown", { p_since: since });
      omiZonesWithData = (omiB ?? []).filter((r: any) => Number(r.snapshot_count ?? 0) > 0).length;
    } catch { /* RPC non disponibile */ }

    const diagnostics = {
      scope: "padova_omi_zones",
      municipality_applied: "Padova",
      omi_zones_expected: 22,
      omi_zones_with_data: omiZonesWithData,
      total_candidates_scanned: count ?? rows.length,
      total_after_filters: rows.length,
      excluded_not_padova: 0, // garantito a monte: tabella padova_contendibili è Padova-only
      excluded_no_omi_zone: 0,
      excluded_low_confidence: 0,
      returned: rows.length,
      source_breakdown: sourceBreakdown,
      omi_alias_breakdown: omiAliasBreakdown,
    };

    const payload = sanitize({
      ok: true,
      data: {
        items: enrichedRows,
        total: count ?? enrichedRows.length,
        hot_3plus: hot ?? 0,
        offset,
        limit,
        diagnostics,
      },
      diagnostics,
      debug_id: did,
    });

    return new Response(JSON.stringify(payload), { status: 200, headers: CORS });
  } catch (e) {
    console.error(`[padova-contendibili-list] ${did}`, e);
    return new Response(JSON.stringify({
      ok: false, data: null, debug_id: did,
      error: { code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : "unknown" },
    }), { status: 500, headers: CORS });
  }
});
