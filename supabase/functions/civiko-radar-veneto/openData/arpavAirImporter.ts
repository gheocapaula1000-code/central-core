// ═══════════════════════════════════════════════════════════════
// ARPAV Air Quality importer → microzone_sentiment
//
// Sources (WFS GeoJSON):
//   - geonode:VENETO_Shp_regionale_corrispondenza_comuni_zo
//       comune → zona qualità aria (ISTAT, COMUNE, SIGLA_PROV, COD_ZONA, NOME_ZONA)
//   - geonode:v_rete_aria
//       stazioni puntuali (prov, comune, lat, lon)
//
// Score logic (prudent, no invented numerics):
//   Base air_quality_score from NOME_ZONA / COD_ZONA family:
//     - Agglomerato urbano   45
//     - Pianura              60
//     - Bassa pianura        58
//     - Fondovalle           50
//     - Collina              70
//     - Prealpi              78
//     - Montagna             82
//     - sconosciuto          null
//   Bonus presenza stazione: +0 (no numeric data — no inflation), but raises confidence.
//
// Confidence:
//   0.65 base if comune+prov+ISTAT
//   +0.10 if station in same comune
//   +0.05 if station in same provincia (no comune match)
//   cap 0.80
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { VENETO_COMUNI } from "./venetoComuni.ts";

const WFS_URL = "https://geomap.arpa.veneto.it/geoserver/ows";
const LAYER_ZONE = "geonode:VENETO_Shp_regionale_corrispondenza_comuni_zo";
const LAYER_STATIONS = "geonode:v_rete_aria";

const ALLOWED_PROV = new Set(["VE", "VR", "VI", "PD", "TV", "BL", "RO"]);

export interface ArpavAirImportParams {
  dryRun?: boolean;
  import?: boolean;
  province?: string[];
  maxFeatures?: number;
}

interface ZoneFeat { istat: string; comune: string; provincia: string; cod_zona: string; nome_zona: string; }
interface StationFeat { comune: string; provincia: string; name: string; lat: number | null; lng: number | null; }

function normalizeProvincia(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const u = p.trim().toUpperCase();
  return ALLOWED_PROV.has(u) ? u : null;
}

function canonicalComune(name: unknown, prov: string | null): string | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const raw = name.trim();
  // direct hit
  if (VENETO_COMUNI[raw]) return raw;
  // case-insensitive search
  const lower = raw.toLowerCase();
  for (const k of Object.keys(VENETO_COMUNI)) {
    if (k.toLowerCase() === lower) {
      if (!prov || VENETO_COMUNI[k] === prov) return k;
    }
  }
  // accept original capitalised if provincia known (avoid losing valid records)
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

async function fetchWFS(layer: string, maxFeatures: number): Promise<any[]> {
  const url = `${WFS_URL}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(layer)}&count=${maxFeatures}&outputFormat=application/json`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`WFS ${layer} status ${res.status}`);
  const j = await res.json();
  return Array.isArray(j?.features) ? j.features : [];
}

function fingerprint(comune: string, provincia: string): string {
  return `arpav_air|${provincia}|${comune.toLowerCase()}`;
}

export async function runArpavAirImport(params: ArpavAirImportParams) {
  const dryRun = params.dryRun !== false;
  const doImport = params.import === true && !dryRun;
  const provFilter = (params.province ?? ["VE", "VR", "VI", "PD", "TV", "BL", "RO"])
    .map((p) => p.toUpperCase()).filter((p) => ALLOWED_PROV.has(p));
  const maxFeatures = Math.min(Math.max(params.maxFeatures ?? 1000, 1), 2000);

  const warnings: string[] = [];
  const errors: string[] = [];
  const zones: ZoneFeat[] = [];
  const stations: StationFeat[] = [];

  // ── Layer 1: zone aria comunali ──
  try {
    const feats = await fetchWFS(LAYER_ZONE, maxFeatures);
    for (const f of feats) {
      const p = f?.properties ?? {};
      const provRaw = p.SIGLA_PROV ?? p.sigla_prov ?? p.provincia;
      const prov = normalizeProvincia(provRaw);
      if (!prov) continue;
      if (!provFilter.includes(prov)) continue;
      const com = canonicalComune(p.COMUNE ?? p.comune, prov);
      if (!com) continue;
      const istatRaw = p.ISTAT ?? p.istat ?? p.codistat;
      const istat = istatRaw == null ? "" : String(istatRaw).padStart(6, "0");
      zones.push({
        istat,
        comune: com,
        provincia: prov,
        cod_zona: String(p.COD_ZONA ?? p.cod_zona ?? ""),
        nome_zona: String(p.NOME_ZONA ?? p.nome_zona ?? ""),
      });
    }
  } catch (e) {
    errors.push(`zone_layer: ${e instanceof Error ? e.message : String(e)}`);
  }

  // dedup zones by comune+provincia (keep first)
  const zoneMap = new Map<string, ZoneFeat>();
  for (const z of zones) {
    const k = `${z.provincia}|${z.comune.toLowerCase()}`;
    if (!zoneMap.has(k)) zoneMap.set(k, z);
  }

  // ── Layer 2: stazioni ARPAV ──
  try {
    const feats = await fetchWFS(LAYER_STATIONS, 500);
    for (const f of feats) {
      const p = f?.properties ?? {};
      const prov = normalizeProvincia(p.prov ?? p.provincia);
      if (!prov) continue;
      const com = canonicalComune(p.comune, prov);
      if (!com) continue;
      const lat = typeof p.lat === "number" ? p.lat : null;
      const lng = typeof p.lon === "number" ? p.lon : (typeof p.lng === "number" ? p.lng : null);
      stations.push({ comune: com, provincia: prov, name: String(p.name ?? ""), lat, lng });
    }
  } catch (e) {
    warnings.push(`stations_layer: ${e instanceof Error ? e.message : String(e)}`);
  }

  const stationsByComune = new Set<string>();
  const stationsByProv = new Set<string>();
  for (const s of stations) {
    stationsByComune.add(`${s.provincia}|${s.comune.toLowerCase()}`);
    stationsByProv.add(s.provincia);
  }

  // ── Build records ──
  type SentimentRow = {
    comune: string; provincia: string; area_label: string; area_type: string;
    air_quality_score: number | null; environment_score: number | null;
    sentiment_score_total: number | null; confidence_score: number; quality: string;
    source_refs: Array<Record<string, unknown>>; data_basis: string[]; fingerprint: string;
    is_active: boolean; computed_at: string; updated_at: string;
  };
  const rows: SentimentRow[] = [];
  const provincesCoveredSet = new Set<string>();
  const now = new Date().toISOString();

  for (const z of zoneMap.values()) {
    const { score, band } = scoreFromZone(z.nome_zona, z.cod_zona);
    if (score == null) continue; // no invented data
    let confidence = 0.65;
    const k = `${z.provincia}|${z.comune.toLowerCase()}`;
    if (stationsByComune.has(k)) confidence += 0.10;
    else if (stationsByProv.has(z.provincia)) confidence += 0.05;
    confidence = Math.min(0.80, confidence);
    provincesCoveredSet.add(z.provincia);
    rows.push({
      comune: z.comune,
      provincia: z.provincia,
      area_label: z.comune,
      area_type: "comune",
      air_quality_score: score,
      environment_score: score, // partial: only air component available
      sentiment_score_total: score, // single component → equals it (renormalized weight 1.0)
      confidence_score: Number(confidence.toFixed(2)),
      quality: "parziale",
      source_refs: [
        { source: "ARPAV WFS", layer: LAYER_ZONE, url: WFS_URL, cod_zona: z.cod_zona, nome_zona: z.nome_zona, istat: z.istat, band },
        ...(stationsByComune.has(k) ? [{ source: "ARPAV WFS", layer: LAYER_STATIONS, url: WFS_URL, station_in_comune: true }] : []),
      ],
      data_basis: ["arpav", "wfs", "air_quality_zone"],
      fingerprint: fingerprint(z.comune, z.provincia),
      is_active: true,
      computed_at: now,
      updated_at: now,
    });
  }

  // ── Persist (only if import=true && !dryRun) ──
  let upserted = 0;
  let skipped_existing = 0;
  if (doImport && rows.length > 0) {
    const supaUrl = Deno.env.get("SUPABASE_URL")!;
    const supaKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supa = createClient(supaUrl, supaKey, { auth: { persistSession: false } });
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const { data, error } = await supa.from("microzone_sentiment").upsert(slice, {
        onConflict: "fingerprint", ignoreDuplicates: false,
      }).select("id");
      if (error) { errors.push(`upsert_chunk_${i}: ${error.message}`); continue; }
      upserted += (data?.length ?? 0);
    }
    skipped_existing = Math.max(0, rows.length - upserted);
  }

  let territorial_signals_created = 0;
  if (doImport && rows.length > 0) {
    const supaUrl = Deno.env.get("SUPABASE_URL")!;
    const supaKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supa = createClient(supaUrl, supaKey, { auth: { persistSession: false } });
    const sigs = rows.map((r) => ({
      fingerprint: `arpav_air_ts|${r.provincia}|${String(r.comune).toLowerCase()}`,
      source_name: "arpav_air_quality",
      signal_type: "air_quality_zone",
      province: r.provincia,
      municipality: r.comune,
      title: `Qualità aria ARPAV — ${r.comune}`,
      description: `Zona ARPAV con score aria ${r.air_quality_score ?? "n/d"} (fonte ufficiale WFS).`,
      data_basis: "arpav,wfs,air_quality_zone",
      quality: "parziale",
      is_active: true,
      confidence_score: r.confidence_score,
      impact_direction: "neutral",
      impact_strength: 0.3,
      payload: {
        air_quality_score: r.air_quality_score,
        environment_score: r.environment_score,
        sentiment_fingerprint: r.fingerprint,
      },
    }));
    const CHUNK = 200;
    for (let i = 0; i < sigs.length; i += CHUNK) {
      const slice = sigs.slice(i, i + CHUNK);
      const { error, count } = await supa.from("territorial_signals").upsert(slice, {
        onConflict: "fingerprint", ignoreDuplicates: false, count: "exact",
      });
      if (error) { errors.push(`territorial_signals_chunk_${i}: ${error.message}`); continue; }
      territorial_signals_created += count ?? slice.length;
    }
  }

  const provincesCovered = Array.from(provincesCoveredSet).sort();
  const sample = rows.slice(0, 10).map((r) => ({
    comune: r.comune, provincia: r.provincia,
    air_quality_score: r.air_quality_score,
    confidence_score: r.confidence_score,
    band: (r.source_refs[0] as Record<string, unknown>)?.band,
  }));
  const sampleZones = Array.from(zoneMap.values()).slice(0, 10).map((z) => ({
    comune: z.comune, provincia: z.provincia, cod_zona: z.cod_zona, nome_zona: z.nome_zona,
  }));

  const ok = errors.length === 0;
  return {
    ok,
    dryRun,
    importExecuted: doImport,
    layers_used: [LAYER_ZONE, LAYER_STATIONS],
    zones_read: zones.length,
    zones_dedup: zoneMap.size,
    stations_read: stations.length,
    comuni_with_station: stationsByComune.size,
    importable_rows: rows.length,
    provinces_covered: provincesCovered,
    upserted,
    territorial_signals_created,
    skipped_existing,
    sample_scores: sample,
    sample_zones: sampleZones,
    warnings,
    errors,
  };
}
