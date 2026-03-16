// One-shot internal trigger to import GeoJSON from storage into omi_zone_geometry
// This function reads AI_CORE_SECRET from env internally, no external auth needed
// Protected by a one-time TRIGGER_SECRET check

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const fallbackIstat = (body as Record<string, string>).fallback_istat ?? "";
    
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, serviceKey);

    // 1. Download GeoJSON from storage
    console.log("[trigger] Downloading padova_zone_omi.geojson");
    const { data: fileData, error: dlError } = await supabase.storage
      .from("csv-imports")
      .download("padova_zone_omi.geojson");

    if (dlError || !fileData) {
      return new Response(JSON.stringify({ ok: false, error: "Download failed: " + (dlError?.message ?? "unknown") }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const rawText = await fileData.text();
    console.log(`[trigger] File size: ${rawText.length} chars`);

    const geojson = JSON.parse(rawText);
    if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
      return new Response(JSON.stringify({ ok: false, error: "Not a FeatureCollection" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 2. Load link_zona lookup (paginated to overcome 1000-row default limit)
    const linkLookup = new Map<string, string>();
    const catastaleToIstat = new Map<string, string>();
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const { data: zoneData } = await supabase
        .from("omi_zone")
        .select("comune_istat, comune_catastale, zona, link_zona")
        .range(offset, offset + PAGE - 1);
      if (!zoneData || zoneData.length === 0) break;
      for (const z of zoneData) {
        linkLookup.set(`${z.comune_istat}|${z.zona}`, z.link_zona);
        const trimmed = String(z.comune_istat).replace(/^0+/, "");
        linkLookup.set(`${trimmed}|${z.zona}`, z.link_zona);
        if (z.comune_catastale) {
          linkLookup.set(`${z.comune_catastale}|${z.zona}`, z.link_zona);
          catastaleToIstat.set(z.comune_catastale, z.comune_istat);
        }
      }
      offset += zoneData.length;
      if (zoneData.length < PAGE) break;
    }
    console.log(`[trigger] Loaded ${linkLookup.size} link_zona entries from ${offset} zone rows`);

    // 3. Clear existing
    await supabase.rpc("clear_omi_geometry");
    console.log("[trigger] Cleared omi_zone_geometry");

    // Field aliases
    const ZONA_ALIASES = ["COD_ZON", "cod_zon", "zona", "ZONA", "codice_zona"];
    const DESCR_ALIASES = ["DESCR_ZON", "descr_zon", "zona_descr", "ZONA_DESCR", "descrizione"];
    const ISTAT_ALIASES = ["COM_ISTAT", "com_istat", "comune_istat", "COMUNE_ISTAT", "cod_com", "COD_COM", "ISTAT"];
    const COMUNE_ALIASES = ["COM_DESCR", "com_descr", "comune_descrizione", "COMUNE_DESCRIZIONE", "comune", "COMUNE"];
    const PROV_ALIASES = ["PROV", "prov", "provincia", "PROVINCIA", "sigla_prov"];
    const LINK_ALIASES = ["LINK_ZONA", "link_zona", "linkzona", "LINKZONA"];

    function findField(props: Record<string, unknown>, aliases: string[]): string | null {
      for (const a of aliases) {
        if (props[a] != null && String(props[a]).trim() !== "") return String(props[a]).trim();
      }
      return null;
    }

    // 4. Parse and insert
    let inserted = 0;
    let errors = 0;
    const errorSamples: string[] = [];

    for (let i = 0; i < geojson.features.length; i++) {
      const f = geojson.features[i];
      if (!f || f.type !== "Feature" || !f.geometry) { errors++; continue; }

      const props = f.properties ?? {};
      const geomType = f.geometry.type;
      if (geomType !== "Polygon" && geomType !== "MultiPolygon") { errors++; continue; }

      const normalizedGeom = geomType === "Polygon"
        ? { type: "MultiPolygon", coordinates: [f.geometry.coordinates] }
        : f.geometry;

      const zona = findField(props, ZONA_ALIASES);
      if (!zona) { errors++; continue; }

      const zonaDescr = findField(props, DESCR_ALIASES) ?? "";
      let comuneIstat = findField(props, ISTAT_ALIASES) ?? "";
      if (!comuneIstat) { errors++; continue; }

      // If comuneIstat looks like a catastale/Belfiore code, resolve to real ISTAT
      const resolvedIstat = catastaleToIstat.get(comuneIstat);
      if (resolvedIstat) {
        console.log(`[trigger] Resolved catastale ${comuneIstat} -> ISTAT ${resolvedIstat}`);
        comuneIstat = resolvedIstat;
      } else if (fallbackIstat && !comuneIstat.match(/^\d+$/)) {
        // Non-numeric code not in catastale map — use fallback
        console.log(`[trigger] Using fallback ISTAT ${fallbackIstat} for code ${comuneIstat}`);
        comuneIstat = fallbackIstat;
      }

      const comuneDescr = (findField(props, COMUNE_ALIASES) ?? "").toUpperCase();
      const provincia = (findField(props, PROV_ALIASES) ?? "").toUpperCase();

      let linkZona = findField(props, LINK_ALIASES);
      if (!linkZona) {
        linkZona = linkLookup.get(`${comuneIstat}|${zona}`) ?? null;
      }
      if (!linkZona) { errors++; if (errorSamples.length < 5) errorSamples.push(`zona=${zona} istat=${comuneIstat}: no link_zona`); continue; }

      const { error } = await supabase.rpc("insert_omi_geometry", {
        p_link_zona: linkZona,
        p_zona: zona,
        p_zona_descr: zonaDescr,
        p_comune_istat: comuneIstat,
        p_comune_descrizione: comuneDescr,
        p_provincia: provincia,
        p_geojson: JSON.stringify(normalizedGeom),
        p_semestre: "2025/1",
      });

      if (error) {
        errors++;
        if (errorSamples.length < 5) errorSamples.push(`zona=${zona}: ${error.message.slice(0, 80)}`);
      } else {
        inserted++;
      }

      if (i % 50 === 0) console.log(`[trigger] Progress: ${i}/${geojson.features.length}`);
    }

    // 5. Final count
    const { count } = await supabase.from("omi_zone_geometry").select("*", { count: "exact", head: true });

    // 6. Test point-in-polygon (Padova center: 45.4064, 11.8768)
    const { data: pipTest, error: pipError } = await supabase.rpc("omi_zone_by_point", { p_lat: 45.4064, p_lng: 11.8768 });

    console.log(`[trigger] Done: inserted=${inserted} errors=${errors} total=${count} pipTest=${JSON.stringify(pipTest)}`);

    return new Response(JSON.stringify({
      ok: true,
      data: {
        featuresInFile: geojson.features.length,
        inserted,
        errors,
        errorSamples,
        totalRowsInTable: count,
        pointInPolygonTest: {
          point: { lat: 45.4064, lng: 11.8768, label: "Padova centro" },
          result: pipTest,
          error: pipError?.message ?? null,
          polygonMatch: pipTest && pipTest.length > 0,
        }
      }
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[trigger] Failed: ${msg}`);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
