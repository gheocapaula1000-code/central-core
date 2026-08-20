// Padova urban layers — official SUE/cantieri, piano regolatore, sentiment.
// Pure helpers: no Deno.env, no secrets. Collectors inject fetch + DB.

import {
  CIVIKO_COMMERCIAL_ZONE_SLUGS,
  type CivikoCommercialZoneSlug,
} from "./civikoCommercialZoneContract.ts";
import { commercialZoneForQuartiere } from "./civikoCommercialZoneByQuartiere.ts";
import { parseZoneSlug } from "./listContracts.ts";

export const LIVE_CORE_REF = "jpunnzgixcghuydstdlt";
export const PADOVA_ISTAT = "028027";
export const PADOVA_COMUNE = "Padova";

export const OFFICIAL_ZONE_SLUGS = [
  "centro-storico",
  "nord-arcella",
  "est-brenta",
  "nord-est",
  "sud-est-sant-osvaldo",
  "sud-voltabarozzo-guizza",
  "sud-ovest-mandria",
  "ovest-chiesanuova-brentelle",
] as const;

export const SUE_SOURCE_PAGES = [
  "https://www.comune.padova.it/sue-sportello-unico-edilizia",
  "https://www.comune.padova.it/procedimenti-sue",
  "https://www.comune.padova.it/servizi/autorizzazioni/permesso-di-costruire-edilizia-residenziale",
] as const;

export const PIANO_SOURCE_PAGES = [
  "https://www.comune.padova.it/piano-di-assetto-del-territorio-pat",
  "https://www.comune.padova.it/piano-degli-interventi-pi-geoportale-ed-elaborati-vigenti",
  "https://www.comune.padova.it/servizi/catasto-e-urbanistica/portale-cartografico-del-piano-degli-interventi-e-del-piano-di",
] as const;

export const PIANO_GEOPORTALE_URL =
  "https://cartografia.comune.padova.it/portal/apps/webappviewer/index.html?id=ab58fd8c40284157bd50938daea87837";

/** Registry code sit_padova_geoportale. Host sit.padovanet.it does not resolve (2026-08-20). */
export const SIT_PADOVA_LEGACY_HOST = "https://sit.padovanet.it";

/** Official Comune SIT / geoportale — PAT + PI MapServers on cartografia.comune.padova.it */
export const SIT_PADOVA_PAT_MAPSERVER =
  "https://cartografia.comune.padova.it/server/rest/services/pat/MapServer";
export const SIT_PADOVA_PI_MAPSERVER =
  "https://cartografia.comune.padova.it/server/rest/services/Secondo_Piano_degli_Interventi/MapServer";
export const SIT_PADOVA_PORTAL_ITEM =
  "https://cartografia.comune.padova.it/portal/sharing/rest/content/items/ab58fd8c40284157bd50938daea87837?f=json";
export const SIT_PADOVA_WEBMAP_DATA =
  "https://cartografia.comune.padova.it/portal/sharing/rest/content/items/e67e2457601d4e39924b1b6d02e13edd/data?f=json";

export const WFS_REGIONE_VENETO =
  "https://idt2-geoserver.regione.veneto.it/geoserver/ows";

export const OSM_LOCAL_SOURCE_NAME = "OpenStreetMap Overpass — cantieri Padova";

export const CKAN_CATALOGS = [
  "https://dati.veneto.it",
  "https://www.dati.gov.it/opendata",
  "https://opendata.comune.padova.it",
] as const;

export const CKAN_QUERIES = [
  "padova edilizia",
  "padova SUE",
  "padova permessi costruire",
  "padova cantieri",
  "padova urbanistica PAT PI",
] as const;

export const OSM_OVERPASS_URL = "https://overpass-api.de/api/interpreter";

export const FETCH_TIMEOUT_MS = 15_000;
export const COLLECTOR_WALL_MS = 95_000;

export function isOfficialZoneSlug(value: unknown): value is CivikoCommercialZoneSlug {
  return typeof value === "string" && CIVIKO_COMMERCIAL_ZONE_SLUGS.has(value as CivikoCommercialZoneSlug);
}

export function requireZoneSlug(raw: unknown): { ok: true; slug: CivikoCommercialZoneSlug } | { ok: false; error: string } {
  const parsed = parseZoneSlug(raw);
  if (!parsed.ok) return { ok: false, error: parsed.code };
  return { ok: true, slug: parsed.slug as CivikoCommercialZoneSlug };
}

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; status: number; text: string } | { ok: false; status: number | null; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        Accept: "application/json,text/html,text/csv,*/*",
        "User-Agent": "civiko-core/1.0 (padova-urban-layers)",
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    return { ok: true, status: res.status, text };
  } catch (e) {
    const timeout = e instanceof Error && e.name === "AbortError";
    return { ok: false, status: timeout ? 504 : null, error: timeout ? "timeout" : (e instanceof Error ? e.message : "network_error") };
  } finally {
    clearTimeout(timer);
  }
}

export function isPadovaEdiliziaText(value: string): boolean {
  const t = value.toLowerCase();
  if (!/padova|\bpd\b/.test(t)) return false;
  return /edilizia|sue\b|permess|scia|cila|cantiere|urbanistic|piano degli interventi|piano di assetto|pat\b|\bpi\b/.test(t);
}

export function isPadovaOnlyText(value: string): boolean {
  return /padova|\bpd\b/i.test(value);
}

export type CkanResource = {
  url?: string;
  format?: string;
  name?: string;
  description?: string;
};

export type CkanPackage = {
  id?: string;
  name?: string;
  title?: string;
  notes?: string;
  organization?: { title?: string; name?: string };
  resources?: CkanResource[];
};

export function selectPadovaEdiliziaPackages(packages: CkanPackage[]): CkanPackage[] {
  const out: CkanPackage[] = [];
  for (const ds of packages) {
    const blob = [ds.title, ds.name, ds.notes, ds.organization?.title, ds.organization?.name]
      .filter(Boolean).join(" ");
    if (!isPadovaEdiliziaText(blob)) continue;
    // Emilia-Romagna / other comuni that mention Padova only in passing stay out.
    if (/modena|emilia.?romagna|masera/i.test(blob) && !/comune di padova|comune.padova|città di padova/i.test(blob)) {
      continue;
    }
    out.push(ds);
  }
  return out;
}

export function parseCsvRows(text: string, maxRows = 2000): Record<string, string>[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const delim = lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",";
  const headers = splitCsvLine(lines[0], delim).map((h) => h.trim().toLowerCase());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length && rows.length < maxRows; i++) {
    const cols = splitCsvLine(lines[i], delim);
    if (cols.every((c) => !c.trim())) continue;
    const rec: Record<string, string> = {};
    headers.forEach((h, idx) => { rec[h] = (cols[idx] ?? "").trim(); });
    rows.push(rec);
  }
  return rows;
}

function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === delim && !inQ) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function firstField(row: Record<string, string>, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (v && v.trim()) return v.trim();
  }
  // loose contains
  for (const [k, v] of Object.entries(row)) {
    if (keys.some((want) => k.includes(want)) && v.trim()) return v.trim();
  }
  return null;
}

export function parseLooseDate(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const it = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (it) {
    const d = it[1].padStart(2, "0");
    const m = it[2].padStart(2, "0");
    return `${it[3]}-${m}-${d}`;
  }
  return null;
}

export type SuePermitRow = {
  area_name: string | null;
  address_public: string | null;
  practice_type: string | null;
  practice_date: string | null;
  status: string | null;
  source_url: string;
  source_name: string;
  external_id: string;
  commercial_zone_slug: CivikoCommercialZoneSlug | null;
  fetched_at: string;
  compliance_verified: boolean;
  raw_ref: Record<string, unknown>;
};

export function mapCsvToPermit(
  row: Record<string, string>,
  sourceUrl: string,
  sourceName: string,
  fetchedAt: string,
  complianceVerified: boolean,
): SuePermitRow | null {
  const address = firstField(row, ["indirizzo", "via", "address", "address_public", "ubicazione", "civico"]);
  const area = firstField(row, ["quartiere", "area", "zona", "area_name", "localita", "località", "consult"]);
  const practiceType = firstField(row, ["tipo", "practice_type", "tipologia", "intervento", "procedimento"]);
  const status = firstField(row, ["stato", "status", "esito"]);
  const date = parseLooseDate(firstField(row, ["data", "practice_date", "data_pratica", "data_rilascio", "anno"]));
  const ext = firstField(row, ["protocollo", "id", "numero", "pratica", "external_id", "n_pratica"])
    ?? [address, practiceType, date].filter(Boolean).join("|");
  if (!address && !ext) return null;
  const slug = commercialZoneForQuartiere(area) ?? inferZoneFromText(`${address ?? ""} ${area ?? ""}`);
  return {
    area_name: area,
    address_public: address,
    practice_type: practiceType,
    practice_date: date,
    status,
    source_url: sourceUrl,
    source_name: sourceName,
    external_id: ext.slice(0, 240),
    commercial_zone_slug: slug,
    fetched_at: fetchedAt,
    compliance_verified: complianceVerified,
    raw_ref: { keys: Object.keys(row).slice(0, 20) },
  };
}

export function inferZoneFromText(text: string): CivikoCommercialZoneSlug | null {
  if (!text) return null;
  // Exact quartiere match on tokens / whole string only — no fuzzy.
  const direct = commercialZoneForQuartiere(text);
  if (direct) return direct;
  const parts = text.split(/[,;/|]+/).map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    const slug = commercialZoneForQuartiere(p);
    if (slug) return slug;
  }
  return null;
}

export function osmPadovaConstructionQuery(): string {
  return `[out:json][timeout:25];
area["name"="Padova"]["boundary"="administrative"]["admin_level"="8"]->.a;
(
  node["building"="construction"](area.a);
  way["building"="construction"](area.a);
  relation["building"="construction"](area.a);
  node["landuse"="construction"](area.a);
  way["landuse"="construction"](area.a);
);
out center 80;`;
}

export type OsmElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

export function mapOsmToPermit(el: OsmElement, fetchedAt: string): SuePermitRow {
  const tags = el.tags ?? {};
  const street = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ").trim() || null;
  const area = tags["addr:suburb"] || tags["addr:neighbourhood"] || tags["addr:quarter"] || null;
  const name = (tags.name ?? "").trim();
  return {
    area_name: area,
    address_public: street ?? (name || null),
    practice_type: tags.building === "construction" ? "cantiere_edilizio" : "area_cantiere",
    practice_date: null,
    status: "open_data_osm",
    source_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    source_name: "osm-overpass:padova-construction",
    external_id: `osm:${el.type}/${el.id}`,
    commercial_zone_slug:
      commercialZoneForQuartiere(area) ?? inferZoneFromText(`${street ?? ""} ${name}`),
    fetched_at: fetchedAt,
    compliance_verified: false,
    raw_ref: { osm_id: el.id, osm_type: el.type, tags },
  };
}

export type LocalSignalInsert = {
  title: string;
  summary: string | null;
  category: string;
  location_text: string | null;
  lat: number | null;
  lng: number | null;
  municipality: string;
  neighborhood: string | null;
  commercial_zone_slug: CivikoCommercialZoneSlug | null;
  detected_at: string;
  confidence: "high" | "medium" | "low";
  signal_tone: "positive" | "negative" | "mixed" | "neutral";
  commercial_use: string;
  evidence_url: string;
  source_level: 2;
  is_active: true;
  use_in_report: true;
  external_ref: string;
};

/** OSM construction → local_signals. Community map, not official SUE. Never invents coords. */
export function mapOsmToLocalSignal(
  el: OsmElement,
  comune: string,
  fetchedAt: string,
): LocalSignalInsert {
  const permit = mapOsmToPermit(el, fetchedAt);
  const lat = el.lat ?? el.center?.lat ?? null;
  const lng = el.lon ?? el.center?.lon ?? null;
  const title = permit.address_public
    ? `Cantiere OSM · ${permit.address_public}, ${comune}`
    : `Cantiere OSM a ${comune}`;
  return {
    title: title.slice(0, 160),
    summary: permit.practice_type,
    category: permit.practice_type ?? "cantiere_edilizio",
    location_text: permit.address_public,
    lat,
    lng,
    municipality: comune,
    neighborhood: permit.area_name,
    commercial_zone_slug: permit.commercial_zone_slug,
    detected_at: fetchedAt,
    confidence: "medium",
    signal_tone: "neutral",
    commercial_use: "Punto da verificare",
    evidence_url: permit.source_url,
    source_level: 2,
    is_active: true,
    use_in_report: true,
    external_ref: permit.external_id,
  };
}

export type PianoRecord = {
  commercial_zone_slug: CivikoCommercialZoneSlug | null;
  layer_kind: "PAT" | "PI" | "PRG" | "elaborato" | "wfs";
  zone_code: string | null;
  designation: string | null;
  title: string;
  geometry_geojson: Record<string, unknown> | null;
  properties: Record<string, unknown>;
  source_url: string;
  fetched_at: string;
  fingerprint: string;
};

export function fingerprintPiano(sourceUrl: string, title: string, zone: string | null): string {
  return `piano:${zone ?? "city"}:${title.toLowerCase().replace(/\s+/g, "_").slice(0, 80)}:${sourceUrl}`.slice(0, 240);
}

export function extractOfficialElaborati(html: string, pageUrl: string, fetchedAt: string): PianoRecord[] {
  const rows: PianoRecord[] = [];
  const seen = new Set<string>();
  const push = (rec: PianoRecord) => {
    if (seen.has(rec.fingerprint)) return;
    seen.add(rec.fingerprint);
    rows.push(rec);
  };

  // Official page must actually mention PAT/PI — otherwise we did not read the source.
  if (!/piano di assetto|piano degli interventi|\bPAT\b|\bP\.I\b|geoportale/i.test(html)) {
    return [];
  }

  const kind: PianoRecord["layer_kind"] = /piano di assetto|\bPAT\b/i.test(html) && !/piano degli interventi/i.test(html)
    ? "PAT"
    : /piano degli interventi|\bP\.I\b/i.test(html)
      ? "PI"
      : "elaborato";

  // Centro storico tavole are named on the official PI page.
  if (/centro storico/i.test(html) && /tavol/i.test(html)) {
    push({
      commercial_zone_slug: "centro-storico",
      layer_kind: kind,
      zone_code: "A2",
      designation: "Centro storico — tavole ufficiali PI",
      title: "PI / PAT — Centro storico (tavole ufficiali)",
      geometry_geojson: null,
      properties: { extracted: "official_page_mention" },
      source_url: pageUrl,
      fetched_at: fetchedAt,
      fingerprint: fingerprintPiano(pageUrl, "centro-storico-tavole", "centro-storico"),
    });
  }

  const headingRe = /<(?:h[1-4]|li|p)[^>]*>\s*([^<]{8,160})\s*</gi;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(html)) !== null) {
    const title = m[1].replace(/\s+/g, " ").trim();
    if (!/tavol|norma|elaborat|pat\b|p\.i|piano|uso|vincol|invariante|fragil/i.test(title)) continue;
    if (/cookie|contatta|prenota|privacy/i.test(title)) continue;
    const slug = inferZoneFromText(title);
    push({
      commercial_zone_slug: slug,
      layer_kind: /tavol|elaborat|norma/i.test(title) ? "elaborato" : kind,
      zone_code: null,
      designation: title.slice(0, 200),
      title: title.slice(0, 200),
      geometry_geojson: null,
      properties: { extracted: "official_html" },
      source_url: pageUrl,
      fetched_at: fetchedAt,
      fingerprint: fingerprintPiano(pageUrl, title, slug),
    });
  }

  // Always record the official geoportale pointer when the page confirms it.
  if (/cartografia\.comune\.padova\.it|webgis|geoportale/i.test(html)) {
    push({
      commercial_zone_slug: null,
      layer_kind: kind,
      zone_code: null,
      designation: "Portale cartografico ufficiale PAT/PI",
      title: "Geoportale Comune di Padova — PAT / PI",
      geometry_geojson: null,
      properties: { geoportale: PIANO_GEOPORTALE_URL },
      source_url: pageUrl,
      fetched_at: fetchedAt,
      fingerprint: fingerprintPiano(pageUrl, "geoportale-pat-pi", null),
    });
  }

  return rows;
}

export type ArcGisLayer = { id?: number; name?: string };

export function mapArcGisLayersToPiano(
  serviceUrl: string,
  serviceTitle: string,
  kind: PianoRecord["layer_kind"],
  layers: ArcGisLayer[],
  fetchedAt: string,
): PianoRecord[] {
  const out: PianoRecord[] = [];
  for (const lyr of layers) {
    const name = String(lyr.name ?? "").trim();
    if (!name) continue;
    const id = lyr.id;
    const sourceUrl = id == null ? `${serviceUrl}?f=json` : `${serviceUrl}/${id}`;
    const slug = /centro storico/i.test(name) ? "centro-storico" as const : inferZoneFromText(name);
    out.push({
      commercial_zone_slug: slug,
      layer_kind: kind,
      zone_code: id == null ? null : String(id),
      designation: name.slice(0, 200),
      title: `${serviceTitle} — ${name}`.slice(0, 200),
      geometry_geojson: null,
      properties: { sit: "cartografia.comune.padova.it", layer_id: id ?? null, extracted: "arcgis_mapserver" },
      source_url: sourceUrl,
      fetched_at: fetchedAt,
      fingerprint: fingerprintPiano(sourceUrl, name, slug),
    });
  }
  return out;
}

export function parseArcGisMapServerLayers(text: string): ArcGisLayer[] {
  try {
    const data = JSON.parse(text);
    const layers = data?.layers;
    return Array.isArray(layers) ? layers : [];
  } catch {
    return [];
  }
}

export function isUrbanisticaWfsLayer(name: string, title = ""): boolean {
  const t = `${name} ${title}`.toLowerCase();
  return /pat|piano.?intervent|urbanist|prg|zto|vincol|invariante|trasformabilit|uso.?suolo/.test(t);
}

export function parseWfsFeatureTypes(xml: string): Array<{ name: string; title: string }> {
  const out: Array<{ name: string; title: string }> = [];
  const blockRe = /<FeatureType[\s\S]*?<\/FeatureType>/gi;
  const blocks = xml.match(blockRe) ?? [];
  for (const b of blocks) {
    const name = (b.match(/<Name>([^<]+)<\/Name>/i) ?? [])[1] ?? "";
    const title = (b.match(/<Title>([^<]+)<\/Title>/i) ?? [])[1] ?? name;
    if (!name) continue;
    if (isUrbanisticaWfsLayer(name, title)) out.push({ name, title });
  }
  return out;
}

export function mapWfsFeatureToPiano(
  layerName: string,
  layerTitle: string,
  feature: { id?: string; properties?: Record<string, unknown>; geometry?: Record<string, unknown> },
  fetchedAt: string,
): PianoRecord | null {
  const props = feature.properties ?? {};
  const blob = Object.values(props).map((v) => String(v ?? "")).join(" ");
  if (blob && !isPadovaOnlyText(blob) && !/028027|padova/i.test(JSON.stringify(props))) {
    // Keep only features that mention Padova / ISTAT, unless properties are empty.
    if (Object.keys(props).length > 0) return null;
  }
  const title = String(props.nome ?? props.name ?? props.denominazione ?? layerTitle).slice(0, 200);
  const zoneCode = String(props.zto ?? props.zona ?? props.codice ?? props.zone_code ?? "").trim() || null;
  const slug = inferZoneFromText(`${title} ${blob}`);
  const sourceUrl = `${WFS_REGIONE_VENETO}?service=WFS&request=GetFeature&typeNames=${encodeURIComponent(layerName)}`;
  return {
    commercial_zone_slug: slug,
    layer_kind: "wfs",
    zone_code: zoneCode,
    designation: String(props.destinazione ?? props.uso ?? layerTitle).slice(0, 200) || null,
    title,
    geometry_geojson: feature.geometry ?? null,
    properties: props,
    source_url: sourceUrl,
    fetched_at: fetchedAt,
    fingerprint: fingerprintPiano(sourceUrl, `${layerName}:${feature.id ?? title}`, slug),
  };
}

export type SentimentAxisInput = {
  environment_score?: number | null;
  air_quality_score?: number | null;
  green_score?: number | null;
  services_score?: number | null;
  school_access_score?: number | null;
  urban_decay_risk_score?: number | null;
  listing_count?: number | null;
  permit_count?: number | null;
  territorial_signal_count?: number | null;
  elderly_over75_rate?: number | null;
};

export type SentimentRow = {
  comune: string;
  provincia: string;
  area_label: string;
  area_type: string;
  commercial_zone_slug: CivikoCommercialZoneSlug;
  environment_score: number | null;
  air_quality_score: number | null;
  green_score: number | null;
  services_score: number | null;
  school_access_score: number | null;
  urban_decay_risk_score: number | null;
  sentiment_score_total: number | null;
  confidence_score: number;
  quality: "reale" | "parziale";
  source_refs: Array<{ source_name: string }>;
  data_basis: string[];
  fingerprint: string;
  is_active: boolean;
  computed_at: string;
  updated_at: string;
};

function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, n));
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Zone card is allowed only when at least one zone-scoped input exists. City-level scores alone are not enough. */
export function hasZoneScopedSentimentInput(input: SentimentAxisInput): boolean {
  const zoneAxes = [
    input.environment_score,
    input.air_quality_score,
    input.green_score,
    input.services_score,
    input.school_access_score,
    input.urban_decay_risk_score,
  ];
  if (zoneAxes.some((v) => v != null && Number.isFinite(Number(v)))) return true;
  if (input.listing_count != null && input.listing_count > 0) return true;
  if (input.permit_count != null && input.permit_count > 0) return true;
  if (input.territorial_signal_count != null && input.territorial_signal_count > 0) return true;
  if (input.elderly_over75_rate != null && Number.isFinite(input.elderly_over75_rate)) return true;
  return false;
}

export function computeZoneSentiment(
  slug: CivikoCommercialZoneSlug,
  input: SentimentAxisInput,
  nowIso: string,
): SentimentRow {
  const axes: Record<string, number | null> = {
    environment_score: num(input.environment_score),
    air_quality_score: num(input.air_quality_score),
    green_score: num(input.green_score),
    services_score: num(input.services_score),
    school_access_score: num(input.school_access_score),
    urban_decay_risk_score: num(input.urban_decay_risk_score),
  };

  // Counts are real DB inputs; convert to 0-100 only when count > 0. Never invent from zero/missing.
  if (input.listing_count != null && Number.isFinite(input.listing_count) && input.listing_count > 0) {
    axes.services_score = axes.services_score ?? clamp(30 + Math.log2(1 + input.listing_count) * 10);
  }
  if (input.permit_count != null && Number.isFinite(input.permit_count) && input.permit_count > 0) {
    axes.urban_decay_risk_score = axes.urban_decay_risk_score
      ?? clamp(20 + Math.log2(1 + input.permit_count) * 12);
  }
  if (input.elderly_over75_rate != null && Number.isFinite(input.elderly_over75_rate)) {
    axes.urban_decay_risk_score = axes.urban_decay_risk_score
      ?? clamp(input.elderly_over75_rate * 100);
  }

  const weights: Record<string, number> = {
    environment_score: 0.20,
    air_quality_score: 0.16,
    green_score: 0.14,
    services_score: 0.18,
    school_access_score: 0.16,
    urban_decay_risk_score: 0.16,
  };

  let totW = 0;
  let total = 0;
  let used = 0;
  const basis: string[] = [];
  const refs: Array<{ source_name: string }> = [];

  for (const [k, w] of Object.entries(weights)) {
    const v = axes[k];
    if (v != null) {
      totW += w;
      total += v * w;
      used++;
      basis.push(k);
    }
  }
  if (input.listing_count != null) { basis.push("padova_listings"); refs.push({ source_name: "padova_listings" }); }
  if (input.permit_count != null) { basis.push("sue_padova_permits"); refs.push({ source_name: "sue_padova_permits" }); }
  if (input.territorial_signal_count != null) { basis.push("territorial_signals"); refs.push({ source_name: "territorial_signals" }); }
  if (input.elderly_over75_rate != null) { basis.push("padova_elderly_population"); refs.push({ source_name: "padova_elderly_population" }); }
  if (axes.air_quality_score != null || axes.environment_score != null) {
    refs.push({ source_name: "microzone_sentiment" });
    basis.push("microzone_sentiment");
  }

  const sentiment = totW > 0 ? clamp(total / totW) : null;
  const confidence = clamp((used / Object.keys(weights).length) * 100);

  return {
    comune: PADOVA_COMUNE,
    provincia: "PD",
    area_label: slug,
    area_type: "commercial_zone",
    commercial_zone_slug: slug,
    environment_score: axes.environment_score,
    air_quality_score: axes.air_quality_score,
    green_score: axes.green_score,
    services_score: axes.services_score,
    school_access_score: axes.school_access_score,
    urban_decay_risk_score: axes.urban_decay_risk_score,
    sentiment_score_total: sentiment,
    confidence_score: confidence,
    quality: confidence >= 60 ? "reale" : "parziale",
    source_refs: refs,
    data_basis: [...new Set(basis)],
    fingerprint: `mzs:PD:padova:${slug}`,
    is_active: true,
    computed_at: nowIso,
    updated_at: nowIso,
  };
}

export function averageNumeric(values: Array<number | null | undefined>): number | null {
  const xs = values.map(num).filter((v): v is number => v != null);
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function collectorTimedOut(startedMs: number, nowMs: number, budgetMs = COLLECTOR_WALL_MS): boolean {
  return nowMs - startedMs >= budgetMs;
}
