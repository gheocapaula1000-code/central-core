// civiko-urban-layers — read API for PWA.
// GET ?layer=permits|piano|sentiment&commercial_zone_slug=<official>
// Zone-isolated. Invalid slug fail-closed. No secrets in responses.

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

const LAYERS = new Set(["permits", "piano", "sentiment"]);

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
      return json(200, { ok: true, layer, commercial_zone_slug: slug, count: data?.length ?? 0, items: data ?? [] });
    }

    if (layer === "piano") {
      const { data, error } = await sb
        .from("padova_piano_regolatore_by_zone_v")
        .select("id,layer_kind,zone_code,designation,title,source_url,fetched_at,commercial_zone_slug")
        .eq("commercial_zone_slug", slug)
        .order("fetched_at", { ascending: false })
        .limit(limit);
      if (error) return json(502, { ok: false, error: "query_error", source: "padova_piano_regolatore_by_zone_v" });
      return json(200, { ok: true, layer, commercial_zone_slug: slug, count: data?.length ?? 0, items: data ?? [] });
    }

    const { data, error } = await sb
      .from("microzone_sentiment_by_zone_v")
      .select("id,area_label,commercial_zone_slug,environment_score,air_quality_score,green_score,services_score,school_access_score,urban_decay_risk_score,sentiment_score_total,confidence_score,quality,data_basis,computed_at")
      .eq("commercial_zone_slug", slug)
      .eq("is_active", true)
      .order("computed_at", { ascending: false })
      .limit(limit);
    if (error) return json(502, { ok: false, error: "query_error", source: "microzone_sentiment_by_zone_v" });
    return json(200, { ok: true, layer, commercial_zone_slug: slug, count: data?.length ?? 0, items: data ?? [] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { ok: false, error: msg.slice(0, 200) });
  }
});
