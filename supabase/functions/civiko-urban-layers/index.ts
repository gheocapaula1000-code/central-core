// civiko-urban-layers — read API for PWA.
// GET ?layer=permits|cantieri|piano|sentiment&commercial_zone_slug=<official>
// Returns real rows or honest empty. Never invents cards.
// Grants tables and apartment-floor helpers are out of scope.

import { createClient } from "npm:@supabase/supabase-js@2";
import { requireZoneSlug } from "../_shared/padovaUrbanLayers.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const LAYERS = new Set(["permits", "cantieri", "piano", "sentiment"]);

function emptyPayload(layer: string, slug: string) {
  const documented =
    layer === "permits"
      ? {
        empty_reason: "no_official_sue_rows",
        collector: "civiko-sue-padova-collect",
        note: "Official Comune SUE pages are procedural. CKAN is Padova-only; OSM construction persists only when Overpass returns Padova rows. CSV import is /import/sue-permits + compliance_verified. Never invents permits.",
      }
      : layer === "piano"
      ? {
        empty_reason: "no_piano_rows_for_zone",
        collector: "civiko-piano-regolatore-collect",
        note: "Official PAT/PI MapServers on cartografia.comune.padova.it. sit.padovanet.it does not resolve. Empty until a feature maps to this commercial zone.",
      }
      : layer === "sentiment"
      ? {
        empty_reason: "no_zone_scoped_sentiment",
        collector: "civiko-sentiment-refresh",
        note: "Zone cards are written only from zone-scoped inputs (listings/permits/signals/elderly). Comune-level ARPAV rows are not copied onto the 8 slugs.",
      }
      : {
        empty_reason: "no_zone_rows",
        collector: "connector-osm-cantieri",
        note: "Cantieri come from OSM construction → local_signals. Empty until a row maps to this commercial zone.",
      };
  return {
    ok: true,
    layer,
    commercial_zone_slug: slug,
    count: 0,
    empty: true,
    items: [] as unknown[],
    ...documented,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return json(405, { ok: false, error: "method_not_allowed" });

  const url = new URL(req.url);
  const layer = (url.searchParams.get("layer") ?? "").trim();
  const slugRaw = url.searchParams.get("commercial_zone_slug");
  const parsed = requireZoneSlug(slugRaw);
  if (!parsed.ok) return json(400, { ok: false, error: parsed.error });
  if (!LAYERS.has(layer)) {
    return json(400, { ok: false, error: "LAYER_UNKNOWN", allowed: [...LAYERS] });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const slug = parsed.slug;
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 80) || 80));

  try {
    if (layer === "permits") {
      const { data, error } = await sb
        .from("sue_padova_permits_by_zone_v")
        .select("id,area_name,address_public,practice_type,practice_date,status,source_url,fetched_at,commercial_zone_slug,compliance_verified")
        .eq("commercial_zone_slug", slug)
        .order("fetched_at", { ascending: false })
        .limit(limit);
      if (error) return json(502, { ok: false, error: "query_error", source: "sue_padova_permits_by_zone_v" });
      const items = data ?? [];
      if (items.length === 0) return json(200, emptyPayload(layer, slug));
      return json(200, { ok: true, layer, commercial_zone_slug: slug, count: items.length, empty: false, items });
    }

    if (layer === "cantieri") {
      const { data, error } = await sb
        .from("local_signals_by_zone_v")
        .select("id,title,summary,category,location_text,lat,lng,neighborhood,commercial_zone_slug,evidence_url,detected_at,confidence,source_level")
        .eq("commercial_zone_slug", slug)
        .eq("municipality", "Padova")
        .order("detected_at", { ascending: false })
        .limit(limit);
      if (error) return json(502, { ok: false, error: "query_error", source: "local_signals_by_zone_v" });
      const items = data ?? [];
      if (items.length === 0) return json(200, emptyPayload(layer, slug));
      return json(200, { ok: true, layer, commercial_zone_slug: slug, count: items.length, empty: false, items });
    }

    if (layer === "piano") {
      const { data, error } = await sb
        .from("padova_piano_regolatore_by_zone_v")
        .select("id,layer_kind,zone_code,designation,title,source_url,fetched_at,commercial_zone_slug")
        .eq("commercial_zone_slug", slug)
        .order("fetched_at", { ascending: false })
        .limit(limit);
      if (error) return json(502, { ok: false, error: "query_error", source: "padova_piano_regolatore_by_zone_v" });
      const items = data ?? [];
      if (items.length === 0) return json(200, emptyPayload(layer, slug));
      return json(200, { ok: true, layer, commercial_zone_slug: slug, count: items.length, empty: false, items });
    }

    const { data, error } = await sb
      .from("microzone_sentiment_by_zone_v")
      .select("id,area_label,commercial_zone_slug,environment_score,air_quality_score,green_score,services_score,school_access_score,urban_decay_risk_score,sentiment_score_total,confidence_score,quality,data_basis,computed_at")
      .eq("commercial_zone_slug", slug)
      .eq("is_active", true)
      .order("computed_at", { ascending: false })
      .limit(limit);
    if (error) return json(502, { ok: false, error: "query_error", source: "microzone_sentiment_by_zone_v" });
    const items = data ?? [];
    if (items.length === 0) return json(200, emptyPayload(layer, slug));
    return json(200, { ok: true, layer, commercial_zone_slug: slug, count: items.length, empty: false, items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { ok: false, error: msg.slice(0, 200) });
  }
});
