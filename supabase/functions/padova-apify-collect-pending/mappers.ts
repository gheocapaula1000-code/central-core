// Mapper per padova-apify-collect-pending, estratti per essere testabili.
//
// Contratto Civiko: il comune autoritativo della riga raw deve essere presente,
// non ambiguo e normalizzato esattamente 'padova' PRIMA di costruire la riga.
// Nessun mapper stampa citta='Padova' su input non validato.

import {
  evaluateRawComuneScope,
  type ComuneRejectCode,
} from "../_shared/civikoPadovaScopeGuard.ts";

export const ACTOR_IDEALISTA = "dz_omar~idealista-scraper-api";
export const ACTOR_IMMO_DETAIL = "memo23~immobiliare-scraper";
export const ACTOR_IMMO_LISTVIEW = "azzouzana~immobiliare-it-listing-page-scraper-by-search-url";
export const ACTOR_SUBITO = "emastra~subito-it-immobili";
export const ACTOR_CASA = "benthepythondev~casa-it-scraper";

export type MapRejectCode =
  | ComuneRejectCode
  | "UNMAPPABLE"
  | "NOT_SALE"
  | "PRICE_TOO_LOW"
  | "AUCTION";

export type MapOutcome =
  | { ok: true; row: Record<string, unknown> }
  | { ok: false; code: MapRejectCode };

export function isScopeReject(code: MapRejectCode): boolean {
  return code === "COMUNE_MISSING" || code === "COMUNE_AMBIGUOUS" || code === "COMUNE_OUT_OF_SCOPE";
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
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// ============ IDEALISTA ============
function pickPhotosIdealista(raw: any): string[] | null {
  const mm = raw?.multimedia;
  if (!mm) return raw?.MainImage ? [raw.MainImage] : null;
  const urls: string[] = [];
  const walk = (v: any) => {
    if (!v) return;
    if (typeof v === "string" && /^https?:\/\//.test(v)) urls.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(mm);
  if (raw?.MainImage) urls.unshift(raw.MainImage);
  return urls.length ? Array.from(new Set(urls)).slice(0, 30) : null;
}

export function mapIdealista(raw: any, jobId: string, nowIso: string): MapOutcome {
  if (!raw || raw.error) return { ok: false, code: "UNMAPPABLE" };
  const scope = evaluateRawComuneScope("idealista", raw);
  if (!scope.ok) return { ok: false, code: scope.code };
  const isDetail = !!(raw.ubication || raw.moreCharacteristics || raw.propertyId);
  const url = canonUrl(raw?.originalUrl ?? raw?.detailWebLink ?? raw?.url ?? raw?.sourceUrl ?? "");
  if (!url) return { ok: false, code: "UNMAPPABLE" };
  const priceRaw = toInt(raw?.price ?? raw?.priceInfo?.amount ?? raw?.priceInfo?.price?.amount);
  const pd = raw?.priceDropInfo ?? null;
  const priceDropValue = toFloat(pd?.priceDropValue);
  const previousPriceEur = priceRaw != null && priceDropValue != null
    ? priceRaw + priceDropValue : null;
  const ribassoPct = toFloat(pd?.priceDropPercentage);
  const ribassoEur = priceDropValue;
  const ribassoDate = pd?.dropDate ? new Date(Number(pd.dropDate)).toISOString() : null;
  const ub = raw?.ubication ?? {};
  const ci = raw?.contactInfo ?? {};
  const mc = raw?.moreCharacteristics ?? {};
  const addr = ci?.address ?? {};
  const streetName = addr?.streetName ?? ub?.title ?? null;
  const streetNumber = addr?.streetNumber ?? null;
  const rawAddress = isDetail
    ? (streetName ? (streetNumber ? `${streetName} ${streetNumber}` : streetName) : ub?.title ?? null)
    : (raw?.address ?? null);
  const agency = (ci?.commercialName ?? ci?.contactName ?? ci?.agentInfo?.name ?? "").toString().trim() || null;
  const agencyPhone = ci?.phone1?.formattedPhoneWithPrefix ?? ci?.phone1?.phoneNumber ?? null;
  const isProfessional = ci?.professional === true || ci?.userType === "professional";
  const mq = isDetail ? (toInt(mc?.constructedArea) ?? toInt(mc?.usableArea)) : toInt(raw?.size);
  const locali = isDetail ? toInt(mc?.roomNumber) : toInt(raw?.rooms);
  const bagni = isDetail ? toInt(mc?.bathNumber) : toInt(raw?.bathrooms);
  const piano = isDetail
    ? (mc?.floor != null ? String(mc.floor) : null)
    : (raw?.floor != null ? String(raw.floor) : null);
  const stato = isDetail ? (mc?.status ?? null) : (raw?.status ?? null);
  const lat = toFloat(isDetail ? ub?.latitude : raw?.latitude);
  const lng = toFloat(isDetail ? ub?.longitude : raw?.longitude);
  const cap = addr?.postalCode ?? null;
  const quartiere = isDetail
    ? (ub?.administrativeAreaLevel4 ?? ub?.locationName ?? null)
    : (raw?.neighborhood ?? raw?.district ?? null);
  const tipologia = isDetail
    ? (raw?.extendedPropertyType ?? raw?.detailedType?.typology ?? raw?.homeType ?? null)
    : (raw?.propertyType ?? raw?.detailedType?.typology ?? null);
  const listingId = String(
    raw?.propertyId ?? raw?.propertyCode ?? raw?.adid ?? url.match(/immobile\/(\d+)/)?.[1] ?? "",
  );
  return {
    ok: true,
    row: {
      job_id: jobId, portal: "idealista", listing_id: listingId || null, url,
      raw_address: rawAddress, citta: "Padova", cap, lat, lng, omi_zone: null, quartiere,
      tipo_lead: isProfessional ? "AGENZIA" : (agency ? "AGENZIA" : "PRIVATO"),
      n_agenzie: agency ? 1 : 0,
      prezzo: priceRaw, prezzo_iniziale: previousPriceEur ?? priceRaw,
      mq, locali, bagni, agency, agency_phone: agencyPhone,
      tipologia, piano, stato, anno_costruzione: null, cluster_key: null,
      parse_status: isDetail ? "apify_idealista_detail" : "apify_idealista_listview",
      processed_at: nowIso, http_status: 200, log_reason: null, attempts: 0,
      previous_price_eur: previousPriceEur,
      ribasso_pct: ribassoPct, ribasso_eur: ribassoEur, ribasso_date: ribassoDate,
      raw_json: { ...raw, _photos: pickPhotosIdealista(raw), _shape: isDetail ? "detail" : "listview" },
      updated_at: nowIso,
    },
  };
}

// ============ IMMOBILIARE ============
export function mapImmoDetail(raw: any, jobId: string, nowIso: string): MapOutcome {
  if (!raw || raw.error) return { ok: false, code: "UNMAPPABLE" };
  const scope = evaluateRawComuneScope("immobiliare", raw);
  if (!scope.ok) return { ok: false, code: scope.code };
  const e = raw?._enhanced ?? {};
  const g = raw?.geography ?? {};
  const p = raw?.price ?? {};
  const t = raw?.topology ?? {};
  const a = raw?.analytics ?? {};
  const url = canonUrl(raw?.shareUrl ?? e.sourceUrl ?? e.listingUrl ?? "");
  if (!url) return { ok: false, code: "UNMAPPABLE" };
  const lat = toFloat(e.latitude ?? g?.geolocation?.latitude);
  const lng = toFloat(e.longitude ?? g?.geolocation?.longitude);
  const priceRaw = toInt(p.raw ?? e.priceAmount);
  const previousPrice = toInt(p.startPrice);
  const ribassoPct = toFloat(p.discount);
  const ribassoEur = (previousPrice != null && priceRaw != null && previousPrice > priceRaw)
    ? (previousPrice - priceRaw) : null;
  const agency = ((e.agencyName ?? "") + "").trim() || null;
  const phones: string[] = Array.isArray(e.contactPhones) ? e.contactPhones : [];
  const listingId = String(raw?.realEstateAdId ?? raw?.id ?? url.match(/annunci\/(\d+)/)?.[1] ?? "");
  const roomsFallback = toInt(String(t?.rooms ?? "").match(/\d+/)?.[0]);
  const surfaceFallback = toInt(t?.surface?.size);
  return {
    ok: true,
    row: {
      job_id: jobId, portal: "immobiliare", listing_id: listingId || null, url,
      raw_address: e.address ?? g.street ?? null, citta: "Padova",
      cap: e.zipcode ?? g.zipcode ?? null, lat, lng, omi_zone: null,
      quartiere: g?.microzone?.name ?? e.microzone ?? a?.microzone ?? null,
      tipo_lead: agency ? "AGENZIA" : "PRIVATO", n_agenzie: agency ? 1 : 0,
      prezzo: priceRaw, prezzo_iniziale: previousPrice ?? priceRaw,
      previous_price_eur: previousPrice, ribasso_pct: ribassoPct,
      ribasso_eur: ribassoEur, ribasso_date: null,
      mq: toInt(e.surfaceSqm ?? e.commercialSurfaceSqm) ?? surfaceFallback,
      locali: toInt(e.rooms) ?? roomsFallback,
      bagni: toInt(e.bathrooms) ?? toInt(t?.bathrooms),
      agency, agency_phone: phones[0] ?? null,
      tipologia: e.propertyType ?? t?.typology?.name ?? null,
      piano: e.floor ?? t?.floor ?? null,
      stato: e.condition ?? a?.propertyStatus ?? null,
      anno_costruzione: toInt(e.yearBuilt), cluster_key: null,
      parse_status: "apify_immobiliare_detail",
      processed_at: nowIso, http_status: 200, log_reason: null, attempts: 0,
      raw_json: raw, updated_at: nowIso,
    },
  };
}

export function mapImmoListview(raw: any, jobId: string, nowIso: string): MapOutcome {
  if (!raw || raw.error) return { ok: false, code: "UNMAPPABLE" };
  const scope = evaluateRawComuneScope("immobiliare", raw);
  if (!scope.ok) return { ok: false, code: scope.code };
  const url = canonUrl(raw?.directLink ?? (raw?.id ? `https://www.immobiliare.it/annunci/${raw.id}` : ""));
  if (!url) return { ok: false, code: "UNMAPPABLE" };
  const priceRaw = toInt(raw?.price?.value);
  const agencyObj = raw?.advertiser?.agency ?? {};
  const agency = ((agencyObj?.displayName ?? "") + "").trim() || null;
  const phone = agencyObj?.phones?.[0]?.value
    ?? raw?.advertiser?.supervisor?.phones?.[0]?.value ?? null;
  const listingId = String(raw?.id ?? url.match(/annunci\/(\d+)/)?.[1] ?? "");
  const p0 = (Array.isArray(raw?.properties) ? raw.properties.find((x: any) => x?.isMain) ?? raw.properties[0] : null) ?? {};
  const loc = p0?.location ?? {};
  const mq = toInt(String(p0?.surface ?? "").match(/\d+/)?.[0]);
  const locali = toInt(String(p0?.rooms ?? "").match(/\d+/)?.[0]);
  const bagni = toInt(String(p0?.bathrooms ?? "").match(/\d+/)?.[0]);
  return {
    ok: true,
    row: {
      job_id: jobId, portal: "immobiliare", listing_id: listingId || null, url,
      raw_address: loc?.address ?? null, citta: "Padova",
      cap: null, lat: toFloat(loc?.latitude), lng: toFloat(loc?.longitude),
      omi_zone: null, quartiere: loc?.microzone ?? loc?.macrozone ?? null,
      tipo_lead: agency ? "AGENZIA" : "PRIVATO", n_agenzie: agency ? 1 : 0,
      prezzo: priceRaw, prezzo_iniziale: priceRaw,
      previous_price_eur: null, ribasso_pct: null, ribasso_eur: null, ribasso_date: null,
      mq, locali, bagni, agency, agency_phone: phone,
      tipologia: p0?.typology?.name ?? raw?.typology?.name ?? null,
      piano: p0?.floor?.value ?? null, stato: p0?.ga4Condition ?? null,
      anno_costruzione: null, cluster_key: null,
      parse_status: "apify_immobiliare_listview",
      processed_at: nowIso, http_status: 200, log_reason: null, attempts: 0,
      raw_json: raw, updated_at: nowIso,
    },
  };
}

// ============ SUBITO ============
function subitoPickPhotos(raw: any): string[] | null {
  const src = raw?.images;
  if (!Array.isArray(src)) return null;
  const urls = src.filter((u: any) => typeof u === "string" && /^https?:\/\//.test(u));
  return urls.length ? urls.slice(0, 20) : null;
}

export function mapSubito(raw: any, jobId: string, nowIso: string): MapOutcome {
  if (!raw || raw.error) return { ok: false, code: "UNMAPPABLE" };
  const scope = evaluateRawComuneScope("subito", raw);
  if (!scope.ok) return { ok: false, code: scope.code };
  const url = canonUrl(raw?.page_url ?? "");
  if (!url) return { ok: false, code: "UNMAPPABLE" };
  const listingId = String(url.match(/-(\d+)\.htm$/)?.[1] ?? "");
  const loc = raw?.location ?? {};
  const city: string = (loc?.city ?? "").toString();
  const province: string = (loc?.province ?? "").toString();
  const region: string = (loc?.region ?? "").toString();
  const lat = toFloat(loc?.coordinates?.latitude);
  const lng = toFloat(loc?.coordinates?.longitude);
  const f = raw?.features ?? {};
  const feat = (k: string) => f?.[k]?.value ?? null;
  const featLabel = (k: string) => f?.[k]?.label ?? null;
  const priceRaw = toInt(raw?.price?.value);
  const tipoTransazione = (raw?.type ?? "").toString();
  if (tipoTransazione && !tipoTransazione.toLowerCase().includes("vendita")) {
    return { ok: false, code: "NOT_SALE" };
  }
  if (!Number.isFinite(priceRaw) || (priceRaw ?? 0) < 10000) {
    return { ok: false, code: "PRICE_TOO_LOW" };
  }
  const mq = toInt(feat("size_sqm"));
  const locali = toInt(feat("rooms"));
  const bagni = toInt(feat("bathrooms"));
  const floorValue = feat("floor");
  const floorLabel = featLabel("floor");
  const piano = floorValue != null
    ? String(floorValue)
    : (floorLabel != null && String(floorLabel).trim() !== "" ? String(floorLabel).trim() : null);
  const stato = featLabel("building_condition");
  const adv = raw?.advertiser ?? {};
  const advType = (adv?.type ?? "").toString().toLowerCase();
  const isCompany = advType === "azienda" || raw?.isPrivateAdvertiser === false;
  const agency = isCompany ? (adv?.name ?? null) : null;
  const agencyPhone = adv?.phone_number ?? null;
  const tipologia = raw?.sub_category ?? raw?.title ?? null;
  const rawAddress = [city, province].filter(Boolean).join(", ") || null;
  return {
    ok: true,
    row: {
      job_id: jobId, portal: "subito", listing_id: listingId || null, url,
      raw_address: rawAddress, citta: "Padova", cap: null, lat, lng,
      omi_zone: null, quartiere: null,
      tipo_lead: isCompany ? "AGENZIA" : "PRIVATO", n_agenzie: isCompany ? 1 : 0,
      prezzo: priceRaw, prezzo_iniziale: priceRaw,
      mq, locali, bagni, agency, agency_phone: agencyPhone,
      tipologia, piano, stato, anno_costruzione: null, cluster_key: null,
      parse_status: "apify_subito_detail",
      processed_at: nowIso, http_status: 200, log_reason: null, attempts: 0,
      previous_price_eur: null, ribasso_pct: null, ribasso_eur: null, ribasso_date: null,
      raw_json: { ...raw, _photos: subitoPickPhotos(raw), _shape: "subito",
        _city: city, _province: province, _region: region, _tipo_transazione: tipoTransazione },
      updated_at: nowIso,
    },
  };
}

// ============ CASA ============
export function mapCasa(raw: any, jobId: string, nowIso: string): MapOutcome {
  if (!raw || raw.error) return { ok: false, code: "UNMAPPABLE" };
  const scope = evaluateRawComuneScope("casa", raw);
  if (!scope.ok) return { ok: false, code: scope.code };
  const url = canonUrl(raw?.url ?? "");
  if (!url) return { ok: false, code: "UNMAPPABLE" };
  const listingId = raw?.id != null ? String(raw.id) : null;
  const prezzo = toInt(raw?.price);
  if ((raw?.channel ?? "").toString() !== "sale") return { ok: false, code: "NOT_SALE" };
  if (raw?.is_auction === true) return { ok: false, code: "AUCTION" };
  if (!Number.isFinite(prezzo) || (prezzo ?? 0) < 10000) return { ok: false, code: "PRICE_TOO_LOW" };
  const advType = (raw?.agency_type ?? "").toString().toLowerCase();
  const isPrivato = advType.includes("priv");
  const agency = raw?.agency ?? null;
  const rawAddress = [raw?.street, raw?.city].filter(Boolean).join(", ") || null;
  return {
    ok: true,
    row: {
      job_id: jobId, portal: "casa", listing_id: listingId, url,
      raw_address: rawAddress, citta: "Padova", cap: null,
      lat: toFloat(raw?.latitude), lng: toFloat(raw?.longitude),
      omi_zone: null, quartiere: raw?.zone ?? raw?.district ?? null,
      tipo_lead: isPrivato ? "PRIVATO" : "AGENZIA",
      n_agenzie: null,
      prezzo, prezzo_iniziale: null,
      mq: toInt(raw?.area_sqm), locali: toInt(raw?.rooms), bagni: toInt(raw?.bathrooms),
      agency, agency_phone: raw?.agency_phone ?? null,
      tipologia: raw?.property_type ?? null,
      piano: raw?.floor != null ? String(raw.floor) : null,
      stato: null, anno_costruzione: null, cluster_key: null,
      parse_status: "apify_casa_listview",
      processed_at: nowIso, http_status: 200, log_reason: null, attempts: 0,
      previous_price_eur: null, ribasso_pct: null, ribasso_eur: null, ribasso_date: null,
      raw_json: raw,
      updated_at: nowIso,
    },
  };
}

export interface MapperSpec {
  fn: (raw: any, jobId: string, nowIso: string) => MapOutcome;
  portal: string;
  allowListviewOverwrite: boolean;
}

export function mapperFor(actorId: string, portalTag: string): MapperSpec | null {
  if (actorId === ACTOR_IDEALISTA) return { fn: mapIdealista, portal: "idealista", allowListviewOverwrite: true };
  if (actorId === ACTOR_IMMO_DETAIL) return { fn: mapImmoDetail, portal: "immobiliare", allowListviewOverwrite: true };
  if (actorId === ACTOR_IMMO_LISTVIEW) return { fn: mapImmoListview, portal: "immobiliare", allowListviewOverwrite: false };
  if (actorId === ACTOR_SUBITO) return { fn: mapSubito, portal: "subito", allowListviewOverwrite: true };
  if (actorId === ACTOR_CASA) return { fn: mapCasa, portal: "casa", allowListviewOverwrite: true };
  if (portalTag.startsWith("idealista")) return { fn: mapIdealista, portal: "idealista", allowListviewOverwrite: true };
  if (portalTag.startsWith("immobiliare")) return { fn: mapImmoDetail, portal: "immobiliare", allowListviewOverwrite: true };
  if (portalTag.startsWith("subito")) return { fn: mapSubito, portal: "subito", allowListviewOverwrite: true };
  if (portalTag.startsWith("casa")) return { fn: mapCasa, portal: "casa", allowListviewOverwrite: true };
  return null;
}
