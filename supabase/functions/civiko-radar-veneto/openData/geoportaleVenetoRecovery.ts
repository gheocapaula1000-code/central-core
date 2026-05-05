// ═══════════════════════════════════════════════════════════════
// Geoportale Veneto — RECOVERY pass for previously unassigned features.
//
// Strategy (only for features that the base importer could NOT assign):
//   1. Alias lookup (S./Cad./apostrophes/accents)
//   2. Fuzzy match on textual props (Dice >= 0.92, clear runner-up gap)
//   3. Point-in-polygon via omi_zone_by_point(centroid) — only Veneto
//
// Constraints:
//   - never invents comuni; only canonical VENETO_COMUNI names
//   - dedups against existing fingerprints (same scheme as base importer)
//   - dryRun by default; import=true persists only NEW recovered rows
//   - confidence: alias=0.85, fuzzy=0.75, pip=0.7
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  buildIstatLookup,
  inferComuneProvinciaFromProperties,
  geometryCentroid,
  sanitizeProperties,
  type IstatCache,
} from "./geoportaleSpatialJoin.ts";
import { inferFromTextProperties } from "./geoportaleComuneAliases.ts";
import { VENETO_COMUNI } from "./venetoComuni.ts";

const WFS_URL = "https://idt2-geoserver.regione.veneto.it/geoserver/ows";

type SignalType =
  | "risk_constraint_dataset"
  | "seismic_risk_dataset"
  | "protected_area_dataset";

const LAYER_META: Record<string, { signal_type: SignalType; topic: string; title: string; impact: number }> = {
  "rv:c1102011_vincoloidrogeolog": { signal_type: "risk_constraint_dataset", topic: "vincoli", title: "Vincolo idrogeologico", impact: -0.4 },
  "rv:c0508011_classsismica":       { signal_type: "seismic_risk_dataset",    topic: "rischio", title: "Classificazione sismica", impact: -0.2 },
  "rv:c1102051_parchiistituiti_2025": { signal_type: "protected_area_dataset", topic: "parchi",  title: "Parchi istituiti",       impact: 0.3 },
};

interface RecoveryReport {
  layer_name: string;
  title: string;
  features_read: number;
  base_assigned: number;
  alias_assigned: number;
  fuzzy_assigned: number;
  spatial_joined: number;
  still_unassigned: number;
  recovered_count: number;
  importable_count: number;
  in_PD: number; in_VE: number; in_BL: number;
  sample_recovered: any[];
  sample_unassigned: any[];
  warnings: string[];
  errors: string[];
}

export interface RecoveryParams {
  dryRun?: boolean;
  import?: boolean;
  layers?: string[];
  province?: string[];
  maxFeaturesPerLayer?: number;
  maxImportRecords?: number;
  fuzzyThreshold?: number;
  enableSpatialJoin?: boolean; // PIP via omi_zone_by_point
}

function fp(layer: string, comune: string, provincia: string, featKey: string): string {
  return `geoportale|${layer}|${comune}|${provincia}|${featKey}`;
}
function featureKey(props: Record<string, unknown>): string {
  for (const k of ["id", "fid", "OBJECTID", "objectid", "id1", "id_vfor", "id_ambito"]) {
    if (props[k] != null) return `${k}=${String(props[k])}`;
  }
  const s = JSON.stringify(props);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `h=${h}`;
}

async function fetchLayer(layer: string, count: number): Promise<{ ok: boolean; features?: any[]; error?: string }> {
  const url = `${WFS_URL}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(layer)}&count=${count}&outputFormat=application/json&srsName=EPSG:4326`;
  try {
    const r = await fetch(url);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const json = await r.json();
    return { ok: true, features: (json.features ?? []) as any[] };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function runGeoportaleRecovery(params: RecoveryParams) {
  const dryRun = params.dryRun !== false;
  const doImport = params.import === true && !dryRun;
  const layers = (params.layers ?? Object.keys(LAYER_META)).filter((l) => LAYER_META[l]);
  const provinceFilter = new Set((params.province ?? ["PD", "VE", "BL"]).map((p) => p.toUpperCase()));
  const maxFeat = params.maxFeaturesPerLayer ?? 150;
  const cap = params.maxImportRecords ?? 150;
  const fuzzyThreshold = params.fuzzyThreshold ?? 0.92;
  const enablePIP = params.enableSpatialJoin !== false;

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ISTAT cache (full Italy via classificazione_sismica)
  const { data: istatRows, error: istatErr } = await sb
    .from("classificazione_sismica")
    .select("codice_istat, comune")
    .limit(10000);
  if (istatErr) return { ok: false, error: "istat_lookup_failed", message: istatErr.message };
  const istat: IstatCache = buildIstatLookup(istatRows ?? []);

  const reports: RecoveryReport[] = [];
  const candidateInserts: any[] = [];

  for (const layer of layers) {
    const meta = LAYER_META[layer];
    const rep: RecoveryReport = {
      layer_name: layer, title: meta.title,
      features_read: 0, base_assigned: 0,
      alias_assigned: 0, fuzzy_assigned: 0, spatial_joined: 0,
      still_unassigned: 0, recovered_count: 0, importable_count: 0,
      in_PD: 0, in_VE: 0, in_BL: 0,
      sample_recovered: [], sample_unassigned: [],
      warnings: [], errors: [],
    };

    const r = await fetchLayer(layer, maxFeat);
    if (!r.ok) { rep.errors.push(`fetch_failed: ${r.error}`); reports.push(rep); continue; }
    rep.features_read = r.features!.length;

    for (const feat of r.features!) {
      const props = (feat.properties ?? {}) as Record<string, unknown>;

      // Skip if base importer already would have assigned (already in DB via prior import)
      const base = inferComuneProvinciaFromProperties(props, istat);
      if (base) { rep.base_assigned++; continue; }

      // Recovery: alias / fuzzy
      let recovered: { comune: string; provincia: string; method: "alias" | "fuzzy" | "pip"; score?: number } | null = null;
      const text = inferFromTextProperties(props, { fuzzyThreshold });
      if (text) recovered = text;

      // Recovery: point-in-polygon via centroid
      if (!recovered && enablePIP) {
        const c = geometryCentroid(feat.geometry);
        if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
          const { data: zones } = await sb.rpc("omi_zone_by_point", { p_lat: c.lat, p_lng: c.lng });
          const z = (zones ?? [])[0] as { comune_descrizione?: string; provincia?: string } | undefined;
          if (z?.comune_descrizione && z?.provincia) {
            // Validate against VENETO_COMUNI to avoid invented values
            const cn = Object.keys(VENETO_COMUNI).find(
              (k) => k.toLowerCase() === String(z.comune_descrizione).toLowerCase(),
            );
            if (cn && VENETO_COMUNI[cn] === String(z.provincia).toUpperCase()) {
              recovered = { comune: cn, provincia: VENETO_COMUNI[cn], method: "pip" };
            }
          }
        }
      }

      if (!recovered) {
        rep.still_unassigned++;
        if (rep.sample_unassigned.length < 3) {
          rep.sample_unassigned.push({ keys: Object.keys(props).slice(0, 10), sample: sanitizeProperties(props, 6) });
        }
        continue;
      }
      if (recovered.method === "alias") rep.alias_assigned++;
      else if (recovered.method === "fuzzy") rep.fuzzy_assigned++;
      else rep.spatial_joined++;

      if (!provinceFilter.has(recovered.provincia)) continue;
      rep.recovered_count++;
      if (recovered.provincia === "PD") rep.in_PD++;
      if (recovered.provincia === "VE") rep.in_VE++;
      if (recovered.provincia === "BL") rep.in_BL++;

      const centroid = geometryCentroid(feat.geometry);
      const fkey = featureKey(props);
      const fingerprint = fp(layer, recovered.comune, recovered.provincia, fkey);
      const sanProps = sanitizeProperties(props, 12);
      const conf = recovered.method === "alias" ? 0.85 : recovered.method === "fuzzy" ? 0.75 : 0.7;

      const row = {
        fingerprint,
        source_name: "Geoportale Regione Veneto",
        source_url: `${WFS_URL}?typeNames=${layer}`,
        signal_type: meta.signal_type,
        signal_subtype: meta.topic,
        province: recovered.provincia,
        municipality: recovered.comune,
        lat: centroid?.lat ?? null,
        lng: centroid?.lng ?? null,
        title: `${meta.title} — ${recovered.comune} (${recovered.provincia})`,
        description: `Layer ${layer} (${meta.title}) — feature attribuita a ${recovered.comune} via ${recovered.method}${recovered.score ? ` (score ${recovered.score.toFixed(2)})` : ""}. Fonte: Geoportale Regione Veneto (WFS).`,
        data_basis: `geoportale_veneto,wfs,${meta.topic},recovery_${recovered.method}`,
        quality: "reale",
        confidence_score: conf,
        impact_direction: meta.impact >= 0 ? "positive" : "negative",
        impact_strength: Math.abs(meta.impact),
        payload: {
          layer_name: layer,
          method: recovered.method,
          score: recovered.score,
          properties: sanProps,
          geometry_type: feat.geometry?.type,
          centroid,
          recovery: true,
        },
        is_active: true,
      };

      if (rep.sample_recovered.length < 5) {
        rep.sample_recovered.push({
          comune: recovered.comune, provincia: recovered.provincia,
          method: recovered.method, score: recovered.score,
          centroid, sample_props: sanProps,
        });
      }
      rep.importable_count++;
      candidateInserts.push(row);
    }
    reports.push(rep);
  }

  // Cap globally
  const toInsert = candidateInserts.slice(0, cap);
  const cappedAt = candidateInserts.length > cap ? cap : candidateInserts.length;

  let skippedExisting = 0;
  let inserted = 0;
  if (doImport && toInsert.length) {
    const fps = toInsert.map((r) => r.fingerprint);
    const { data: existing } = await sb
      .from("territorial_signals").select("fingerprint").in("fingerprint", fps);
    const existSet = new Set((existing ?? []).map((e: any) => e.fingerprint));
    const fresh = toInsert.filter((r) => !existSet.has(r.fingerprint));
    skippedExisting = toInsert.length - fresh.length;
    if (fresh.length) {
      for (let i = 0; i < fresh.length; i += 100) {
        const chunk = fresh.slice(i, i + 100);
        const { error } = await sb.from("territorial_signals").insert(chunk);
        if (error) return { ok: false, error: "insert_failed", message: error.message, inserted };
        inserted += chunk.length;
      }
    }
  }

  return {
    ok: true,
    job: "recover-geoportale-veneto-unassigned",
    dryRun, import: doImport,
    province_filter: Array.from(provinceFilter),
    layers_processed: layers,
    fuzzy_threshold: fuzzyThreshold,
    spatial_join_enabled: enablePIP,
    reports,
    candidates_total: candidateInserts.length,
    capped_at: cappedAt,
    territorial_signals_created: inserted,
    skipped_existing: skippedExisting,
    coverage_recovered_PD: reports.reduce((s, r) => s + r.in_PD, 0),
    coverage_recovered_VE: reports.reduce((s, r) => s + r.in_VE, 0),
    coverage_recovered_BL: reports.reduce((s, r) => s + r.in_BL, 0),
    recommendation: dryRun
      ? (candidateInserts.length > 0
          ? "DRY_RUN_OK: re-run with import=true to persist recovered features."
          : "NO_RECOVERY: no additional features could be safely attributed.")
      : `RECOVERED: ${inserted} new signals (skipped ${skippedExisting} existing).`,
  };
}
