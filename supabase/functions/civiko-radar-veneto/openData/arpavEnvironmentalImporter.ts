// ═══════════════════════════════════════════════════════════════
// ARPAV Environmental importer → microzone_sentiment
//
// Composes the first real environmental sentiment for Veneto using:
//   - ARPAV WFS air zones (geonode:VENETO_Shp_regionale_corrispondenza_comuni_zo)
//   - ARPAV WFS stations (geonode:v_rete_aria)
//   - territorial_signals already imported (parchi, vincoli, sismica)
//
// Score components (each may be null):
//   - air_quality_score        from ARPAV zone classification
//   - green_score              from protected_area_dataset count per comune
//   - risk_inverse_score       from risk_constraint_dataset + seismic count
//   - territorial_signal_score from total territorial_signals density
//
// sentiment_score_total = weighted avg of available components only.
// confidence_score capped by number of available components.
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { VENETO_COMUNI } from "./venetoComuni.ts";

const WFS_URL = "https://geomap.arpa.veneto.it/geoserver/ows";
const LAYER_ZONE = "geonode:VENETO_Shp_regionale_corrispondenza_comuni_zo";
const LAYER_STATIONS = "geonode:v_rete_aria";

const ALLOWED_PROV = new Set(["VE", "VR", "VI", "PD", "TV", "BL", "RO"]);

const WEIGHTS = {
  air_quality_score: 0.40,
  green_score: 0.20,
  risk_inverse_score: 0.20,
  territorial_signal_score: 0.20,
};

export interface ArpavEnvParams {
  dryRun?: boolean;
  import?: boolean;
  province?: string[];
  maxFeatures?: number;
  pageSize?: number;
  includeStations?: boolean;
  includeZoneAria?: boolean;
}

interface ZoneFeat { istat: string; comune: string; provincia: string; cod_zona: string; nome_zona: string; }
interface StationFeat { comune: string; provincia: string; name: string; lat: number | null; lng: number | null; pollutants: string[]; }

function normalizeProvincia(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const u = p.trim().toUpperCase();
  return ALLOWED_PROV.has(u) ? u : null;
}

function canonicalComune(name: unknown, prov: string | null): string | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const raw = name.trim();
  if (VENETO_COMUNI[raw]) return raw;
  const lower = raw.toLowerCase();
  for (const k of Object.keys(VENETO_COMUNI)) {
    if (k.toLowerCase() === lower) {
      if (!prov || VENETO_COMUNI[k] === prov) return k;
    }
  }
  if (prov && raw.length > 1) return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  return null;
}

function scoreFromZone(nome_zona: string, cod_zona: string): { score: number | null; band: string } {
  const nz = (nome_zona || "").toLowerCase();
  const cz = (cod_zona || "").toUpperCase();
  if (nz.includes("agglomerato") || cz.startsWith("IT0519") || cz.startsWith("IT0520")) return { score: 45, band: "agglomerato" };
  if (nz.includes("fondovalle") || cz.startsWith("IT0526")) return { score: 50, band: "fondovalle" };
  if (nz.includes("bassa pianura")) return { score: 58, band: "bassa_pianura" };
  if (nz.includes("pianura")) return { score: 60, band: "pianura" };
  if (nz.includes("collina") || nz.includes("collinare")) return { score: 70, band: "collina" };
  if (nz.includes("prealp")) return { score: 78, band: "prealpi" };
  if (nz.includes("montagna") || nz.includes("monta")) return { score: 82, band: "montagna" };
  return { score: null, band: "unknown" };
}

async function fetchArpavWfsLayer(layer: string, maxFeatures: number, pageSize: number): Promise<any[]> {
  const out: any[] = [];
  const cap = Math.min(maxFeatures, 5000);
  let start = 0;
  const limit = Math.min(pageSize, cap);
  while (out.length < cap) {
    const url = `${WFS_URL}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(layer)}&count=${limit}&startIndex=${start}&outputFormat=application/json`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`WFS ${layer} status ${res.status}`);
    const j = await res.json();
    const feats = Array.isArray(j?.features) ? j.features : [];
    if (feats.length === 0) break;
    out.push(...feats);
    if (feats.length < limit) break;
    start += limit;
  }
  return out.slice(0, cap);
}

const POLLUTANT_KEYS = ["PM10", "PM2_5", "PM25", "NO2", "O3", "SO2", "CO", "C6H6"];

function extractPollutants(p: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of POLLUTANT_KEYS) {
    const v = p[k] ?? p[k.toLowerCase()];
    if (v != null && String(v).trim() !== "" && String(v).toLowerCase() !== "null") out.push(k);
  }
  return out;
}

function fingerprint(comune: string, provincia: string): string {
  return `arpav-air:${provincia}:${comune.toLowerCase()}`;
}

function band(score: number, kind: "green" | "risk_inv" | "territorial"): number {
  // Defensive band caps
  return Math.max(0, Math.min(100, Math.round(score)));
}

export async function runArpavEnvironmentalImport(params: ArpavEnvParams) {
  const dryRun = params.dryRun !== false;
  const doImport = params.import === true && !dryRun;
  const provFilter = (params.province ?? ["VE", "VR", "VI", "PD", "TV", "BL", "RO"])
    .map((p) => p.toUpperCase()).filter((p) => ALLOWED_PROV.has(p));
  const maxFeatures = Math.min(Math.max(params.maxFeatures ?? 2000, 1), 5000);
  const pageSize = Math.min(Math.max(params.pageSize ?? 500, 50), 1000);
  const includeStations = params.includeStations !== false;
  const includeZoneAria = params.includeZoneAria !== false;

  const warnings: string[] = [];
  const errors: string[] = [];
  const zones: ZoneFeat[] = [];
  const stations: StationFeat[] = [];

  // ── Layer 1: zone aria comunali ──
  if (includeZoneAria) {
    try {
      const feats = await fetchArpavWfsLayer(LAYER_ZONE, maxFeatures, pageSize);
      for (const f of feats) {
        const p = f?.properties ?? {};
        const prov = normalizeProvincia(p.SIGLA_PROV ?? p.sigla_prov ?? p.provincia);
        if (!prov || !provFilter.includes(prov)) continue;
        const com = canonicalComune(p.COMUNE ?? p.comune, prov);
        if (!com) continue;
        const istatRaw = p.ISTAT ?? p.istat ?? p.codistat;
        const istat = istatRaw == null ? "" : String(istatRaw).padStart(6, "0");
        zones.push({
          istat, comune: com, provincia: prov,
          cod_zona: String(p.COD_ZONA ?? p.cod_zona ?? ""),
          nome_zona: String(p.NOME_ZONA ?? p.nome_zona ?? ""),
        });
      }
    } catch (e) { errors.push(`zone_layer: ${e instanceof Error ? e.message : String(e)}`); }
  }

  const zoneMap = new Map<string, ZoneFeat>();
  for (const z of zones) {
    const k = `${z.provincia}|${z.comune.toLowerCase()}`;
    if (!zoneMap.has(k)) zoneMap.set(k, z);
  }

  // ── Layer 2: stazioni ARPAV ──
  if (includeStations) {
    try {
      const feats = await fetchArpavWfsLayer(LAYER_STATIONS, Math.min(maxFeatures, 1000), pageSize);
      for (const f of feats) {
        const p = f?.properties ?? {};
        const prov = normalizeProvincia(p.prov ?? p.provincia);
        if (!prov || !provFilter.includes(prov)) continue;
        const com = canonicalComune(p.comune, prov);
        if (!com) continue;
        const lat = typeof p.lat === "number" ? p.lat : null;
        const lng = typeof p.lon === "number" ? p.lon : (typeof p.lng === "number" ? p.lng : null);
        stations.push({ comune: com, provincia: prov, name: String(p.name ?? p.NOME ?? ""), lat, lng, pollutants: extractPollutants(p as Record<string, unknown>) });
      }
    } catch (e) { warnings.push(`stations_layer: ${e instanceof Error ? e.message : String(e)}`); }
  }

  const stationsByComune = new Map<string, StationFeat[]>();
  const stationsByProv = new Set<string>();
  for (const s of stations) {
    const k = `${s.provincia}|${s.comune.toLowerCase()}`;
    const arr = stationsByComune.get(k) ?? [];
    arr.push(s); stationsByComune.set(k, arr);
    stationsByProv.add(s.provincia);
  }

  // ── Pull territorial_signals counts per (provincia,municipality) ──
  const supaUrl = Deno.env.get("SUPABASE_URL")!;
  const supaKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supa = createClient(supaUrl, supaKey, { auth: { persistSession: false } });

  const greenCount = new Map<string, number>();
  const riskCount = new Map<string, number>();
  const tsTotal = new Map<string, number>();
  try {
    let from = 0; const STEP = 1000;
    while (true) {
      const { data, error } = await supa
        .from("territorial_signals")
        .select("province, municipality, signal_type")
        .in("province", provFilter)
        .not("municipality", "is", null)
        .range(from, from + STEP - 1);
      if (error) { warnings.push(`territorial_signals: ${error.message}`); break; }
      if (!data || data.length === 0) break;
      for (const r of data) {
        const prov = normalizeProvincia(r.province);
        if (!prov) continue;
        const com = canonicalComune(r.municipality, prov);
        if (!com) continue;
        const k = `${prov}|${com.toLowerCase()}`;
        tsTotal.set(k, (tsTotal.get(k) ?? 0) + 1);
        if (r.signal_type === "protected_area_dataset") greenCount.set(k, (greenCount.get(k) ?? 0) + 1);
        if (r.signal_type === "risk_constraint_dataset" || r.signal_type === "seismic_risk_dataset") riskCount.set(k, (riskCount.get(k) ?? 0) + 1);
      }
      if (data.length < STEP) break;
      from += STEP;
    }
  } catch (e) { warnings.push(`ts_query: ${e instanceof Error ? e.message : String(e)}`); }

  // ── Build records ──
  type Row = {
    comune: string; provincia: string; area_label: string; area_type: string;
    air_quality_score: number | null; environment_score: number | null;
    green_score: number | null; sentiment_score_total: number | null;
    confidence_score: number; quality: string;
    source_refs: Array<Record<string, unknown>>; data_basis: string[]; fingerprint: string;
    is_active: boolean; computed_at: string; updated_at: string;
  };
  const rows: Row[] = [];
  const provCovered = new Set<string>();
  const now = new Date().toISOString();
  let rejected = 0;
  const rejectedSample: Array<{ reason: string; comune?: string; provincia?: string }> = [];

  // Iterate union of (zoneMap keys ∪ ts keys ∪ station keys) so we can score comuni without zone too
  const allKeys = new Set<string>([...zoneMap.keys(), ...tsTotal.keys(), ...stationsByComune.keys()]);
  for (const k of allKeys) {
    const [provincia, comuneLow] = k.split("|");
    const z = zoneMap.get(k);
    const stArr = stationsByComune.get(k) ?? [];
    const comune = z?.comune ?? stArr[0]?.comune ?? Array.from(VENETO_COMUNI.keys?.() ?? []).find?.((c) => c.toLowerCase() === comuneLow) ?? comuneLow.replace(/^./, (c) => c.toUpperCase());
    const components: Record<string, number> = {};
    let bandLabel = "unknown";

    if (z) {
      const { score, band: bn } = scoreFromZone(z.nome_zona, z.cod_zona);
      if (score != null) { components.air_quality_score = score; bandLabel = bn; }
    }

    const gc = greenCount.get(k) ?? 0;
    if (gc > 0) components.green_score = band(50 + gc * 12, "green");

    const rc = riskCount.get(k) ?? 0;
    if (rc > 0) components.risk_inverse_score = band(85 - rc * 8, "risk_inv");

    const tc = tsTotal.get(k) ?? 0;
    if (tc > 0) components.territorial_signal_score = band(40 + tc * 6, "territorial");

    const availKeys = Object.keys(components);
    if (availKeys.length === 0) { rejected++; if (rejectedSample.length < 5) rejectedSample.push({ reason: "no_components", comune: String(comune), provincia }); continue; }

    let wsum = 0; let wtot = 0;
    for (const ck of availKeys) {
      const w = (WEIGHTS as any)[ck] ?? 0.10;
      wsum += components[ck] * w; wtot += w;
    }
    const sentiment = Math.round(wsum / wtot);

    let confidence = 0.50;
    if (availKeys.length >= 3) confidence = 0.78;
    else if (availKeys.length === 2) confidence = 0.68;
    else confidence = 0.55;
    if (stArr.length > 0) confidence = Math.min(0.80, confidence + 0.05);
    if (z?.istat) confidence = Math.min(0.80, confidence + 0.02);

    provCovered.add(provincia);
    const sourceRefs: Array<Record<string, unknown>> = [];
    if (z) sourceRefs.push({ source: "ARPAV WFS", layer: LAYER_ZONE, url: WFS_URL, cod_zona: z.cod_zona, nome_zona: z.nome_zona, istat: z.istat, band: bandLabel });
    if (stArr.length > 0) sourceRefs.push({ source: "ARPAV WFS", layer: LAYER_STATIONS, url: WFS_URL, station_count: stArr.length, pollutants_monitored: Array.from(new Set(stArr.flatMap((s) => s.pollutants))) });
    if (gc > 0) sourceRefs.push({ source: "territorial_signals", signal_type: "protected_area_dataset", count: gc });
    if (rc > 0) sourceRefs.push({ source: "territorial_signals", signal_type: "risk_constraint_dataset+seismic_risk_dataset", count: rc });
    sourceRefs.push({ source: "components", available: availKeys, weights_applied: availKeys.reduce((a, ck) => ({ ...a, [ck]: (WEIGHTS as any)[ck] }), {}) });

    const dataBasis = ["arpav", "wfs", "air_quality_zone"];
    if (gc > 0) dataBasis.push("territorial_green");
    if (rc > 0) dataBasis.push("territorial_risk");
    if (tc > 0) dataBasis.push("territorial_signals");

    rows.push({
      comune: String(comune), provincia, area_label: String(comune), area_type: "comune",
      air_quality_score: components.air_quality_score ?? null,
      environment_score: components.air_quality_score ?? null, // partial alias
      green_score: components.green_score ?? null,
      sentiment_score_total: sentiment,
      confidence_score: Number(confidence.toFixed(2)),
      quality: "parziale",
      source_refs: sourceRefs,
      data_basis: dataBasis,
      fingerprint: fingerprint(String(comune), provincia),
      is_active: true, computed_at: now, updated_at: now,
    });
  }

  // ── Persist ──
  const beforeCount = await supa.from("microzone_sentiment").select("id", { count: "exact", head: true });
  const before = beforeCount.count ?? 0;

  let upserted = 0;
  if (doImport && rows.length > 0) {
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const { data, error } = await supa.from("microzone_sentiment")
        .upsert(slice, { onConflict: "fingerprint", ignoreDuplicates: false })
        .select("id");
      if (error) { errors.push(`upsert_${i}: ${error.message}`); continue; }
      upserted += data?.length ?? 0;
    }
  }
  const afterCount = doImport ? await supa.from("microzone_sentiment").select("id", { count: "exact", head: true }) : { count: before };
  const after = afterCount.count ?? before;

  const provincesCovered = Array.from(provCovered).sort();
  const comuniByProv: Record<string, number> = {};
  const stationsByProvCount: Record<string, number> = {};
  const comuniWithStation: Record<string, number> = {};
  for (const r of rows) comuniByProv[r.provincia] = (comuniByProv[r.provincia] ?? 0) + 1;
  for (const s of stations) stationsByProvCount[s.provincia] = (stationsByProvCount[s.provincia] ?? 0) + 1;
  for (const k of stationsByComune.keys()) {
    const prov = k.split("|")[0];
    comuniWithStation[prov] = (comuniWithStation[prov] ?? 0) + 1;
  }

  const sample = rows.slice(0, 10).map((r) => ({
    comune: r.comune, provincia: r.provincia,
    air: r.air_quality_score, green: r.green_score,
    total: r.sentiment_score_total, confidence: r.confidence_score,
    components: (r.source_refs.find((s) => s.source === "components") as any)?.available,
  }));
  const sampleStations = stations.slice(0, 10).map((s) => ({ comune: s.comune, provincia: s.provincia, name: s.name, pollutants: s.pollutants }));

  return {
    ok: errors.length === 0,
    dryRun, importExecuted: doImport,
    layers_used: [LAYER_ZONE, ...(includeStations ? [LAYER_STATIONS] : [])],
    zone_features_read: zones.length,
    station_features_read: stations.length,
    comuni_detected: zoneMap.size,
    comuni_importable: rows.length,
    province_covered: provincesCovered,
    comuni_by_province: comuniByProv,
    stations_by_province: stationsByProvCount,
    comuni_with_station: comuniWithStation,
    sample_scores: sample,
    sample_stations: sampleStations,
    rejected_count: rejected,
    rejected_sample: rejectedSample,
    microzone_sentiment_before: before,
    microzone_sentiment_after: after,
    records_upserted: upserted,
    warnings, errors,
  };
}
