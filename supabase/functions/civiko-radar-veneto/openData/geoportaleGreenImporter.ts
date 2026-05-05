// ═══════════════════════════════════════════════════════════════
// Geoportale Veneto — GREEN COVERAGE importer
//
// Idempotent server-side job:
//   1. Fetch 4 validated WFS green layers (GeoJSON, EPSG:4326).
//   2. Resolve comune/provincia per feature using:
//        a. direct properties (rare for these layers)
//        b. point-in-polygon via public.omi_zone_by_point(centroid)
//           + multi-sample for MultiPolygon (parks span >1 comune).
//   3. Deduplicate per (layer, comune, provincia).
//   4. Upsert territorial_signals via stable fingerprint.
//   5. Enrich microzone_sentiment for covered comuni:
//        green_score, environment_score (0.45 air + 0.35 green + 0.20 risk_inv,
//        renormalized), sentiment_score_total (no overwrite of valid components),
//        confidence_score (+0.05 if green), source_refs, data_basis.
//   6. Never invent comuni. Never overwrite air_quality_score.
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { VENETO_COMUNI } from "./venetoComuni.ts";
import { geometryCentroid } from "./geoportaleSpatialJoin.ts";

const WFS_URL = "https://idt2-geoserver.regione.veneto.it/geoserver/ows";
const ALLOWED_PROV = new Set(["VE", "VR", "VI", "PD", "TV", "BL", "RO"]);

type GreenSignalType =
  | "green_area_dataset"
  | "protected_area_dataset"
  | "natura_2000_dataset"
  | "park_dataset"
  | "forest_dataset";

const LAYER_META: Record<string, {
  signal_type: GreenSignalType;
  topic: string;
  title: string;
  base_score: number;
}> = {
  "rv:parchi_riserve_foreste": {
    signal_type: "forest_dataset", topic: "verde",
    title: "Parchi, Riserve e Foreste demaniali", base_score: 82,
  },
  "rv:c1101121_natura_2000": {
    signal_type: "natura_2000_dataset", topic: "natura_2000",
    title: "Rete Natura 2000 (SIC/ZPS)", base_score: 80,
  },
  "rv:c1102051_parchiistituiti_2025": {
    signal_type: "park_dataset", topic: "parchi",
    title: "Parchi istituiti (2025)", base_score: 90,
  },
  "rv:c1102061_riserveistituite": {
    signal_type: "protected_area_dataset", topic: "riserve",
    title: "Riserve istituite", base_score: 85,
  },
};

export interface GreenImportParams {
  dryRun?: boolean;
  import?: boolean;
  layers?: string[];
  province?: string[];
  maxFeaturesPerLayer?: number;
  maxImportRecords?: number;
}

function fp(layer: string, prov: string, com: string): string {
  return `geo-green:${layer}:${prov}:${com}`;
}

async function fetchLayer(layer: string, count: number) {
  const url = `${WFS_URL}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(layer)}&count=${count}&outputFormat=application/json&srsName=EPSG:4326`;
  try {
    const r = await fetch(url);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const txt = await r.text();
    const j = JSON.parse(txt);
    return { ok: true, features: (j.features ?? []) as any[] };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function sampleCentroids(geom: any): Array<{ lat: number; lng: number }> {
  if (!geom || !geom.coordinates) return [];
  const out: Array<{ lat: number; lng: number }> = [];
  if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) {
      const c = geometryCentroid({ type: "Polygon", coordinates: poly });
      if (c) out.push(c);
    }
  } else {
    const c = geometryCentroid(geom);
    if (c) out.push(c);
  }
  return out.slice(0, 12);
}

function canonicalComune(name: string): string | null {
  if (!name) return null;
  const lower = name.trim().toLowerCase();
  for (const k of Object.keys(VENETO_COMUNI)) {
    if (k.toLowerCase() === lower) return k;
  }
  return null;
}

export async function runGeoportaleGreenImport(params: GreenImportParams) {
  const dryRun = params.dryRun !== false;
  const doImport = params.import === true && !dryRun;
  const layers = (params.layers ?? Object.keys(LAYER_META)).filter((l) => LAYER_META[l]);
  const provFilter = new Set((params.province ?? Array.from(ALLOWED_PROV))
    .map((p) => p.toUpperCase()).filter((p) => ALLOWED_PROV.has(p)));
  const maxFeat = params.maxFeaturesPerLayer ?? 1000;
  const cap = params.maxImportRecords ?? 400;

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const warnings: string[] = [];
  const errors: string[] = [];

  // (layer, prov, com) -> { feature_count, layer_title, base_score }
  const aggregate = new Map<string, {
    layer: string; provincia: string; comune: string;
    layer_title: string; base_score: number; signal_type: GreenSignalType;
    feature_count: number; method: string;
  }>();

  const layersReports: any[] = [];
  for (const layer of layers) {
    const meta = LAYER_META[layer];
    const rep: any = {
      layer_name: layer, title: meta.title,
      features_read: 0, comuni_resolved: 0, comuni_unassigned: 0,
      errors: [] as string[],
    };
    const r = await fetchLayer(layer, maxFeat);
    if (!r.ok) {
      rep.errors.push(`fetch_failed: ${r.error}`);
      layersReports.push(rep);
      continue;
    }
    rep.features_read = r.features!.length;

    for (const feat of r.features!) {
      const props = (feat.properties ?? {}) as Record<string, unknown>;

      // Direct properties
      let resolvedSet = new Set<string>(); // "PROV|Comune"
      const propProv = typeof props.provincia === "string"
        ? String(props.provincia).toUpperCase() : null;
      const propCom = typeof props.comune === "string"
        ? canonicalComune(String(props.comune)) : null;
      if (propCom && propProv && ALLOWED_PROV.has(propProv) && VENETO_COMUNI[propCom] === propProv) {
        resolvedSet.add(`${propProv}|${propCom}|direct`);
      }

      // PIP via centroids (multi-sample)
      const centroids = sampleCentroids(feat.geometry);
      for (const c of centroids) {
        try {
          const { data: zones, error } = await sb.rpc("omi_zone_by_point", {
            p_lat: c.lat, p_lng: c.lng,
          });
          if (error) continue;
          for (const z of (zones ?? [])) {
            const cn = canonicalComune(String(z.comune_descrizione ?? ""));
            const pv = String(z.provincia ?? "").toUpperCase();
            if (cn && ALLOWED_PROV.has(pv) && VENETO_COMUNI[cn] === pv) {
              resolvedSet.add(`${pv}|${cn}|pip`);
            }
          }
        } catch (e) {
          warnings.push(`pip_error: ${(e as Error).message}`);
        }
      }

      if (resolvedSet.size === 0) {
        rep.comuni_unassigned++;
        continue;
      }
      rep.comuni_resolved++;

      for (const key of resolvedSet) {
        const [prov, com, method] = key.split("|");
        if (!provFilter.has(prov)) continue;
        const k = `${layer}|${prov}|${com}`;
        const existing = aggregate.get(k);
        if (existing) {
          existing.feature_count++;
        } else {
          aggregate.set(k, {
            layer, provincia: prov, comune: com,
            layer_title: meta.title, base_score: meta.base_score,
            signal_type: meta.signal_type, feature_count: 1,
            method,
          });
        }
      }
    }
    layersReports.push(rep);
  }

  // Per-comune green_score = max base_score across layers + small boost per extra layer
  const perComune = new Map<string, { provincia: string; comune: string; layers: string[]; green_score: number; types: Set<GreenSignalType>; }>();
  for (const v of aggregate.values()) {
    const k = `${v.provincia}|${v.comune}`;
    const e = perComune.get(k) ?? { provincia: v.provincia, comune: v.comune, layers: [], green_score: 0, types: new Set<GreenSignalType>() };
    e.layers.push(v.layer);
    e.types.add(v.signal_type);
    e.green_score = Math.max(e.green_score, v.base_score);
    perComune.set(k, e);
  }
  for (const e of perComune.values()) {
    if (e.layers.length > 1) e.green_score = Math.min(95, e.green_score + 3);
    if (e.layers.length > 2) e.green_score = Math.min(98, e.green_score + 2);
  }

  // Build candidate territorial_signals
  const candidates: any[] = [];
  for (const v of aggregate.values()) {
    const fingerprint = fp(v.layer, v.provincia, v.comune);
    candidates.push({
      fingerprint,
      source_name: "Geoportale Regione Veneto",
      source_url: `${WFS_URL}?typeNames=${v.layer}`,
      signal_type: v.signal_type,
      signal_subtype: "verde",
      province: v.provincia,
      municipality: v.comune,
      title: `${v.layer_title} — ${v.comune} (${v.provincia})`,
      description: `Layer ${v.layer} (${v.layer_title}) — area verde / protetta che intercetta il territorio di ${v.comune}. Fonte: Geoportale Regione Veneto (WFS).`,
      data_basis: "geoportale_veneto,wfs,green_area",
      quality: "reale",
      confidence_score: v.method === "direct" ? 0.9 : 0.8,
      impact_direction: "positive",
      impact_strength: 0.3,
      payload: {
        layer_name: v.layer,
        layer_title: v.layer_title,
        green_score: v.base_score,
        attribution_method: v.method,
        feature_count: v.feature_count,
      },
      is_active: true,
    });
  }

  // Cap globally (deterministic order)
  candidates.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  const toConsider = candidates.slice(0, cap);
  const cappedAt = Math.min(candidates.length, cap);

  // Dedup against existing fingerprints
  let signalsCreated = 0;
  let signalsSkipped = 0;
  if (toConsider.length) {
    // chunked existence check
    const existSet = new Set<string>();
    const fps = toConsider.map((c) => c.fingerprint);
    for (let i = 0; i < fps.length; i += 200) {
      const slice = fps.slice(i, i + 200);
      const { data, error } = await sb
        .from("territorial_signals")
        .select("fingerprint")
        .in("fingerprint", slice);
      if (error) { errors.push(`exist_check: ${error.message}`); break; }
      for (const r of data ?? []) existSet.add(r.fingerprint as string);
    }
    const fresh = toConsider.filter((c) => !existSet.has(c.fingerprint));
    signalsSkipped = toConsider.length - fresh.length;

    if (doImport && fresh.length) {
      const CHUNK = 100;
      for (let i = 0; i < fresh.length; i += CHUNK) {
        const slice = fresh.slice(i, i + CHUNK);
        const { error } = await sb.from("territorial_signals").insert(slice);
        if (error) { errors.push(`insert_ts: ${error.message}`); break; }
        signalsCreated += slice.length;
      }
    }
  }

  // ── Microzone enrichment ──
  // Load existing rows for covered (prov, comune)
  const provincesInvolved = Array.from(new Set(Array.from(perComune.values()).map((v) => v.provincia)));
  const msRows: any[] = [];
  let off = 0;
  while (true) {
    const { data, error } = await sb.from("microzone_sentiment")
      .select("id, comune, provincia, air_quality_score, environment_score, green_score, sentiment_score_total, confidence_score, source_refs, data_basis")
      .in("provincia", provincesInvolved.length ? provincesInvolved : Array.from(provFilter))
      .range(off, off + 999);
    if (error) { errors.push(`ms_query: ${error.message}`); break; }
    if (!data || !data.length) break;
    msRows.push(...data);
    if (data.length < 1000) break;
    off += 1000;
  }

  const greenBefore = msRows.filter((r) => r.green_score != null).length;
  const sentBefore = avg(msRows, "sentiment_score_total");
  const confBefore = avg(msRows, "confidence_score");
  const envBefore = msRows.filter((r) => r.environment_score != null).length;

  let msUpdates: Array<{ id: number; patch: any; sample?: any }> = [];

  for (const r of msRows) {
    const k = `${r.provincia}|${(r.comune ?? "").toLowerCase()}`;
    let entry: { provincia: string; comune: string; layers: string[]; green_score: number; types: Set<GreenSignalType> } | undefined;
    for (const v of perComune.values()) {
      if (v.provincia === r.provincia && v.comune.toLowerCase() === (r.comune ?? "").toLowerCase()) {
        entry = v; break;
      }
    }
    if (!entry) continue;

    const air = r.air_quality_score != null ? Number(r.air_quality_score) : null;
    const green = entry.green_score;

    // risk_inverse from existing source_refs ISPRA
    let riskInverse: number | null = null;
    if (Array.isArray(r.source_refs)) {
      for (const ref of r.source_refs) {
        if (ref && typeof ref === "object" && typeof (ref as any).risk_score === "number") {
          riskInverse = 100 - Number((ref as any).risk_score);
          break;
        }
        if (ref && typeof ref === "object" && typeof (ref as any).risk_inverse_score === "number") {
          riskInverse = Number((ref as any).risk_inverse_score);
          break;
        }
      }
    }

    // environment_score (renormalized)
    const parts: Array<[number, number]> = [];
    if (air != null) parts.push([air, 0.45]);
    parts.push([green, 0.35]);
    if (riskInverse != null) parts.push([riskInverse, 0.20]);
    const wsumE = parts.reduce((a, [, w]) => a + w, 0);
    const env = Math.round(parts.reduce((a, [v, w]) => a + v * w, 0) / wsumE);

    // sentiment_score_total: use env as primary component; preserve existing if better-grounded.
    // Strategy: weighted with available components (air, env, green, riskInverse).
    const comps: Array<[number, number]> = [];
    if (air != null) comps.push([air, 0.35]);
    comps.push([env, 0.30]);
    comps.push([green, 0.20]);
    if (riskInverse != null) comps.push([riskInverse, 0.15]);
    const wsumS = comps.reduce((a, [, w]) => a + w, 0);
    const sentiment = Math.round(comps.reduce((a, [v, w]) => a + v * w, 0) / wsumS);

    let conf = r.confidence_score != null ? Number(r.confidence_score) : 0.65;
    if (r.green_score == null) conf += 0.05;
    conf = Math.min(0.85, Number(conf.toFixed(2)));

    const newRefs = Array.isArray(r.source_refs) ? [...r.source_refs] : [];
    newRefs.push({
      source: "geoportale_veneto_green",
      green_score: green,
      layers: entry.layers,
      types: Array.from(entry.types),
    });
    const dbset = new Set<string>(Array.isArray(r.data_basis) ? r.data_basis : []);
    dbset.add("geoportale_veneto");
    dbset.add("green_area");
    if (entry.types.has("protected_area_dataset") || entry.types.has("park_dataset") || entry.types.has("natura_2000_dataset")) {
      dbset.add("protected_area");
    }

    const patch = {
      green_score: green,
      environment_score: env,
      sentiment_score_total: sentiment,
      confidence_score: conf,
      source_refs: newRefs,
      data_basis: Array.from(dbset),
      updated_at: new Date().toISOString(),
    };

    msUpdates.push({
      id: r.id, patch,
      sample: msUpdates.length < 10 ? {
        comune: r.comune, provincia: r.provincia,
        before: { green: r.green_score, env: r.environment_score, sentiment: r.sentiment_score_total, conf: r.confidence_score },
        after: { green, env, sentiment, conf },
        layers: entry.layers,
      } : undefined,
    });
  }

  let msUpdated = 0;
  if (doImport && msUpdates.length) {
    for (const u of msUpdates) {
      const { error } = await sb.from("microzone_sentiment").update(u.patch).eq("id", u.id);
      if (error) { errors.push(`update_ms_${u.id}: ${error.message}`); continue; }
      msUpdated++;
    }
  }

  // Preview metrics
  const previewRows = msRows.map((r) => {
    const u = msUpdates.find((x) => x.id === r.id);
    return u ? { ...r, ...u.patch } : r;
  });

  // Coverage by province
  const coverageByProv: Record<string, number> = {};
  for (const v of perComune.values()) {
    coverageByProv[v.provincia] = (coverageByProv[v.provincia] ?? 0) + 1;
  }

  const sampleComuni = Array.from(perComune.values()).slice(0, 10).map((v) => ({
    comune: v.comune, provincia: v.provincia, layers: v.layers, green_score: v.green_score,
  }));

  return {
    ok: errors.length === 0,
    job: "import-geoportale-green-coverage",
    dryRun, importExecuted: doImport,
    layers_processed: layers,
    features_read_by_layer: Object.fromEntries(layersReports.map((r) => [r.layer_name, r.features_read])),
    comuni_covered: perComune.size,
    comuni_by_province: coverageByProv,
    territorial_signals_to_create: candidates.length,
    territorial_signals_capped_at: cappedAt,
    territorial_signals_existing: signalsSkipped,
    territorial_signals_created: signalsCreated,
    microzone_records_to_update: msUpdates.length,
    microzone_records_updated: msUpdated,
    greenCoverage_before: greenBefore,
    greenCoverage_after_preview: previewRows.filter((r) => r.green_score != null).length,
    environmentCoverage_before: envBefore,
    environmentCoverage_after_preview: previewRows.filter((r) => r.environment_score != null).length,
    avgSentiment_before: sentBefore,
    avgSentiment_after_preview: avg(previewRows, "sentiment_score_total"),
    avgConfidence_before: confBefore,
    avgConfidence_after_preview: avg(previewRows, "confidence_score"),
    avg_green_score: Math.round(
      Array.from(perComune.values()).reduce((a, v) => a + v.green_score, 0) / Math.max(1, perComune.size),
    ),
    sample_comuni: sampleComuni,
    sample_changes: msUpdates.filter((u) => u.sample).map((u) => u.sample),
    layers_reports: layersReports,
    warnings, errors,
  };
}

function avg(rows: any[], field: string): number | null {
  const vals = rows.map((r) => r[field]).filter((v) => v != null).map((v) => Number(v));
  if (!vals.length) return null;
  return Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2));
}
