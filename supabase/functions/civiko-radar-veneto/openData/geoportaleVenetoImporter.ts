// ═══════════════════════════════════════════════════════════════
// Geoportale Veneto — controlled WFS layer import → territorial_signals
//
// Strategy:
//   - fetch GetFeature (GeoJSON) per layer, count <= maxFeaturesPerLayer
//   - resolve comune/provincia per feature (direct → istat → nome)
//   - filter by allowed province
//   - cap by maxImportRecords across all layers
//   - dedup by fingerprint(layer + comune + provincia + feature_id_hash)
//   - signal_type per layer family
//   - dryRun: returns full report, writes nothing
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  buildIstatLookup,
  inferComuneProvinciaFromProperties,
  geometryCentroid,
  sanitizeProperties,
  type IstatCache,
} from "./geoportaleSpatialJoin.ts";

const WFS_URL = "https://idt2-geoserver.regione.veneto.it/geoserver/ows";

type SignalType =
  | "risk_constraint_dataset"
  | "seismic_risk_dataset"
  | "protected_area_dataset"
  | "planning_constraints_dataset"
  | "landscape_constraint_dataset";

// Per-layer config: signal_type, topic, title, impact, and how to filter by province via WFS CQL.
// `provinceFilter`: builder fn that returns CQL_FILTER for selected provinces (PD/VE/BL) or null if no server-side filter possible.
const PROV_TO_CODE: Record<string, string> = { PD: "28", VE: "27", BL: "25", VI: "24", VR: "23", TV: "26", RO: "29" };

const LAYER_META: Record<string, {
  signal_type: SignalType; topic: string; title: string; impact: number;
  provinceFilter?: (provs: string[]) => string | null;
}> = {
  // Uses 5-digit a_codice with province prefix (28/27/25...)
  "rv:c1102011_vincoloidrogeolog": {
    signal_type: "risk_constraint_dataset", topic: "vincoli", title: "Vincolo idrogeologico", impact: -0.4,
    provinceFilter: (ps) => {
      const codes = ps.map((p) => PROV_TO_CODE[p]).filter(Boolean);
      if (!codes.length) return null;
      // CQL: a_codice LIKE '28%' OR a_codice LIKE '27%' ...
      return codes.map((c) => `a_codice LIKE '${c}%'`).join(" OR ");
    },
  },
  // Has provincia column directly
  "rv:c0508011_classsismica": {
    signal_type: "seismic_risk_dataset", topic: "rischio", title: "Classificazione sismica", impact: -0.2,
    provinceFilter: (ps) => ps.map((p) => `provincia='${p}'`).join(" OR "),
  },
  // Parchi: 17 features only — no province col, fetch all then filter via geometry/comune (best-effort)
  "rv:c1102051_parchiistituiti_2025": {
    signal_type: "protected_area_dataset", topic: "parchi", title: "Parchi istituiti", impact: 0.3,
    provinceFilter: () => null,
  },
  "rv:c1102071_vincoloforestale": {
    signal_type: "planning_constraints_dataset", topic: "vincoli", title: "Vincolo forestale", impact: -0.3,
    provinceFilter: (ps) => {
      const codes = ps.map((p) => PROV_TO_CODE[p]).filter(Boolean);
      if (!codes.length) return null;
      return codes.map((c) => `cod_istat LIKE '${c}%'`).join(" OR ");
    },
  },
  "rv:c1102101_vincolosismico": {
    signal_type: "seismic_risk_dataset", topic: "vincoli", title: "Vincolo sismico", impact: -0.3,
    provinceFilter: () => null,
  },
};

interface LayerReport {
  layer_name: string;
  title: string;
  features_read: number;
  features_with_direct_comune: number;
  features_with_cod_istat: number;
  features_spatial_joined: number;
  features_unassigned: number;
  features_in_PD: number;
  features_in_VE: number;
  features_in_BL: number;
  geometry_type?: string;
  crs_detected?: string;
  importable_count: number;
  sample_assigned_features: any[];
  sample_unassigned_features: any[];
  warnings: string[];
  errors: string[];
}

export interface GeoportaleImportParams {
  dryRun?: boolean;
  import?: boolean;
  layers?: string[];
  province?: string[];
  maxFeaturesPerLayer?: number;
  maxImportRecords?: number;
}

function fp(layer: string, comune: string, provincia: string, featKey: string): string {
  return `geoportale|${layer}|${comune}|${provincia}|${featKey}`;
}

function featureKey(props: Record<string, unknown>): string {
  for (const k of ["id", "fid", "OBJECTID", "objectid", "id1", "id_vfor", "id_ambito"]) {
    if (props[k] != null) return `${k}=${String(props[k])}`;
  }
  // hash of stable props
  const s = JSON.stringify(props);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `h=${h}`;
}

async function fetchLayer(layer: string, count: number): Promise<{ ok: boolean; features?: any[]; crs?: string; geomType?: string; error?: string }> {
  const url = `${WFS_URL}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(layer)}&count=${count}&outputFormat=application/json&srsName=EPSG:4326`;
  try {
    const r = await fetch(url);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const txt = await r.text();
    let json: any;
    try { json = JSON.parse(txt); }
    catch { return { ok: false, error: "non_json_response" }; }
    const feats = (json.features ?? []) as any[];
    const crs = json.crs?.properties?.name ?? "EPSG:4326 (requested)";
    const geomType = feats[0]?.geometry?.type;
    return { ok: true, features: feats, crs, geomType };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function runGeoportaleImport(params: GeoportaleImportParams) {
  const dryRun = params.dryRun !== false;
  const doImport = params.import === true && !dryRun;
  const layers = (params.layers ?? Object.keys(LAYER_META)).filter((l) => LAYER_META[l]);
  const provinceFilter = new Set((params.province ?? ["PD", "VE", "BL"]).map((p) => p.toUpperCase()));
  const maxFeat = params.maxFeaturesPerLayer ?? 100;
  const cap = params.maxImportRecords ?? 200;

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Build ISTAT cache from public.classificazione_sismica (8101 rows, full Italy)
  const { data: istatRows, error: istatErr } = await sb
    .from("classificazione_sismica")
    .select("codice_istat, comune")
    .limit(10000);
  if (istatErr) {
    return { ok: false, error: "istat_lookup_failed", message: istatErr.message };
  }
  const istat: IstatCache = buildIstatLookup(istatRows ?? []);

  const reports: LayerReport[] = [];
  const candidateInserts: any[] = [];

  for (const layer of layers) {
    const meta = LAYER_META[layer];
    const rep: LayerReport = {
      layer_name: layer,
      title: meta.title,
      features_read: 0,
      features_with_direct_comune: 0,
      features_with_cod_istat: 0,
      features_spatial_joined: 0,
      features_unassigned: 0,
      features_in_PD: 0, features_in_VE: 0, features_in_BL: 0,
      importable_count: 0,
      sample_assigned_features: [],
      sample_unassigned_features: [],
      warnings: [],
      errors: [],
    };

    const r = await fetchLayer(layer, maxFeat);
    if (!r.ok) {
      rep.errors.push(`fetch_failed: ${r.error}`);
      reports.push(rep);
      continue;
    }
    rep.features_read = r.features!.length;
    rep.crs_detected = r.crs;
    rep.geometry_type = r.geomType;

    for (const feat of r.features!) {
      const props = (feat.properties ?? {}) as Record<string, unknown>;
      const inferred = inferComuneProvinciaFromProperties(props, istat);
      if (!inferred) {
        rep.features_unassigned++;
        if (rep.sample_unassigned_features.length < 3) {
          rep.sample_unassigned_features.push({ keys: Object.keys(props).slice(0, 8), sample: sanitizeProperties(props, 6) });
        }
        continue;
      }
      if (inferred.method === "direct") rep.features_with_direct_comune++;
      else if (inferred.method === "istat") rep.features_with_cod_istat++;
      else rep.features_spatial_joined++; // (currently 'nome')

      // province filter
      if (!provinceFilter.has(inferred.provincia)) continue;
      if (inferred.provincia === "PD") rep.features_in_PD++;
      if (inferred.provincia === "VE") rep.features_in_VE++;
      if (inferred.provincia === "BL") rep.features_in_BL++;

      const centroid = geometryCentroid(feat.geometry);
      const fkey = featureKey(props);
      const fingerprint = fp(layer, inferred.comune, inferred.provincia, fkey);
      const sanProps = sanitizeProperties(props, 12);

      const row = {
        fingerprint,
        source_name: "Geoportale Regione Veneto",
        source_url: `${WFS_URL}?typeNames=${layer}`,
        signal_type: meta.signal_type,
        signal_subtype: meta.topic,
        province: inferred.provincia,
        municipality: inferred.comune,
        lat: centroid?.lat ?? null,
        lng: centroid?.lng ?? null,
        title: `${meta.title} — ${inferred.comune} (${inferred.provincia})`,
        description: `Layer ${layer} (${meta.title}) — feature attribuita a ${inferred.comune} via ${inferred.method}. Fonte: Geoportale Regione Veneto (WFS).`,
        data_basis: `geoportale_veneto,wfs,${meta.topic}`,
        quality: "reale",
        confidence_score: inferred.method === "istat" ? 0.9 : inferred.method === "direct" ? 0.95 : 0.7,
        impact_direction: meta.impact >= 0 ? "positive" : "negative",
        impact_strength: Math.abs(meta.impact),
        payload: {
          layer_name: layer,
          method: inferred.method,
          properties: sanProps,
          geometry_type: feat.geometry?.type,
          centroid,
        },
        is_active: true,
      };

      if (rep.sample_assigned_features.length < 5) {
        rep.sample_assigned_features.push({
          comune: inferred.comune, provincia: inferred.provincia, method: inferred.method,
          centroid, sample_props: sanProps,
        });
      }
      rep.importable_count++;
      candidateInserts.push(row);
    }
    reports.push(rep);
  }

  // Cap globally
  let toInsert = candidateInserts.slice(0, cap);
  const cappedAt = candidateInserts.length > cap ? cap : candidateInserts.length;

  // Dedup against existing fingerprints
  let skippedExisting = 0;
  let inserted = 0;
  let sourceDocsCreated = 0;
  if (doImport && toInsert.length) {
    const fps = toInsert.map((r) => r.fingerprint);
    const { data: existing } = await sb
      .from("territorial_signals")
      .select("fingerprint")
      .in("fingerprint", fps);
    const existSet = new Set((existing ?? []).map((e: any) => e.fingerprint));
    const fresh = toInsert.filter((r) => !existSet.has(r.fingerprint));
    skippedExisting = toInsert.length - fresh.length;

    if (fresh.length) {
      // Batched insert
      const chunkSize = 100;
      for (let i = 0; i < fresh.length; i += chunkSize) {
        const chunk = fresh.slice(i, i + chunkSize);
        const { error } = await sb.from("territorial_signals").insert(chunk);
        if (error) {
          return { ok: false, error: "insert_failed", message: error.message, inserted };
        }
        inserted += chunk.length;
      }
    }

    // Source documents (one per layer)
    for (const layer of layers) {
      const meta = LAYER_META[layer];
      const rep = reports.find((r) => r.layer_name === layer);
      if (!rep || rep.importable_count === 0) continue;
      const docHash = `geoportale|doc|${layer}`;
      const { data: existDoc } = await sb
        .from("source_documents")
        .select("id").eq("content_hash", docHash).limit(1);
      if (existDoc && existDoc.length) continue;
      const { error: docErr } = await sb.from("source_documents").insert({
        content_hash: docHash,
        source_name: "Geoportale Regione Veneto",
        source_type: "wfs_layer",
        source_url: `${WFS_URL}?service=WFS&request=GetFeature&typeNames=${layer}`,
        url: `${WFS_URL}?service=WFS&request=GetFeature&typeNames=${layer}&outputFormat=application/json`,
        title: `${meta.title} (${layer})`,
        text_excerpt: `Layer WFS Geoportale Regione Veneto — ${meta.title}. Topic: ${meta.topic}.`,
        data_basis: "geoportale_veneto,wfs",
        quality: "reale",
        classification: meta.topic,
        importability: true,
        metadata: { layer_name: layer, signal_type: meta.signal_type, features_imported: rep.importable_count },
      });
      if (!docErr) sourceDocsCreated++;
    }
  }

  return {
    ok: true,
    job: "import-geoportale-veneto-layers",
    dryRun,
    import: doImport,
    province_filter: Array.from(provinceFilter),
    layers_processed: layers,
    reports,
    candidates_total: candidateInserts.length,
    capped_at: cappedAt,
    territorial_signals_created: inserted,
    skipped_existing: skippedExisting,
    source_documents_created: sourceDocsCreated,
    coverage_PD: reports.reduce((s, r) => s + r.features_in_PD, 0),
    coverage_VE: reports.reduce((s, r) => s + r.features_in_VE, 0),
    coverage_BL: reports.reduce((s, r) => s + r.features_in_BL, 0),
    recommendation: dryRun
      ? (candidateInserts.length > 0
          ? "DRY_RUN_OK: re-run with import=true to persist."
          : "NO_CANDIDATES: review province filter or layer list.")
      : `IMPORTED: ${inserted} signals across ${layers.length} layers.`,
  };
}
