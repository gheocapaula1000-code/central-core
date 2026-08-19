// Pure Subito (emastra/subito-it-immobili) mapping helpers.
// No Deno.env, no network — unit-tested from Vitest.

import { SUBITO_PADOVA_SEARCH_URLS } from "./apifyLaunch.ts";
import { isComunePadova } from "./civikoPadovaScopeGuard.ts";

export { ACTOR_SUBITO, SUBITO_PADOVA_SEARCH_URLS } from "./apifyLaunch.ts";

const MIN_SALE_PRICE_EUR = 10_000;
const MAX_ITEMS_CAP = 1000;
const DEFAULT_MAX_ITEMS = 300;
const USD_PER_THOUSAND = 5;

export function clampSubitoMaxItems(raw: unknown): number {
  const n = Number(raw ?? DEFAULT_MAX_ITEMS);
  return Math.min(MAX_ITEMS_CAP, Math.max(1, Number.isFinite(n) ? Math.trunc(n) : DEFAULT_MAX_ITEMS));
}

export function estimateSubitoCostUsd(maxItems: number): number {
  return Number(((maxItems * USD_PER_THOUSAND) / 1000).toFixed(3));
}

/** Actor input matches emastra/subito-it-immobili schema: startUrls string[], maxResultItems. */
export function normalizeSubitoStartUrls(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) return [...SUBITO_PADOVA_SEARCH_URLS];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    let url = "";
    if (typeof entry === "string") url = entry.trim();
    else if (entry && typeof entry === "object" && typeof (entry as { url?: unknown }).url === "string") {
      url = String((entry as { url: string }).url).trim();
    }
    if (!url.startsWith("https://www.subito.it/")) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls.length > 0 ? urls : [...SUBITO_PADOVA_SEARCH_URLS];
}

export function buildSubitoActorInput(searchUrls: string[], maxItems: number): {
  startUrls: string[];
  maxResultItems: number;
} {
  return {
    startUrls: searchUrls,
    maxResultItems: maxItems,
  };
}

export function canonUrl(u: string): string {
  if (!u) return "";
  return u.replace(/\?.*$/, "").replace(/\/$/, "").replace(/^http:/, "https:");
}

export function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v).replace(/[^0-9-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

export function toFloat(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function featVal(features: Record<string, unknown> | null, key: string): unknown {
  if (!features) return null;
  const v = features[key];
  if (v && typeof v === "object") return (v as { value?: unknown }).value ?? null;
  return v ?? null;
}

function featLabel(features: Record<string, unknown> | null, key: string): unknown {
  if (!features) return null;
  const v = features[key];
  if (v && typeof v === "object") return (v as { label?: unknown }).label ?? null;
  return null;
}

export function pickPhotos(raw: Record<string, unknown>): string[] | null {
  const src = raw?.images;
  if (!Array.isArray(src)) return null;
  const urls = src.filter((u) => typeof u === "string" && /^https?:\/\//.test(u)) as string[];
  return urls.length ? urls.slice(0, 20) : null;
}

export type SubitoCollectRow = Record<string, unknown>;

export function mapSubito(raw: unknown, jobId: string, nowIso: string): SubitoCollectRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (row.error) return null;

  const url = canonUrl(String(row.page_url ?? ""));
  if (!url) return null;

  const listingId = String(url.match(/-(\d+)\.htm$/)?.[1] ?? "");
  const loc = (row.location && typeof row.location === "object")
    ? row.location as Record<string, unknown>
    : {};
  const city = String(loc.city ?? "");
  const province = String(loc.province ?? "");
  const region = String(loc.region ?? "");
  const coords = (loc.coordinates && typeof loc.coordinates === "object")
    ? loc.coordinates as Record<string, unknown>
    : {};
  const lat = toFloat(coords.latitude);
  const lng = toFloat(coords.longitude);

  const features = (row.features && typeof row.features === "object")
    ? row.features as Record<string, unknown>
    : {};
  const priceObj = (row.price && typeof row.price === "object")
    ? row.price as Record<string, unknown>
    : {};
  const priceRaw = toInt(priceObj.value);
  const mq = toInt(featVal(features, "size_sqm"));
  const locali = toInt(featVal(features, "rooms"));
  const bagni = toInt(featVal(features, "bathrooms"));
  const floorValue = featVal(features, "floor");
  const floorLabelRaw = featLabel(features, "floor");
  const piano = floorValue != null
    ? String(floorValue)
    : (floorLabelRaw != null && String(floorLabelRaw).trim() !== "" ? String(floorLabelRaw).trim() : null);
  const stato = featLabel(features, "building_condition");

  const adv = (row.advertiser && typeof row.advertiser === "object")
    ? row.advertiser as Record<string, unknown>
    : {};
  const advType = String(adv.type ?? "").toLowerCase();
  const isCompany = advType === "azienda" || row.isPrivateAdvertiser === false;
  const agency = isCompany ? (adv.name ?? null) : null;
  const agencyPhone = adv.phone_number ?? null;
  const tipologia = row.sub_category ?? row.title ?? null;
  const rawAddress = [city, province].filter(Boolean).join(", ") || null;
  const tipoTransazione = String(row.type ?? "");

  const mapped: SubitoCollectRow = {
    job_id: jobId,
    portal: "subito",
    listing_id: listingId || null,
    url,
    raw_address: rawAddress,
    citta: "Padova",
    cap: null,
    lat,
    lng,
    omi_zone: null,
    quartiere: null,
    tipo_lead: isCompany ? "AGENZIA" : "PRIVATO",
    n_agenzie: isCompany ? 1 : 0,
    prezzo: priceRaw,
    prezzo_iniziale: priceRaw,
    mq,
    locali,
    bagni,
    agency,
    agency_phone: agencyPhone,
    tipologia,
    piano,
    stato,
    anno_costruzione: null,
    cluster_key: null,
    parse_status: "apify_subito_detail",
    processed_at: nowIso,
    http_status: 200,
    log_reason: null,
    attempts: 0,
    previous_price_eur: null,
    ribasso_pct: null,
    ribasso_eur: null,
    ribasso_date: null,
    raw_json: {
      ...row,
      _photos: pickPhotos(row),
      _shape: "subito",
      _city: city,
      _province: province,
      _region: region,
      _tipo_transazione: tipoTransazione,
    },
    updated_at: nowIso,
  };

  if (!isSubitoPadovaSaleValid(mapped)) return null;
  return mapped;
}

export function isSubitoPadovaSaleValid(row: SubitoCollectRow): boolean {
  const rawJson = (row.raw_json && typeof row.raw_json === "object")
    ? row.raw_json as Record<string, unknown>
    : {};
  const city = String(rawJson._city ?? "");
  if (!isComunePadova(city)) return false;
  const tipo = String(rawJson._tipo_transazione ?? "").toLowerCase();
  if (tipo && !tipo.includes("vendita")) return false;
  const prezzo = Number(row.prezzo);
  if (!Number.isFinite(prezzo) || prezzo < MIN_SALE_PRICE_EUR) return false;
  return true;
}

/**
 * Flatten emastra nested JSON into the keys process_padova_subito_staging
 * already reads (urls_default, geo_town_value, features_price_values, …).
 * Already-flat azzouzana rows pass through.
 */
export function flattenSubitoForStaging(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const row = raw as Record<string, unknown>;
  if (typeof row.urls_default === "string" && row.urls_default.trim() !== "") {
    return row;
  }
  const loc = (row.location && typeof row.location === "object")
    ? row.location as Record<string, unknown>
    : {};
  const coords = (loc.coordinates && typeof loc.coordinates === "object")
    ? loc.coordinates as Record<string, unknown>
    : {};
  const features = (row.features && typeof row.features === "object")
    ? row.features as Record<string, unknown>
    : {};
  const price = (row.price && typeof row.price === "object")
    ? row.price as Record<string, unknown>
    : {};
  const adv = (row.advertiser && typeof row.advertiser === "object")
    ? row.advertiser as Record<string, unknown>
    : {};
  const city = String(loc.city ?? row._city ?? "");
  const province = String(loc.province ?? row._province ?? "");
  const advType = String(adv.type ?? "").toLowerCase();
  const isCompany = advType === "azienda" || row.isPrivateAdvertiser === false;
  const floorValue = featVal(features, "floor");
  const floorLabelRaw = featLabel(features, "floor");
  return {
    ...row,
    urls_default: String(row.page_url ?? row.url ?? ""),
    geo_town_value: city,
    type_value: String(row.type ?? row._tipo_transazione ?? ""),
    features_price_values: String(price.value ?? row.prezzo ?? ""),
    features_size_values: String(featVal(features, "size_sqm") ?? ""),
    features_room_values: String(featVal(features, "rooms") ?? ""),
    features_bathrooms_values: String(featVal(features, "bathrooms") ?? ""),
    features_floor_values: floorValue != null ? String(floorValue) : "",
    features_floor_label: floorLabelRaw != null ? String(floorLabelRaw) : "",
    features_building_condition_label: String(featLabel(features, "building_condition") ?? ""),
    geo_map_latitude: coords.latitude != null ? String(coords.latitude) : "",
    geo_map_longitude: coords.longitude != null ? String(coords.longitude) : "",
    geo_map_address: [city, province].filter(Boolean).join(", "),
    advertiser_company: isCompany ? "true" : "false",
    advertiser_name: String(adv.name ?? ""),
    advertiser_phone: String(adv.phone_number ?? ""),
    category_label: String(row.sub_category ?? row.title ?? ""),
    _shape: "subito_listview",
    _source: "emastra_subito_it_immobili",
  };
}

export function classifyPromoteResult(result: unknown): {
  ok: boolean;
  created: number;
  updated: number;
  found: number;
  processed: number;
  errors: number;
  reason: string | null;
} {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, created: 0, updated: 0, found: 0, processed: 0, errors: 0, reason: "empty_promote_result" };
  }
  const r = result as Record<string, unknown>;
  const created = Number(r.collect_created ?? 0);
  const updated = Number(r.collect_updated ?? 0);
  const found = Number(r.staging_rows_found ?? 0);
  const processed = Number(r.staging_rows_processed ?? 0);
  const errors = Number(r.errors ?? 0);
  if (r.ok === false) {
    return { ok: false, created, updated, found, processed, errors, reason: "promote_rpc_ok_false" };
  }
  if (errors > 0) {
    return { ok: false, created, updated, found, processed, errors, reason: "promote_rpc_errors" };
  }
  return { ok: true, created, updated, found, processed, errors, reason: null };
}
