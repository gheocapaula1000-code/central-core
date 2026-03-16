// OMI Geometry Import — Edge Function
// Reads GeoJSON from storage bucket and imports polygon geometries into omi_zone_geometry
// Uses insert_omi_geometry RPC for proper PostGIS geometry conversion
// Protected by AI_CORE_SECRET + origin policy
//
// Usage:
// POST /functions/v1/omi-geometry-import
// Headers: x-internal-secret: <AI_CORE_SECRET>
// Body: {
//   "storage_path": "padova_zone_omi.geojson",   // file in csv-imports bucket
//   "semestre": "2025/1",                         // optional, defaults to 2025/1
//   "comune_istat": "5028060",                    // optional fallback ISTAT code
//   "clear_first": false                          // optional, clear table before import
// }
//
// Expected GeoJSON format:
// {
//   "type": "FeatureCollection",
//   "features": [
//     {
//       "type": "Feature",
//       "properties": {
//         "COD_ZON": "B1",             // or "zona"
//         "DESCR_ZON": "CENTRO...",     // or "zona_descr"
//         "COM_ISTAT": "5028060",       // or "comune_istat"
//         "COM_DESCR": "PADOVA",        // or "comune_descrizione"
//         "PROV": "PD",                // or "provincia"
//         "LINK_ZONA": "PD00000015"     // optional — auto-resolved from omi_zone if missing
//       },
//       "geometry": { "type": "Polygon"|"MultiPolygon", "coordinates": [...] }
//     }
//   ]
// }

import {
  handleOptions,
  ok,
  fail,
  makeDebugId,
  requireSecret,
  enforceOriginPolicy,
} from "../_shared/http.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Field name aliases for different GeoJSON sources ──
const ZONA_ALIASES = ["COD_ZON", "cod_zon", "zona", "ZONA", "codice_zona"];
const DESCR_ALIASES = ["DESCR_ZON", "descr_zon", "zona_descr", "ZONA_DESCR", "descrizione"];
const ISTAT_ALIASES = ["COM_ISTAT", "com_istat", "comune_istat", "COMUNE_ISTAT", "cod_com", "COD_COM", "ISTAT"];
const COMUNE_ALIASES = ["COM_DESCR", "com_descr", "comune_descrizione", "COMUNE_DESCRIZIONE", "comune", "COMUNE"];
const PROV_ALIASES = ["PROV", "prov", "provincia", "PROVINCIA", "sigla_prov"];
const LINK_ALIASES = ["LINK_ZONA", "link_zona", "linkzona", "LINKZONA"];

function findField(props: Record<string, unknown>, aliases: string[]): string | null {
  for (const alias of aliases) {
    if (props[alias] != null && String(props[alias]).trim() !== "") {
      return String(props[alias]).trim();
    }
  }
  return null;
}

interface ParsedFeature {
  link_zona: string;
  zona: string;
  zona_descr: string | null;
  comune_istat: string;
  comune_descrizione: string;
  provincia: string;
  geojson: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = makeDebugId();

  const originErr = enforceOriginPolicy(req, debugId);
  if (originErr) return originErr;

  const authErr = requireSecret(req, debugId);
  if (authErr) return authErr;

  if (req.method !== "POST") {
    return fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId);
  }

  try {
    const body = await req.json();
    const storagePath = body.storage_path as string;
    const clearFirst = body.clear_first as boolean ?? false;
    const comuneIstatPrefix = (body.comune_istat as string) ?? "";
    const semestre = (body.semestre as string) ?? "2025/1";

    if (!storagePath) {
      return fail(req, 400, "MISSING_FIELDS", "Provide storage_path (GeoJSON file in csv-imports bucket)", debugId);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, serviceKey);

    // 1. Download GeoJSON
    console.log(`[omi-geometry-import] Downloading ${storagePath}`);
    const { data: fileData, error: dlError } = await supabase.storage
      .from("csv-imports")
      .download(storagePath);

    if (dlError || !fileData) {
      return fail(req, 400, "DOWNLOAD_ERROR", `Failed to download ${storagePath}: ${dlError?.message ?? "unknown"}`, debugId);
    }

    const rawText = await fileData.text();
    console.log(`[omi-geometry-import] File size: ${rawText.length} chars`);

    let geojson: Record<string, unknown>;
    try {
      geojson = JSON.parse(rawText);
    } catch {
      return fail(req, 400, "INVALID_GEOJSON", "File is not valid JSON", debugId);
    }

    if (geojson.type !== "FeatureCollection") {
      return fail(req, 400, "INVALID_GEOJSON", `Expected FeatureCollection, got ${geojson.type}`, debugId);
    }

    // 2. Load link_zona lookup from omi_zone
    console.log(`[omi-geometry-import] Loading link_zona lookup from omi_zone`);
    const { data: zoneData } = await supabase.from("omi_zone").select("comune_istat, zona, link_zona").limit(50000);

    const linkLookup = new Map<string, string>();
    if (zoneData) {
      for (const z of zoneData) {
        linkLookup.set(`${z.comune_istat}|${z.zona}`, z.link_zona);
        // Also with trimmed leading zeros
        const trimmed = String(z.comune_istat).replace(/^0+/, "");
        linkLookup.set(`${trimmed}|${z.zona}`, z.link_zona);
      }
    }
    console.log(`[omi-geometry-import] Loaded ${linkLookup.size} link_zona entries`);

    // 3. Parse features
    const rawFeatures = geojson.features as Array<Record<string, unknown>>;
    if (!rawFeatures || !Array.isArray(rawFeatures)) {
      return fail(req, 400, "INVALID_GEOJSON", "Missing 'features' array", debugId);
    }

    const parsed: ParsedFeature[] = [];
    const parseErrors: string[] = [];

    for (let i = 0; i < rawFeatures.length; i++) {
      const f = rawFeatures[i];
      if (!f || f.type !== "Feature") { parseErrors.push(`[${i}] not a Feature`); continue; }

      const props = (f.properties as Record<string, unknown>) ?? {};
      const geometry = f.geometry as Record<string, unknown>;

      if (!geometry?.type || !geometry?.coordinates) { parseErrors.push(`[${i}] missing geometry`); continue; }

      const geomType = String(geometry.type);
      if (geomType !== "Polygon" && geomType !== "MultiPolygon") {
        parseErrors.push(`[${i}] unsupported geometry: ${geomType}`);
        continue;
      }

      // Normalize to MultiPolygon
      const normalizedGeom = geomType === "Polygon"
        ? { type: "MultiPolygon", coordinates: [geometry.coordinates] }
        : geometry;

      const zona = findField(props, ZONA_ALIASES);
      if (!zona) { parseErrors.push(`[${i}] missing zona`); continue; }

      const zonaDescr = findField(props, DESCR_ALIASES);
      let comuneIstat = findField(props, ISTAT_ALIASES) ?? comuneIstatPrefix;
      if (!comuneIstat) { parseErrors.push(`[${i}] missing comune_istat`); continue; }

      const comuneDescr = findField(props, COMUNE_ALIASES) ?? "";
      const provincia = findField(props, PROV_ALIASES) ?? "";

      let linkZona = findField(props, LINK_ALIASES);
      if (!linkZona) {
        linkZona = linkLookup.get(`${comuneIstat}|${zona}`) ?? null;
      }
      if (!linkZona) {
        parseErrors.push(`[${i}] cannot resolve link_zona for zona=${zona} istat=${comuneIstat}`);
        continue;
      }

      parsed.push({
        link_zona: linkZona,
        zona,
        zona_descr: zonaDescr,
        comune_istat: comuneIstat,
        comune_descrizione: comuneDescr.toUpperCase(),
        provincia: provincia.toUpperCase(),
        geojson: JSON.stringify(normalizedGeom),
      });
    }

    console.log(`[omi-geometry-import] Parsed ${parsed.length} valid, ${parseErrors.length} errors`);

    if (parsed.length === 0) {
      return fail(req, 400, "NO_VALID_FEATURES", `No valid features. First errors: ${parseErrors.slice(0, 5).join("; ")}`, debugId);
    }

    // 4. Clear if requested
    if (clearFirst) {
      console.log(`[omi-geometry-import] Clearing omi_zone_geometry`);
      await supabase.rpc("clear_omi_geometry");
    }

    // 5. Insert via RPC (one at a time for geometry conversion)
    let inserted = 0;
    let insertErrors = 0;
    const failedZones: string[] = [];

    for (let i = 0; i < parsed.length; i++) {
      const f = parsed[i];
      const { error } = await supabase.rpc("insert_omi_geometry", {
        p_link_zona: f.link_zona,
        p_zona: f.zona,
        p_zona_descr: f.zona_descr,
        p_comune_istat: f.comune_istat,
        p_comune_descrizione: f.comune_descrizione,
        p_provincia: f.provincia,
        p_geojson: f.geojson,
        p_semestre: semestre,
      });

      if (error) {
        insertErrors++;
        failedZones.push(`${f.zona}: ${error.message.slice(0, 80)}`);
        console.error(`[omi-geometry-import] Insert failed zona=${f.zona}: ${error.message.slice(0, 100)}`);
      } else {
        inserted++;
      }

      if (i > 0 && i % 50 === 0) {
        console.log(`[omi-geometry-import] Progress: ${i}/${parsed.length}`);
      }
    }

    // 6. Final count
    const { count } = await supabase
      .from("omi_zone_geometry")
      .select("*", { count: "exact", head: true });

    console.log(`[omi-geometry-import] Done: inserted=${inserted} errors=${insertErrors} totalInTable=${count}`);

    return ok(req, {
      table: "omi_zone_geometry",
      storagePath,
      semestre,
      featuresInFile: rawFeatures.length,
      validFeatures: parsed.length,
      inserted,
      insertErrors,
      failedZones: failedZones.slice(0, 10),
      parseErrors: parseErrors.slice(0, 20),
      parseErrorCount: parseErrors.length,
      totalRowsInTable: count,
    }, insertErrors > 0 ? [`${insertErrors} geometries failed to insert`] : [], debugId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[omi-geometry-import] Failed: ${msg.slice(0, 200)}`);
    return fail(req, 500, "IMPORT_ERROR", `Import failed. Reference: ${debugId}`, debugId);
  }
});
