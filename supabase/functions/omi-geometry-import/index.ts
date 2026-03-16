// OMI Geometry Import — Edge Function
// Reads GeoJSON from storage bucket and imports polygon geometries into omi_zone_geometry
// Supports standard GeoJSON FeatureCollection format
// Protected by AI_CORE_SECRET + origin policy
//
// Expected GeoJSON format (from Geopoi or other sources):
// {
//   "type": "FeatureCollection",
//   "features": [
//     {
//       "type": "Feature",
//       "properties": {
//         "COD_ZON": "B1",           // zona code
//         "DESCR_ZON": "CENTRO...",   // zona description
//         "COM_ISTAT": "028060",      // comune ISTAT code
//         "COM_DESCR": "PADOVA",      // comune name
//         "PROV": "PD",              // provincia
//         "LINK_ZONA": "PD00000015"   // link_zona (may need construction)
//       },
//       "geometry": {
//         "type": "MultiPolygon" | "Polygon",
//         "coordinates": [...]
//       }
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

const BATCH_SIZE = 100; // Smaller batches for geometry data (larger rows)

// ── Known field mappings from different GeoJSON sources ──
// Geopoi KML→GeoJSON typically uses uppercase field names
const ZONA_FIELD_ALIASES = ["COD_ZON", "cod_zon", "zona", "ZONA", "codice_zona", "zone_code"];
const ZONA_DESCR_ALIASES = ["DESCR_ZON", "descr_zon", "zona_descr", "ZONA_DESCR", "descrizione", "zone_descr"];
const COMUNE_ISTAT_ALIASES = ["COM_ISTAT", "com_istat", "comune_istat", "COMUNE_ISTAT", "cod_com", "COD_COM", "ISTAT"];
const COMUNE_DESCR_ALIASES = ["COM_DESCR", "com_descr", "comune_descrizione", "COMUNE_DESCRIZIONE", "comune", "COMUNE"];
const PROVINCIA_ALIASES = ["PROV", "prov", "provincia", "PROVINCIA", "sigla_prov"];
const LINK_ZONA_ALIASES = ["LINK_ZONA", "link_zona", "linkzona", "LINKZONA"];

function findField(props: Record<string, unknown>, aliases: string[]): string | null {
  for (const alias of aliases) {
    if (props[alias] != null && String(props[alias]).trim() !== "") {
      return String(props[alias]).trim();
    }
  }
  return null;
}

/**
 * Build a link_zona if not present in the GeoJSON properties.
 * Convention: PROV + 8-digit padded number based on comune_istat + zona
 * This tries to match existing link_zona in omi_zone table.
 */
function buildLinkZona(provincia: string, comuneIstat: string, zona: string, linkZonaLookup: Map<string, string>): string | null {
  // Try direct lookup from omi_zone table data
  const key = `${comuneIstat}|${zona}`;
  if (linkZonaLookup.has(key)) {
    return linkZonaLookup.get(key)!;
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
  geojson_geometry: string; // JSON string of the geometry
}

function parseFeatures(
  geojson: Record<string, unknown>,
  linkZonaLookup: Map<string, string>,
  comuneIstatPrefix: string,
): { features: ParsedFeature[]; errors: string[] } {
  const errors: string[] = [];
  const features: ParsedFeature[] = [];

  const rawFeatures = geojson.features as Array<Record<string, unknown>>;
  if (!rawFeatures || !Array.isArray(rawFeatures)) {
    errors.push("GeoJSON must be a FeatureCollection with 'features' array");
    return { features, errors };
  }

  for (let i = 0; i < rawFeatures.length; i++) {
    const f = rawFeatures[i];
    if (!f || f.type !== "Feature") {
      errors.push(`Feature ${i}: not a valid GeoJSON Feature`);
      continue;
    }

    const props = (f.properties as Record<string, unknown>) ?? {};
    const geometry = f.geometry as Record<string, unknown>;

    if (!geometry || !geometry.type || !geometry.coordinates) {
      errors.push(`Feature ${i}: missing geometry`);
      continue;
    }

    // Normalize geometry type
    const geomType = String(geometry.type);
    if (geomType !== "Polygon" && geomType !== "MultiPolygon") {
      errors.push(`Feature ${i}: unsupported geometry type '${geomType}', expected Polygon or MultiPolygon`);
      continue;
    }

    // Convert Polygon to MultiPolygon for consistency
    let normalizedGeometry: Record<string, unknown>;
    if (geomType === "Polygon") {
      normalizedGeometry = {
        type: "MultiPolygon",
        coordinates: [geometry.coordinates],
      };
    } else {
      normalizedGeometry = geometry;
    }

    // Extract fields
    const zona = findField(props, ZONA_FIELD_ALIASES);
    const zonaDescr = findField(props, ZONA_DESCR_ALIASES);
    let comuneIstat = findField(props, COMUNE_ISTAT_ALIASES);
    const comuneDescr = findField(props, COMUNE_DESCR_ALIASES);
    const provincia = findField(props, PROVINCIA_ALIASES);
    let linkZona = findField(props, LINK_ZONA_ALIASES);

    if (!zona) {
      errors.push(`Feature ${i}: missing zona code`);
      continue;
    }
    if (!comuneDescr && !comuneIstat) {
      errors.push(`Feature ${i}: missing both comune_descrizione and comune_istat`);
      continue;
    }

    // Normalize comune_istat: ensure proper format
    if (comuneIstat && !comuneIstat.includes("0")) {
      // Might need padding
    }
    // If comune_istat not in the GeoJSON, use the prefix passed by the user
    if (!comuneIstat && comuneIstatPrefix) {
      comuneIstat = comuneIstatPrefix;
    }
    if (!comuneIstat) {
      errors.push(`Feature ${i}: missing comune_istat and no prefix provided`);
      continue;
    }

    // Try to resolve link_zona from omi_zone table
    if (!linkZona) {
      linkZona = buildLinkZona(provincia ?? "", comuneIstat, zona, linkZonaLookup);
    }
    if (!linkZona) {
      errors.push(`Feature ${i}: could not resolve link_zona for zona=${zona} comune_istat=${comuneIstat}. Provide link_zona in GeoJSON or ensure omi_zone table has matching records.`);
      continue;
    }

    features.push({
      link_zona: linkZona,
      zona,
      zona_descr: zonaDescr,
      comune_istat: comuneIstat,
      comune_descrizione: (comuneDescr ?? "").toUpperCase(),
      provincia: (provincia ?? "").toUpperCase(),
      geojson_geometry: JSON.stringify(normalizedGeometry),
    });
  }

  return { features, errors };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = makeDebugId();

  // Origin policy
  const originErr = enforceOriginPolicy(req, debugId);
  if (originErr) return originErr;

  // Auth guard
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
      return fail(req, 400, "MISSING_FIELDS", "Provide storage_path (path to GeoJSON in csv-imports bucket)", debugId);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, serviceKey);

    // Step 1: Download GeoJSON from storage
    console.log(`[omi-geometry-import] Downloading ${storagePath} from csv-imports bucket`);
    const { data: fileData, error: dlError } = await supabase.storage
      .from("csv-imports")
      .download(storagePath);

    if (dlError || !fileData) {
      return fail(req, 400, "DOWNLOAD_ERROR", `Failed to download ${storagePath}: ${dlError?.message ?? "unknown"}`, debugId);
    }

    const rawText = await fileData.text();
    console.log(`[omi-geometry-import] File size: ${rawText.length} chars`);

    // Step 2: Parse GeoJSON
    let geojson: Record<string, unknown>;
    try {
      geojson = JSON.parse(rawText);
    } catch {
      return fail(req, 400, "INVALID_GEOJSON", "File is not valid JSON", debugId);
    }

    if (geojson.type !== "FeatureCollection") {
      return fail(req, 400, "INVALID_GEOJSON", `Expected FeatureCollection, got ${geojson.type}`, debugId);
    }

    // Step 3: Load link_zona lookup from omi_zone table
    console.log(`[omi-geometry-import] Loading link_zona lookup from omi_zone`);
    const { data: zoneData } = await supabase
      .from("omi_zone")
      .select("comune_istat, zona, link_zona")
      .limit(50000);

    const linkZonaLookup = new Map<string, string>();
    if (zoneData) {
      for (const z of zoneData) {
        // Key by full ISTAT code + zona
        linkZonaLookup.set(`${z.comune_istat}|${z.zona}`, z.link_zona);
        // Also try with trimmed 6-digit code
        const trimmed = String(z.comune_istat).replace(/^0+/, "");
        linkZonaLookup.set(`${trimmed}|${z.zona}`, z.link_zona);
      }
    }
    console.log(`[omi-geometry-import] Loaded ${linkZonaLookup.size} link_zona entries`);

    // Step 4: Parse features
    const { features, errors: parseErrors } = parseFeatures(geojson, linkZonaLookup, comuneIstatPrefix);
    console.log(`[omi-geometry-import] Parsed ${features.length} valid features, ${parseErrors.length} errors`);

    if (features.length === 0) {
      return fail(req, 400, "NO_VALID_FEATURES", `No valid features found. Errors: ${parseErrors.slice(0, 5).join("; ")}`, debugId);
    }

    // Step 5: Clear existing data if requested
    if (clearFirst) {
      console.log(`[omi-geometry-import] Clearing existing omi_zone_geometry data`);
      const { error: delErr } = await supabase.from("omi_zone_geometry").delete().gte("id", 0);
      if (delErr) {
        console.error(`[omi-geometry-import] Clear error: ${delErr.message}`);
      }
    }

    // Step 6: Insert in batches using raw SQL via RPC for geometry conversion
    let inserted = 0;
    let insertErrors = 0;

    for (let i = 0; i < features.length; i += BATCH_SIZE) {
      const batch = features.slice(i, i + BATCH_SIZE);

      // Build values for batch insert
      // Use ST_GeomFromGeoJSON for proper geometry conversion
      const values = batch.map((f) => {
        return `(
          '${f.link_zona.replace(/'/g, "''")}',
          '${f.zona.replace(/'/g, "''")}',
          ${f.zona_descr ? `'${f.zona_descr.replace(/'/g, "''")}'` : "NULL"},
          '${f.comune_istat.replace(/'/g, "''")}',
          '${f.comune_descrizione.replace(/'/g, "''")}',
          '${f.provincia.replace(/'/g, "''")}',
          extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${f.geojson_geometry.replace(/'/g, "''")}'), 4326),
          '${semestre}'
        )`;
      }).join(",\n");

      const sql = `
        INSERT INTO public.omi_zone_geometry (link_zona, zona, zona_descr, comune_istat, comune_descrizione, provincia, geom, semestre)
        VALUES ${values}
      `;

      const { error: insertErr } = await supabase.rpc("exec_sql", { sql_query: sql }).maybeSingle();

      if (insertErr) {
        // Fallback: try individual inserts
        console.warn(`[omi-geometry-import] Batch insert failed (batch ${Math.floor(i / BATCH_SIZE)}): ${insertErr.message}`);

        // Try one by one
        for (const f of batch) {
          const singleSql = `
            INSERT INTO public.omi_zone_geometry (link_zona, zona, zona_descr, comune_istat, comune_descrizione, provincia, geom, semestre)
            VALUES (
              '${f.link_zona.replace(/'/g, "''")}',
              '${f.zona.replace(/'/g, "''")}',
              ${f.zona_descr ? `'${f.zona_descr.replace(/'/g, "''")}'` : "NULL"},
              '${f.comune_istat.replace(/'/g, "''")}',
              '${f.comune_descrizione.replace(/'/g, "''")}',
              '${f.provincia.replace(/'/g, "''")}',
              extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${f.geojson_geometry.replace(/'/g, "''")}'), 4326),
              '${semestre}'
            )
          `;
          const { error: singleErr } = await supabase.rpc("exec_sql", { sql_query: singleSql }).maybeSingle();
          if (singleErr) {
            console.error(`[omi-geometry-import] Single insert failed for ${f.zona}: ${singleErr.message}`);
            insertErrors++;
          } else {
            inserted++;
          }
        }
      } else {
        inserted += batch.length;
      }

      if (i % 500 === 0 && i > 0) {
        console.log(`[omi-geometry-import] Progress: ${i}/${features.length}`);
      }
    }

    // Step 7: Validate
    const { data: countData } = await supabase
      .from("omi_zone_geometry")
      .select("id", { count: "exact", head: true });

    const totalRows = countData ? (countData as unknown as { count: number }).count : null;

    console.log(`[omi-geometry-import] Done: inserted=${inserted} errors=${insertErrors} parseErrors=${parseErrors.length}`);

    return ok(req, {
      table: "omi_zone_geometry",
      storagePath,
      semestre,
      totalFeatures: features.length,
      inserted,
      insertErrors,
      parseErrors: parseErrors.slice(0, 20),
      parseErrorCount: parseErrors.length,
      totalRowsInTable: totalRows,
    }, parseErrors.length > 0 ? [`${parseErrors.length} features could not be parsed`] : [], debugId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[omi-geometry-import] Import failed: ${msg.slice(0, 200)}`);
    return fail(req, 500, "IMPORT_ERROR", `Import failed. Reference: ${debugId}`, debugId);
  }
});
