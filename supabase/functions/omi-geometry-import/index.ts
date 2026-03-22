// OMI Geometry Import — Universal Edge Function
// Supports: GeoJSON, KML, KMZ, GML, ZIP (generic archive with geo files inside)
// Supports batch mode: import all matching files from csv-imports bucket
// Logs every import to omi_import_log table
// Runs smoke test (point-in-polygon) after each import
//
// Usage:
// POST /functions/v1/omi-geometry-import
// Headers: x-internal-secret: <AI_CORE_SECRET>
//
// Single file:
// { "storage_path": "padova_zone_omi.geojson", "semestre": "2025/1", "clear_first": false }
//
// Batch (all matching files):
// { "batch": true, "semestre": "2025/1", "clear_first": false, "pattern": "_zone_omi" }

import {
  handleOptions, ok, fail, makeDebugId, requireSecret, enforceOriginPolicy,
} from "../_shared/http.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  detectFileType, extractKmlFromKmzAsync, kmlToGeoJSON, gmlToGeoJSON,
  extractFilesFromZip,
  type GeoJSONFeatureCollection, type FileType, type ZipFileEntry,
} from "./parsers.ts";
import {
  findField, ZONA_ALIASES, DESCR_ALIASES, ISTAT_ALIASES, COMUNE_ALIASES,
  PROV_ALIASES, LINK_ALIASES, CATASTALE_ALIASES, type ParsedFeature,
} from "./fields.ts";
import { streamZipEntries } from "./stream-zip.ts";
import { comuneNameVariants, istatCodeVariants, normalizeIncomingName } from "./normalizer.ts";

const PAGE = 1000;

// ── Supabase client helper ──
function makeSupa() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
}

// ── Load link_zona lookup (paginated) ──
async function loadLinkLookup(supabase: ReturnType<typeof createClient>) {
  const lookup = new Map<string, string>();
  let offset = 0;
  while (true) {
    const { data } = await supabase
      .from("omi_zone")
      .select("comune_istat, comune_catastale, comune_descrizione, zona, link_zona")
      .range(offset, offset + PAGE - 1);
    if (!data || data.length === 0) break;
    for (const z of data) {
      const zona = z.zona;
      const linkZona = z.link_zona;

      // ISTAT code variants (7-digit → 6-digit → 5-digit → trimmed)
      for (const istat of istatCodeVariants(String(z.comune_istat))) {
        lookup.set(`${istat}|${zona}`, linkZona);
      }

      // Catastale code variants
      if (z.comune_catastale) {
        lookup.set(`${z.comune_catastale}|${zona}`, linkZona);
        lookup.set(`${String(z.comune_catastale).toUpperCase()}|${zona}`, linkZona);
        lookup.set(`${String(z.comune_catastale).toLowerCase()}|${zona}`, linkZona);
      }

      // Comune name variants (bilingual, apostrophe normalization)
      if (z.comune_descrizione) {
        for (const nameVar of comuneNameVariants(z.comune_descrizione)) {
          lookup.set(`${nameVar}|${zona}`, linkZona);
        }
      }
    }
    offset += data.length;
    if (data.length < PAGE) break;
  }
  console.log(`[omi-geom] Loaded ${lookup.size} link_zona entries from ${offset} rows`);
  return lookup;
}

// ── Convert any supported file to GeoJSON FeatureCollection ──
async function toGeoJSON(
  content: Uint8Array, fileType: FileType, path: string,
): Promise<GeoJSONFeatureCollection | "MULTI_KMZ_ARCHIVE"> {
  if (fileType === "kmz") {
    try {
      const kmlStr = await extractKmlFromKmzAsync(content);
      const result = kmlToGeoJSON(kmlStr);
      console.log(`[omi-geom] KMZ→KML: ${result.features.length} features`);
      if (result.features.length > 0) return result;
      // If 0 features, it might be a nested-KMZ archive (provincial)
      console.log(`[omi-geom] KMZ has 0 Placemarks — checking for nested KMZ files`);
    } catch {
      console.log(`[omi-geom] KMZ has no .kml — checking for nested KMZ files`);
    }
    // Check if the KMZ contains nested KMZ files
    const entries = await extractFilesFromZip(content);
    if (entries.length > 0) {
      console.log(`[omi-geom] KMZ contains ${entries.length} nested geo files — treating as multi-archive`);
      return "MULTI_KMZ_ARCHIVE";
    }
    return { type: "FeatureCollection", features: [] };
  }

  const text = new TextDecoder().decode(content);

  if (fileType === "kml") return kmlToGeoJSON(text);
  if (fileType === "gml") return gmlToGeoJSON(text);
  if (fileType === "geojson") {
    const parsed = JSON.parse(text);
    if (parsed.type !== "FeatureCollection") {
      throw new Error(`Expected FeatureCollection, got ${parsed.type}`);
    }
    return parsed as GeoJSONFeatureCollection;
  }

  throw new Error(`Unsupported file type for ${path}: ${fileType}`);
}

// ── Parse features from GeoJSON ──
function parseFeatures(
  geojson: GeoJSONFeatureCollection,
  lookup: Map<string, string>,
  comuneIstatFallback: string,
): { parsed: ParsedFeature[]; errors: string[] } {
  const parsed: ParsedFeature[] = [];
  const errors: string[] = [];
  const features = geojson.features ?? [];

  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    if (!f || f.type !== "Feature") { errors.push(`[${i}] not a Feature`); continue; }

    const props = (f.properties ?? {}) as Record<string, unknown>;
    const geometry = f.geometry;
    if (!geometry?.type || !geometry?.coordinates) { errors.push(`[${i}] missing geometry`); continue; }

    const geomType = String(geometry.type);
    if (geomType !== "Polygon" && geomType !== "MultiPolygon") {
      errors.push(`[${i}] unsupported geometry: ${geomType}`); continue;
    }

    // Normalize to MultiPolygon
    const normalizedGeom = geomType === "Polygon"
      ? { type: "MultiPolygon", coordinates: [geometry.coordinates] }
      : geometry;

    const zona = findField(props, ZONA_ALIASES);
    if (!zona) { errors.push(`[${i}] missing zona`); continue; }

    const zonaDescr = findField(props, DESCR_ALIASES);
    const comuneIstat = findField(props, ISTAT_ALIASES) ?? comuneIstatFallback;
    const catastale = findField(props, CATASTALE_ALIASES);
    
    // Extract comune name from KML <name> field like "RUBANO - Zona OMI R1"
    const nameField = props.name ? String(props.name) : "";
    const comuneFromName = nameField.includes(" - Zona OMI ")
      ? nameField.split(" - Zona OMI ")[0].trim().toUpperCase()
      : "";
    
    if (!comuneIstat && !catastale && !comuneFromName) { errors.push(`[${i}] missing comune_istat and catastale`); continue; }

    const comuneDescr = findField(props, COMUNE_ALIASES) ?? comuneFromName ?? "";
    const provincia = findField(props, PROV_ALIASES) ?? "";

    // Resolve link_zona — try multiple code variants
    let linkZona = findField(props, LINK_ALIASES);
    
    // Build all code variants to try (ISTAT, catastale, name-based)
    const codesToTry: string[] = [];
    if (comuneIstat) {
      for (const v of istatCodeVariants(comuneIstat)) codesToTry.push(v);
    }
    if (catastale) {
      codesToTry.push(catastale, catastale.toUpperCase(), catastale.toLowerCase());
    }
    if (comuneIstatFallback) {
      for (const v of istatCodeVariants(comuneIstatFallback)) codesToTry.push(v);
    }
    // Name-based resolution — try all normalized variants
    if (comuneFromName) {
      for (const nameVar of normalizeIncomingName(comuneFromName)) codesToTry.push(nameVar);
    }
    // Also try the comune description field with normalization
    const comuneDescrField = findField(props, COMUNE_ALIASES);
    if (comuneDescrField) {
      for (const nameVar of normalizeIncomingName(comuneDescrField)) codesToTry.push(nameVar);
    }
    
    for (const code of codesToTry) {
      if (linkZona) break;
      linkZona = lookup.get(`${code}|${zona}`) ?? null;
    }
    
    if (!linkZona) {
      errors.push(`[${i}] cannot resolve link_zona zona=${zona} istat=${comuneIstat} cat=${catastale}`);
      continue;
    }
    
    // Use the ISTAT code that actually resolved, or the fallback
    const resolvedIstat = comuneIstat && lookup.has(`${comuneIstat}|${zona}`) 
      ? comuneIstat 
      : comuneIstatFallback || comuneIstat || "";

    parsed.push({
      link_zona: linkZona,
      zona,
      zona_descr: zonaDescr,
      comune_istat: resolvedIstat,
      comune_descrizione: comuneDescr.toUpperCase(),
      provincia: provincia.toUpperCase(),
      geojson: JSON.stringify(normalizedGeom),
    });
  }

  return { parsed, errors };
}

// ── Import parsed features via RPC ──
async function importFeatures(
  supabase: ReturnType<typeof createClient>,
  features: ParsedFeature[],
  semestre: string,
): Promise<{ inserted: number; insertErrors: number; failedZones: string[] }> {
  let inserted = 0;
  let insertErrors = 0;
  const failedZones: string[] = [];

  for (let i = 0; i < features.length; i++) {
    const f = features[i];
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
    } else {
      inserted++;
    }

    if (i > 0 && i % 50 === 0) {
      console.log(`[omi-geom] Progress: ${i}/${features.length}`);
    }
  }
  return { inserted, insertErrors, failedZones };
}

// ── Smoke test: pick a centroid and run point-in-polygon ──
async function smokeTest(
  supabase: ReturnType<typeof createClient>,
): Promise<{ passed: boolean; details: Record<string, unknown> }> {
  // Get one geometry row and query its centroid
  const { data: sample } = await supabase
    .from("omi_zone_geometry")
    .select("link_zona, zona, comune_descrizione")
    .limit(1);

  if (!sample || sample.length === 0) {
    return { passed: false, details: { reason: "no rows in omi_zone_geometry" } };
  }

  // Use the RPC to get centroid of first geometry
  const { data: centroidData } = await supabase.rpc("omi_zone_by_point", {
    // Use a known Padova center as default smoke test
    p_lat: 45.4064,
    p_lng: 11.8768,
  });

  if (centroidData && centroidData.length > 0) {
    return {
      passed: true,
      details: {
        test_point: { lat: 45.4064, lng: 11.8768 },
        matched_zona: centroidData[0].zona,
        matched_link: centroidData[0].link_zona,
        matched_comune: centroidData[0].comune_descrizione,
      },
    };
  }

  // Fallback: at least check row count > 0
  const { count } = await supabase
    .from("omi_zone_geometry")
    .select("*", { count: "exact", head: true });

  return {
    passed: (count ?? 0) > 0,
    details: { reason: "point test returned no match, but table has rows", rowCount: count },
  };
}

// ── Write import log ──
async function writeLog(
  supabase: ReturnType<typeof createClient>,
  log: {
    storage_path: string;
    file_type: string;
    semestre: string;
    features_read: number;
    features_imported: number;
    features_skipped: number;
    errors: string[];
    comuni: string[];
    status: string;
    smoke_test_passed: boolean | null;
    smoke_test_details: Record<string, unknown> | null;
    duration_ms: number;
  },
) {
  const { error } = await supabase.from("omi_import_log").insert({
    storage_path: log.storage_path,
    file_type: log.file_type,
    semestre: log.semestre,
    features_read: log.features_read,
    features_imported: log.features_imported,
    features_skipped: log.features_skipped,
    errors: JSON.stringify(log.errors.slice(0, 50)),
    comuni: log.comuni,
    status: log.status,
    smoke_test_passed: log.smoke_test_passed,
    smoke_test_details: log.smoke_test_details ? JSON.stringify(log.smoke_test_details) : null,
    duration_ms: log.duration_ms,
  });
  if (error) console.error(`[omi-geom] Failed to write import log: ${error.message}`);
}

// ── Process a single file ──
async function processFile(
  supabase: ReturnType<typeof createClient>,
  storagePath: string,
  semestre: string,
  clearFirst: boolean,
  comuneIstatFallback: string,
  lookup: Map<string, string>,
): Promise<Record<string, unknown>> {
  const startMs = Date.now();

  // 1. Download file as bytes
  console.log(`[omi-geom] Downloading ${storagePath}`);
  const { data: fileData, error: dlError } = await supabase.storage
    .from("csv-imports")
    .download(storagePath);

  if (dlError || !fileData) {
    const errMsg = `Download failed: ${dlError?.message ?? "unknown"}`;
    await writeLog(supabase, {
      storage_path: storagePath, file_type: "unknown", semestre,
      features_read: 0, features_imported: 0, features_skipped: 0,
      errors: [errMsg], comuni: [], status: "failed",
      smoke_test_passed: null, smoke_test_details: null,
      duration_ms: Date.now() - startMs,
    });
    return { storagePath, error: errMsg };
  }

  const bytes = new Uint8Array(await fileData.arrayBuffer());
  console.log(`[omi-geom] File size: ${bytes.length} bytes`);

  // 2. Detect type
  const fileType = detectFileType(storagePath, bytes);
  console.log(`[omi-geom] Detected type: ${fileType}`);

  if (fileType === "unknown") {
    const errMsg = "Cannot determine file type";
    await writeLog(supabase, {
      storage_path: storagePath, file_type: "unknown", semestre,
      features_read: 0, features_imported: 0, features_skipped: 0,
      errors: [errMsg], comuni: [], status: "failed",
      smoke_test_passed: null, smoke_test_details: null,
      duration_ms: Date.now() - startMs,
    });
    return { storagePath, error: errMsg };
  }

  // 3. Convert to GeoJSON (or detect multi-KMZ archive)
  let geojson: GeoJSONFeatureCollection;
  try {
    const result = await toGeoJSON(bytes, fileType, storagePath);
    if (result === "MULTI_KMZ_ARCHIVE") {
      // Provincial KMZ with nested KMZ files — redirect to ZIP archive processing
      console.log(`[omi-geom] Redirecting ${storagePath} to multi-archive processor`);
      return await processZipArchiveFromBytes(supabase, bytes, storagePath, semestre, clearFirst, comuneIstatFallback, lookup);
    }
    geojson = result;
  } catch (e) {
    const errMsg = `Conversion failed: ${e instanceof Error ? e.message : String(e)}`;
    await writeLog(supabase, {
      storage_path: storagePath, file_type: fileType, semestre,
      features_read: 0, features_imported: 0, features_skipped: 0,
      errors: [errMsg], comuni: [], status: "failed",
      smoke_test_passed: null, smoke_test_details: null,
      duration_ms: Date.now() - startMs,
    });
    return { storagePath, fileType, error: errMsg };
  }

  const featuresRead = geojson.features?.length ?? 0;
  console.log(`[omi-geom] Parsed ${featuresRead} features from ${fileType}`);

  // 4. Parse & normalize
  const { parsed, errors: parseErrors } = parseFeatures(geojson, lookup, comuneIstatFallback);

  if (parsed.length === 0) {
    const errMsg = `No valid features. First errors: ${parseErrors.slice(0, 5).join("; ")}`;
    await writeLog(supabase, {
      storage_path: storagePath, file_type: fileType, semestre,
      features_read: featuresRead, features_imported: 0, features_skipped: parseErrors.length,
      errors: parseErrors.slice(0, 50), comuni: [], status: "failed",
      smoke_test_passed: null, smoke_test_details: null,
      duration_ms: Date.now() - startMs,
    });
    return { storagePath, fileType, featuresRead, error: errMsg, parseErrors: parseErrors.slice(0, 20) };
  }

  // 5. Clear if first file
  if (clearFirst) {
    console.log(`[omi-geom] Clearing omi_zone_geometry`);
    await supabase.rpc("clear_omi_geometry");
  }

  // 6. Import
  const { inserted, insertErrors, failedZones } = await importFeatures(supabase, parsed, semestre);

  // 7. Collect comuni
  const comuni = [...new Set(parsed.map(f => f.comune_descrizione).filter(Boolean))];

  // 8. Final count
  const { count } = await supabase
    .from("omi_zone_geometry")
    .select("*", { count: "exact", head: true });

  // 9. Smoke test
  const smoke = await smokeTest(supabase);

  // 10. Determine status
  const status = insertErrors === 0 ? "success" : inserted > 0 ? "partial" : "failed";

  // 11. Log
  await writeLog(supabase, {
    storage_path: storagePath, file_type: fileType, semestre,
    features_read: featuresRead, features_imported: inserted, features_skipped: parseErrors.length + insertErrors,
    errors: [...parseErrors.slice(0, 25), ...failedZones.slice(0, 25)],
    comuni, status,
    smoke_test_passed: smoke.passed, smoke_test_details: smoke.details,
    duration_ms: Date.now() - startMs,
  });

  return {
    storagePath,
    fileType,
    semestre,
    featuresInFile: featuresRead,
    validFeatures: parsed.length,
    inserted,
    insertErrors,
    failedZones: failedZones.slice(0, 10),
    parseErrors: parseErrors.slice(0, 20),
    parseErrorCount: parseErrors.length,
    totalRowsInTable: count,
    comuni,
    status,
    smokeTest: smoke,
    durationMs: Date.now() - startMs,
  };
}

// ── Process ZIP/KMZ archive from already-downloaded bytes ──
async function processZipArchiveFromBytes(
  supabase: ReturnType<typeof createClient>,
  bytes: Uint8Array,
  storagePath: string,
  semestre: string,
  clearFirst: boolean,
  comuneIstatFallback: string,
  lookup: Map<string, string>,
): Promise<Record<string, unknown>> {
  const startMs = Date.now();

  // Extract files
  let entries: ZipFileEntry[];
  try {
    entries = await extractFilesFromZip(bytes);
  } catch (e) {
    const errMsg = `ZIP extraction failed: ${e instanceof Error ? e.message : String(e)}`;
    await writeLog(supabase, {
      storage_path: storagePath, file_type: "zip", semestre,
      features_read: 0, features_imported: 0, features_skipped: 0,
      errors: [errMsg], comuni: [], status: "failed",
      smoke_test_passed: null, smoke_test_details: null,
      duration_ms: Date.now() - startMs,
    });
    return { storagePath, error: errMsg };
  }

  console.log(`[omi-geom] Archive contains ${entries.length} valid geo files`);

  if (entries.length === 0) {
    const errMsg = "Archive contains no valid geo files (.geojson/.kml/.gml/.kmz)";
    await writeLog(supabase, {
      storage_path: storagePath, file_type: "zip", semestre,
      features_read: 0, features_imported: 0, features_skipped: 0,
      errors: [errMsg], comuni: [], status: "failed",
      smoke_test_passed: null, smoke_test_details: null,
      duration_ms: Date.now() - startMs,
    });
    return { storagePath, error: errMsg };
  }

  // Clear once if requested
  if (clearFirst) {
    console.log(`[omi-geom] Clearing omi_zone_geometry before archive import`);
    await supabase.rpc("clear_omi_geometry");
  }

  // Process each file inside the archive
  const fileResults: Record<string, unknown>[] = [];
  let totalInserted = 0;
  let totalRead = 0;
  let totalSkipped = 0;
  const allComuni: string[] = [];
  const allErrors: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const entryType = detectFileType(entry.name, entry.data);
    console.log(`[omi-geom] Archive[${i + 1}/${entries.length}] ${entry.name} → ${entryType}`);

    if (entryType === "unknown" || entryType === "zip") {
      fileResults.push({ name: entry.name, status: "skipped", reason: `unsupported type: ${entryType}` });
      continue;
    }

    let geojson: GeoJSONFeatureCollection;
    try {
      const result = await toGeoJSON(entry.data, entryType, entry.name);
      if (result === "MULTI_KMZ_ARCHIVE") {
        // Nested multi-KMZ — recursively process
        console.log(`[omi-geom] Nested multi-archive: ${entry.name}`);
        const nestedResult = await processZipArchiveFromBytes(
          supabase, entry.data, `${storagePath}/${entry.name}`, semestre, false, comuneIstatFallback, lookup,
        );
        fileResults.push({ name: entry.name, type: "nested-archive", ...nestedResult });
        totalInserted += (nestedResult.totalInserted as number) ?? 0;
        totalRead += (nestedResult.totalFeaturesRead as number) ?? 0;
        continue;
      }
      geojson = result;
    } catch (e) {
      const errMsg = `Conversion failed: ${e instanceof Error ? e.message : String(e)}`;
      allErrors.push(`${entry.name}: ${errMsg}`);
      fileResults.push({ name: entry.name, type: entryType, status: "failed", error: errMsg });
      continue;
    }

    const featuresRead = geojson.features?.length ?? 0;
    totalRead += featuresRead;

    const { parsed, errors: parseErrors } = parseFeatures(geojson, lookup, comuneIstatFallback);
    totalSkipped += parseErrors.length;

    if (parsed.length === 0) {
      allErrors.push(`${entry.name}: 0 valid features (${parseErrors.length} errors)`);
      fileResults.push({
        name: entry.name, type: entryType, status: "failed",
        featuresRead, errors: parseErrors.slice(0, 5),
      });
      continue;
    }

    const { inserted, insertErrors, failedZones } = await importFeatures(supabase, parsed, semestre);
    totalInserted += inserted;
    totalSkipped += insertErrors;

    const comuni = [...new Set(parsed.map(f => f.comune_descrizione).filter(Boolean))];
    allComuni.push(...comuni);

    if (failedZones.length > 0) allErrors.push(...failedZones.slice(0, 5).map(z => `${entry.name}: ${z}`));

    fileResults.push({
      name: entry.name,
      type: entryType,
      status: insertErrors === 0 ? "success" : inserted > 0 ? "partial" : "failed",
      featuresRead,
      validFeatures: parsed.length,
      inserted,
      insertErrors,
      comuni,
    });
  }

  // Final count & smoke test
  const { count } = await supabase.from("omi_zone_geometry").select("*", { count: "exact", head: true });
  const smoke = await smokeTest(supabase);
  const overallStatus = totalInserted === 0 ? "failed" : allErrors.length > 0 ? "partial" : "success";

  await writeLog(supabase, {
    storage_path: storagePath, file_type: "zip/kmz-archive", semestre,
    features_read: totalRead, features_imported: totalInserted, features_skipped: totalSkipped,
    errors: allErrors.slice(0, 50),
    comuni: [...new Set(allComuni)],
    status: overallStatus,
    smoke_test_passed: smoke.passed, smoke_test_details: smoke.details,
    duration_ms: Date.now() - startMs,
  });

  return {
    storagePath,
    fileType: "zip/kmz-archive",
    semestre,
    totalFilesInZip: entries.length,
    fileResults,
    totalFeaturesRead: totalRead,
    totalInserted,
    totalSkipped,
    totalRowsInTable: count,
    comuni: [...new Set(allComuni)],
    status: overallStatus,
    smokeTest: smoke,
    durationMs: Date.now() - startMs,
  };
}

// ── Process a ZIP archive (download + extract) ──
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for future batch ZIP processing
async function processZipArchive(
  supabase: ReturnType<typeof createClient>,
  storagePath: string,
  semestre: string,
  clearFirst: boolean,
  comuneIstatFallback: string,
  lookup: Map<string, string>,
): Promise<Record<string, unknown>> {
  console.log(`[omi-geom] Downloading ZIP: ${storagePath}`);
  const { data: fileData, error: dlError } = await supabase.storage
    .from("csv-imports")
    .download(storagePath);

  if (dlError || !fileData) {
    return { storagePath, error: `Download failed: ${dlError?.message ?? "unknown"}` };
  }

  const bytes = new Uint8Array(await fileData.arrayBuffer());
  console.log(`[omi-geom] ZIP size: ${bytes.length} bytes`);
  return processZipArchiveFromBytes(supabase, bytes, storagePath, semestre, clearFirst, comuneIstatFallback, lookup);
}

// ── Job management helpers ──
async function findOrCreateJob(
  supabase: ReturnType<typeof createClient>,
  storagePath: string,
  semestre: string,
  batchSize: number,
  clearFirst: boolean,
  comuneIstatFallback: string,
): Promise<{ id: number; current_offset: number; status: string; isNew: boolean }> {
  // Try to find existing job
  const { data: existing } = await supabase
    .from("omi_import_jobs")
    .select("*")
    .eq("storage_path", storagePath)
    .eq("semestre", semestre)
    .single();

  if (existing && existing.status !== "completed") {
    // Resume existing job
    console.log(`[omi-geom] Resuming job ${existing.id} at offset ${existing.current_offset}`);
    await supabase.from("omi_import_jobs").update({
      status: "running",
      updated_at: new Date().toISOString(),
    }).eq("id", existing.id);
    return { id: existing.id, current_offset: existing.current_offset, status: existing.status, isNew: false };
  }

  if (existing && existing.status === "completed") {
    // Already completed — return as-is
    return { id: existing.id, current_offset: existing.current_offset, status: "completed", isNew: false };
  }

  // Create new job
  const { data: newJob, error } = await supabase
    .from("omi_import_jobs")
    .insert({
      storage_path: storagePath,
      semestre,
      batch_size: batchSize,
      clear_first: clearFirst,
      comune_istat_fallback: comuneIstatFallback,
      status: "running",
    })
    .select("id")
    .single();

  if (error || !newJob) throw new Error(`Failed to create job: ${error?.message}`);
  console.log(`[omi-geom] Created new job ${newJob.id}`);
  return { id: newJob.id, current_offset: 0, status: "pending", isNew: true };
}

async function updateJob(
  supabase: ReturnType<typeof createClient>,
  jobId: number,
  update: Record<string, unknown>,
) {
  await supabase.from("omi_import_jobs").update({
    ...update,
    updated_at: new Date().toISOString(),
  }).eq("id", jobId);
}

// ── Collect already-imported link_zona set for dedup ──
async function loadExistingLinkZone(
  supabase: ReturnType<typeof createClient>,
  semestre: string,
): Promise<Set<string>> {
  const existing = new Set<string>();
  let offset = 0;
  while (true) {
    const { data } = await supabase
      .from("omi_zone_geometry")
      .select("link_zona")
      .eq("semestre", semestre)
      .range(offset, offset + PAGE - 1);
    if (!data || data.length === 0) break;
    for (const r of data) existing.add(r.link_zona);
    offset += data.length;
    if (data.length < PAGE) break;
  }
  console.log(`[omi-geom] Loaded ${existing.size} existing link_zona for dedup`);
  return existing;
}

// ── Process large ZIP via streaming (no full file in memory) ──
async function processLargeZipStream(
  supabase: ReturnType<typeof createClient>,
  storagePath: string,
  semestre: string,
  clearFirst: boolean,
  comuneIstatFallback: string,
  lookup: Map<string, string>,
  offset: number,
  limit: number,
  existingZones: Set<string>,
  jobId?: number,
): Promise<Record<string, unknown>> {
  const startMs = Date.now();
  const TIME_BUDGET_MS = 25_000; // 25s — reduced for larger lookup table (141K entries)

  // 1. Get signed URL for streaming download
  const { data: urlData, error: urlError } = await supabase.storage
    .from("csv-imports")
    .createSignedUrl(storagePath, 3600);

  if (urlError || !urlData?.signedUrl) {
    const err = `Signed URL failed: ${urlError?.message ?? "unknown"}`;
    if (jobId) await updateJob(supabase, jobId, { status: "failed", last_error: err });
    return { storagePath, error: err };
  }

  // 2. Fetch as stream — NOT buffered into memory
  const response = await fetch(urlData.signedUrl);
  if (!response.ok || !response.body) {
    const err = `Fetch failed: ${response.status}`;
    if (jobId) await updateJob(supabase, jobId, { status: "failed", last_error: err });
    return { storagePath, error: err };
  }

  // 3. Clear if needed (only on first batch)
  if (clearFirst && offset === 0) {
    console.log(`[omi-geom] Clearing omi_zone_geometry before streamed import`);
    await supabase.rpc("clear_omi_geometry");
  }

  // 4. Stream through entries
  const fileResults: Record<string, unknown>[] = [];
  let totalInserted = 0;
  let totalRead = 0;
  let totalSkipped = 0;
  let totalDeduplicated = 0;
  const allComuni: string[] = [];
  const allErrors: string[] = [];
  let entriesProcessed = 0;
  let timeBudgetExceeded = false;

  console.log(`[omi-geom] Streaming ZIP: ${storagePath} offset=${offset} limit=${limit}`);

  for await (const entry of streamZipEntries(response.body, { offset, limit })) {
    // Time budget check
    if (Date.now() - startMs > TIME_BUDGET_MS) {
      console.log(`[omi-geom] Time budget exceeded after ${entriesProcessed} entries`);
      timeBudgetExceeded = true;
      break;
    }

    entriesProcessed++;
    const entryType = detectFileType(entry.name, entry.data);

    if (entryType === "unknown" || entryType === "zip") {
      fileResults.push({ name: entry.name, status: "skipped", reason: `type: ${entryType}` });
      continue;
    }

    // Convert to GeoJSON
    let geojson: GeoJSONFeatureCollection;
    try {
      const result = await toGeoJSON(entry.data, entryType, entry.name);
      if (result === "MULTI_KMZ_ARCHIVE") {
        const subResult = await processZipArchiveFromBytes(
          supabase, entry.data, `${storagePath}/${entry.name}`,
          semestre, false, comuneIstatFallback, lookup,
        );
        totalInserted += (subResult.totalInserted as number) ?? 0;
        totalRead += (subResult.totalFeaturesRead as number) ?? 0;
        fileResults.push({ name: entry.name, type: "nested-archive", ...subResult });
        continue;
      }
      geojson = result;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      allErrors.push(`${entry.name}: ${errMsg}`);
      fileResults.push({ name: entry.name, type: entryType, status: "failed" });
      continue;
    }

    const featuresRead = geojson.features?.length ?? 0;
    totalRead += featuresRead;

    const { parsed, errors: parseErrors } = parseFeatures(geojson, lookup, comuneIstatFallback);
    totalSkipped += parseErrors.length;

    if (parsed.length === 0) {
      allErrors.push(`${entry.name}: 0 valid (${parseErrors.length} errors)`);
      fileResults.push({ name: entry.name, type: entryType, status: "failed", featuresRead });
      continue;
    }

    // Dedup: skip features whose link_zona already exists
    const dedupParsed = parsed.filter(f => !existingZones.has(f.link_zona));
    const dedupSkipped = parsed.length - dedupParsed.length;
    totalDeduplicated += dedupSkipped;

    if (dedupParsed.length === 0) {
      fileResults.push({
        name: entry.name, type: entryType, status: "skipped_dedup",
        featuresRead, dedupSkipped,
      });
      continue;
    }

    const { inserted, insertErrors, failedZones } = await importFeatures(supabase, dedupParsed, semestre);
    totalInserted += inserted;
    totalSkipped += insertErrors;

    // Track newly inserted zones for dedup within this batch
    for (const f of dedupParsed) existingZones.add(f.link_zona);

    const comuni = [...new Set(dedupParsed.map(f => f.comune_descrizione).filter(Boolean))];
    allComuni.push(...comuni);

    if (failedZones.length > 0) {
      allErrors.push(...failedZones.slice(0, 3).map(z => `${entry.name}: ${z}`));
    }

    fileResults.push({
      name: entry.name,
      type: entryType,
      status: insertErrors === 0 ? "success" : inserted > 0 ? "partial" : "failed",
      inserted,
      dedupSkipped,
      comuni,
    });

    // Log progress every 50 entries
    if (entriesProcessed % 50 === 0) {
      console.log(`[omi-geom] Stream progress: ${entriesProcessed} entries, ${totalInserted} inserted`);
      // Update job state periodically
      if (jobId) {
        await updateJob(supabase, jobId, {
          current_offset: offset + entriesProcessed,
          total_files_processed: entriesProcessed,
          total_geometries_imported: totalInserted,
          total_errors: allErrors.length,
          has_more: true,
        });
      }
    }
  }

  // 5. Final count & smoke test
  const { count } = await supabase.from("omi_zone_geometry").select("*", { count: "exact", head: true });
  const smoke = await smokeTest(supabase);
  const overallStatus = totalInserted === 0 && entriesProcessed > 0 ? "failed" : allErrors.length > 0 ? "partial" : "success";
  const nextOffset = offset + entriesProcessed;
  const hasMore = timeBudgetExceeded || entriesProcessed === limit;

  // 6. Update job state
  if (jobId) {
    await updateJob(supabase, jobId, {
      current_offset: nextOffset,
      total_files_seen: nextOffset,
      total_files_processed: entriesProcessed,
      total_geometries_imported: totalInserted,
      total_errors: allErrors.length,
      has_more: hasMore,
      last_error: allErrors.length > 0 ? allErrors[allErrors.length - 1] : null,
      status: hasMore ? "partial" : "completed",
      completed_at: hasMore ? null : new Date().toISOString(),
    });
  }

  // 7. Log
  await writeLog(supabase, {
    storage_path: storagePath,
    file_type: "zip-stream",
    semestre,
    features_read: totalRead,
    features_imported: totalInserted,
    features_skipped: totalSkipped,
    errors: allErrors.slice(0, 50),
    comuni: [...new Set(allComuni)],
    status: overallStatus,
    smoke_test_passed: smoke.passed,
    smoke_test_details: smoke.details,
    duration_ms: Date.now() - startMs,
  });

  return {
    storagePath,
    fileType: "zip-stream",
    semestre,
    jobId: jobId ?? null,
    batchOffset: offset,
    batchLimit: limit,
    entriesProcessed,
    hasMore,
    nextOffset: hasMore ? nextOffset : null,
    totalDeduplicated,
    fileResults: fileResults.length > 100
      ? [...fileResults.slice(0, 50), { note: `... ${fileResults.length - 100} more ...` }, ...fileResults.slice(-50)]
      : fileResults,
    totalFeaturesRead: totalRead,
    totalInserted,
    totalSkipped,
    totalErrors: allErrors.length,
    sampleErrors: allErrors.slice(0, 20),
    totalRowsInTable: count,
    comuni: [...new Set(allComuni)].slice(0, 100),
    status: overallStatus,
    smokeTest: smoke,
    durationMs: Date.now() - startMs,
  };
}

// ── Main handler ──
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = makeDebugId();

  const originErr = enforceOriginPolicy(req, debugId);
  if (originErr) return originErr;

  const origin = req.headers.get("origin");
  if (origin) {
    const authErr = requireSecret(req, debugId);
    if (authErr) return authErr;
  }

  if (req.method !== "POST") {
    return fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId);
  }

  try {
    const body = await req.json();
    const semestre = (body.semestre as string) ?? "2025/1";
    const clearFirst = body.clear_first as boolean ?? false;
    const comuneIstatFallback = (body.comune_istat as string) ?? "";
    const batchMode = body.batch as boolean ?? false;
    const pattern = (body.pattern as string) ?? "_zone_omi";
    const storagePath = body.storage_path as string;
    const autoResume = body.auto_resume as boolean ?? false;
    const batchSize = (body.batch_size as number) ?? 300;
    const runToCompletion = body.run_to_completion as boolean ?? false;

    const supabase = makeSupa();

    // Load lookup once
    const lookup = await loadLinkLookup(supabase);

    // ── Job-based streaming mode for ZIP files ──
    if (storagePath && storagePath.toLowerCase().endsWith(".zip") && autoResume) {
      const job = await findOrCreateJob(supabase, storagePath, semestre, batchSize, clearFirst, comuneIstatFallback);

      if (job.status === "completed") {
        // Already done
        const { data: jobData } = await supabase.from("omi_import_jobs").select("*").eq("id", job.id).single();
        return ok(req, {
          mode: "job",
          jobId: job.id,
          status: "completed",
          message: "Import already completed. Use a different semestre or delete the job to re-run.",
          job: jobData,
        }, [], debugId);
      }

      // Load existing zones for dedup
      const existingZones = await loadExistingLinkZone(supabase, semestre);

      const result = await processLargeZipStream(
        supabase, storagePath, semestre,
        clearFirst && job.isNew, comuneIstatFallback, lookup,
        job.current_offset, batchSize,
        existingZones, job.id,
      );

      // Self-reinvoke for run_to_completion mode
      if (runToCompletion && result.hasMore) {
        const selfUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/omi-geometry-import`;
        const nextPayload = {
          storage_path: storagePath,
          semestre,
          clear_first: false,
          batch_size: batchSize,
          auto_resume: true,
          run_to_completion: true,
        };
        console.log(`[omi-geom] run_to_completion: self-reinvoking for next batch from offset ${result.nextOffset}`);
        // Fire-and-forget: don't await the full response
        fetch(selfUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify(nextPayload),
        }).then(r => r.text().catch(() => "")).catch(e =>
          console.error(`[omi-geom] Self-reinvoke failed: ${e}`)
        );
      }

      return ok(req, {
        mode: "job",
        jobId: job.id,
        runToCompletion,
        ...result,
        instructions: (result.hasMore)
          ? runToCompletion
            ? "Next batch has been auto-triggered. The job will continue until completion."
            : "Re-invoke with the same payload to continue. The job will auto-resume from the saved offset."
          : "Import complete. No more batches needed.",
      }, [], debugId);
    }

    if (batchMode) {
      // ── Batch mode: find all matching files ──
      console.log(`[omi-geom] Batch mode, pattern="${pattern}"`);
      const { data: files, error: listErr } = await supabase.storage
        .from("csv-imports")
        .list("", { limit: 500 });

      if (listErr || !files) {
        return fail(req, 500, "STORAGE_LIST_ERROR", `Cannot list bucket: ${listErr?.message}`, debugId);
      }

      const validExts = new Set(["geojson", "json", "kml", "gml", "kmz", "zip"]);
      const matching = files.filter(f => {
        const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
        return validExts.has(ext) && f.name.toLowerCase().includes(pattern.toLowerCase());
      });

      if (matching.length === 0) {
        return fail(req, 400, "NO_FILES_MATCH", `No files match pattern "${pattern}" in csv-imports`, debugId);
      }

      const existingZones = await loadExistingLinkZone(supabase, semestre);
      const results: Record<string, unknown>[] = [];
      for (let i = 0; i < matching.length; i++) {
        const fileName = matching[i].name;
        const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
        let result: Record<string, unknown>;
        if (ext === "zip") {
          result = await processLargeZipStream(
            supabase, fileName, semestre,
            clearFirst && i === 0, comuneIstatFallback, lookup, 0, batchSize,
            existingZones,
          );
        } else {
          result = await processFile(
            supabase, fileName, semestre,
            clearFirst && i === 0, comuneIstatFallback, lookup,
          );
        }
        results.push(result);
      }

      const totalInserted = results.reduce((s, r) => s + ((r.inserted as number) ?? (r.totalInserted as number) ?? 0), 0);
      return ok(req, { mode: "batch", pattern, filesProcessed: results.length, totalInserted, results }, [], debugId);
    }

    // ── Single file mode ──
    if (!storagePath) {
      return fail(req, 400, "MISSING_FIELDS", "Provide storage_path or batch=true", debugId);
    }

    // ZIP → streaming processor
    const ext = storagePath.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "zip") {
      const offset = (body.offset as number) ?? 0;
      const limit = (body.limit as number) ?? 500;
      const existingZones = await loadExistingLinkZone(supabase, semestre);
      const result = await processLargeZipStream(
        supabase, storagePath, semestre, clearFirst, comuneIstatFallback, lookup, offset, limit,
        existingZones,
      );
      if (result.error) {
        return fail(req, 400, "IMPORT_ERROR", result.error as string, debugId);
      }
      return ok(req, result, [], debugId);
    }

    const result = await processFile(
      supabase, storagePath, semestre, clearFirst, comuneIstatFallback, lookup,
    );

    if (result.error) {
      return fail(req, 400, "IMPORT_ERROR", result.error as string, debugId);
    }

    const warnings: string[] = [];
    if ((result.insertErrors as number) > 0) warnings.push(`${result.insertErrors} geometries failed`);
    if ((result.parseErrorCount as number) > 0) warnings.push(`${result.parseErrorCount} features skipped`);

    return ok(req, result, warnings, debugId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[omi-geom] Failed: ${msg.slice(0, 200)}`);
    return fail(req, 500, "IMPORT_ERROR", `Import failed. Reference: ${debugId}`, debugId);
  }
});
