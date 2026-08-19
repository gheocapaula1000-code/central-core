// padova-apify-collect-pending
// Recovery job: scansiona padova_apify_runs con status='RUNNING' più vecchi di
// `stale_minutes` (default 5) e, se l'actor Apify è SUCCEEDED, scarica il dataset,
// esegue il mapping (idealista / immobiliare detail / immobiliare listview in
// base a actor_id) e fa upsert su padova_collect_v2_items.
//
// Idempotente: usa (portal, url) per de-duplicare. Chiamato manualmente o da
// pg_cron ogni 15 minuti.
//
// Auth: x-job-secret === CENTRAL_CORE_JOB_SECRET
//
// Body opzionale:
//   { stale_minutes?: number, run_ids?: string[], max_runs?: number,
//     max_items_per_run?: number, dry_run?: boolean }

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getApifyToken } from "../_shared/apify.ts";
import { collectPendingRunError } from "../_shared/apifyLaunch.ts";
import { isJobSecretAuthorized, jobAuthFailure } from "../_shared/jobAuth.ts";
import { flattenSubitoForStaging } from "../_shared/subitoMapper.ts";
import {
  expireStaleScrapeJobs,
  WATCHDOG_ERROR,
  WATCHDOG_UNRECOVERABLE,
} from "../_shared/scrapeJobWatchdog.ts";
import {
  APIFY_DATASET_PAGE_SIZE,
  buildApifyRunWebhooks,
  clampMaxItemsPerRun,
  collectHttpStatus,
  collectPendingCount,
  collectPendingWebhookUrl,
  encodeApifyWebhooksQuery,
  extractCollectRunIds,
  waitForFinishSeconds,
} from "../_shared/apifyDrain.ts";
import {
  classifyProviderMunicipality,
  isExplicitPadovaMunicipality,
} from "./territory.ts";

const APIFY = "https://api.apify.com/v2";

const ACTOR_IDEALISTA = "dz_omar~idealista-scraper-api";
const ACTOR_IMMO_DETAIL = "memo23~immobiliare-scraper";
const ACTOR_IMMO_LISTVIEW = "azzouzana~immobiliare-it-listing-page-scraper-by-search-url";
const ACTOR_SUBITO = "emastra~subito-it-immobili";
const ACTOR_CASA = "benthepythondev~casa-it-scraper";

async function apifyRunStatus(runId: string, token: string, waitForFinishSec = 0) {
  const wait = waitForFinishSec > 0 ? `&waitForFinish=${waitForFinishSec}` : "";
  const timeoutMs = Math.max(15_000, (waitForFinishSec + 10) * 1000);
  const r = await fetch(
    `${APIFY}/actor-runs/${runId}?token=${encodeURIComponent(token)}${wait}`,
    { signal: AbortSignal.timeout(timeoutMs) },
  );
  if (!r.ok) return null;
  const j = await r.json();
  return j?.data ?? null;
}

async function startRun(actor: string, input: Record<string, unknown>, token: string) {
  const webhooks = buildApifyRunWebhooks({
    requestUrl: collectPendingWebhookUrl(Deno.env.get("SUPABASE_URL") ?? ""),
    jobSecret: Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "",
    apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
  });
  const webhookQuery = webhooks
    ? `&webhooks=${encodeURIComponent(encodeApifyWebhooksQuery(webhooks))}`
    : "";
  const r = await fetch(
    `${APIFY}/acts/${encodeURIComponent(actor)}/runs?token=${encodeURIComponent(token)}&waitForFinish=0${webhookQuery}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
  );
  const j = await r.json();
  if (!r.ok) throw new Error(`apify_start_${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return { run_id: j.data.id as string, dataset_id: j.data.defaultDatasetId as string };
}

async function fetchDatasetPaged(datasetId: string, token: string, maxItems: number) {
  const items: any[] = [];
  let offset = 0;
  let lastPageLength = 0;
  let requestedLimit = APIFY_DATASET_PAGE_SIZE;
  while (items.length < maxItems) {
    requestedLimit = Math.min(APIFY_DATASET_PAGE_SIZE, maxItems - items.length);
    const r = await fetch(
      `${APIFY}/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&clean=1&offset=${offset}&limit=${requestedLimit}`,
      { signal: AbortSignal.timeout(45_000) },
    );
    if (!r.ok) throw new Error(`apify_dataset_${r.status}`);
    const page = await r.json();
    if (!Array.isArray(page) || page.length === 0) break;
    items.push(...page);
    lastPageLength = page.length;
    if (page.length < requestedLimit) break;
    offset += page.length;
  }
  return { items, truncated: items.length >= maxItems && lastPageLength >= requestedLimit };
}

function canonUrl(u: string): string {
  if (!u) return "";
  return u.replace(/\?.*$/, "").replace(/\/$/, "").replace(/^http:/, "https:");
}
function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v).replace(/[^0-9-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}
function toFloat(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// ============ IDEALISTA MAPPER (identico a padova-apify-idealista-collect) ============
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

function mapIdealista(raw: any, jobId: string, nowIso: string) {
  if (!raw || raw.error) return null;
  const isDetail = !!(raw.ubication || raw.moreCharacteristics || raw.propertyId);
  const url = canonUrl(raw?.originalUrl ?? raw?.detailWebLink ?? raw?.url ?? raw?.sourceUrl ?? "");
  if (!url) return null;
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
  const city = String(
    addr?.city ?? ub?.city ?? ub?.municipality ?? ub?.administrativeAreaLevel3 ??
      raw?.municipality ?? raw?.city ?? "",
  ).trim();
  // Fail closed: un risultato privo di Comune esplicito o relativo a un
  // comune della provincia (es. Vigonza) non entra mai nello staging Padova.
  if (!isExplicitPadovaMunicipality(city)) return null;
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
    ? (ub?.administrativeAreaLevel4 ?? ub?.administrativeAreaLevel3 ?? ub?.locationName ?? null)
    : (raw?.neighborhood ?? raw?.district ?? null);
  const tipologia = isDetail
    ? (raw?.extendedPropertyType ?? raw?.detailedType?.typology ?? raw?.homeType ?? null)
    : (raw?.propertyType ?? raw?.detailedType?.typology ?? null);
  const listingId = String(
    raw?.propertyId ?? raw?.propertyCode ?? raw?.adid ?? url.match(/immobile\/(\d+)/)?.[1] ?? "",
  );
  return {
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
  };
}

// ============ IMMOBILIARE MAPPERS ============
function mapImmoDetail(raw: any, jobId: string, nowIso: string) {
  const e = raw?._enhanced ?? {};
  const g = raw?.geography ?? {};
  const p = raw?.price ?? {};
  const t = raw?.topology ?? {};
  const a = raw?.analytics ?? {};
  const city = String(
    e.city ?? e.municipality ?? g.city?.name ?? g.cityName ?? g.municipality ?? "",
  ).trim();
  if (!isExplicitPadovaMunicipality(city)) return null;
  const url = canonUrl(raw?.shareUrl ?? e.sourceUrl ?? e.listingUrl ?? "");
  if (!url) return null;
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
  };
}

function mapImmoListview(raw: any, jobId: string, nowIso: string) {
  const url = canonUrl(raw?.directLink ?? (raw?.id ? `https://www.immobiliare.it/annunci/${raw.id}` : ""));
  if (!url) return null;
  const priceRaw = toInt(raw?.price?.value);
  const agencyObj = raw?.advertiser?.agency ?? {};
  const agency = ((agencyObj?.displayName ?? "") + "").trim() || null;
  const phone = agencyObj?.phones?.[0]?.value
    ?? raw?.advertiser?.supervisor?.phones?.[0]?.value ?? null;
  const listingId = String(raw?.id ?? url.match(/annunci\/(\d+)/)?.[1] ?? "");
  const p0 = (Array.isArray(raw?.properties) ? raw.properties.find((x: any) => x?.isMain) ?? raw.properties[0] : null) ?? {};
  const loc = p0?.location ?? {};
  const city = String(loc?.city ?? "").trim();
  if (!isExplicitPadovaMunicipality(city)) return null;
  const mq = toInt(String(p0?.surface ?? "").match(/\d+/)?.[0]);
  const locali = toInt(String(p0?.rooms ?? "").match(/\d+/)?.[0]);
  const bagni = toInt(String(p0?.bathrooms ?? "").match(/\d+/)?.[0]);
  return {
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
  };
}

// ============ SUBITO MAPPER (identico a padova-apify-subito-collect) ============
function subitoPickPhotos(raw: any): string[] | null {
  const src = raw?.images;
  if (!Array.isArray(src)) return null;
  const urls = src.filter((u: any) => typeof u === "string" && /^https?:\/\//.test(u));
  return urls.length ? urls.slice(0, 20) : null;
}
function mapSubito(raw: any, jobId: string, nowIso: string) {
  if (!raw || raw.error) return null;
  const url = canonUrl(raw?.page_url ?? "");
  if (!url) return null;
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
  const tipoTransazione = (raw?.type ?? "").toString();
  const row: any = {
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
  };
  // Guard: Padova comune, vendita, prezzo >= 10.000€
  if (!isExplicitPadovaMunicipality(city)) return null;
  if (tipoTransazione && !tipoTransazione.toLowerCase().includes("vendita")) return null;
  if (!Number.isFinite(priceRaw) || (priceRaw ?? 0) < 10000) return null;
  return row;
}

// ============ CASA MAPPER ============
function mapCasa(raw: any, jobId: string, nowIso: string) {
  if (!raw || raw.error) return null;
  const url = canonUrl(raw?.url ?? "");
  if (!url) return null;
  const listingId = raw?.id != null ? String(raw.id) : null;
  const city = (raw?.city ?? "").toString().toLowerCase();
  const prezzo = toInt(raw?.price);
  const advType = (raw?.agency_type ?? "").toString().toLowerCase();
  const isPrivato = advType.includes("priv");
  const agency = raw?.agency ?? null;
  const rawAddress = [raw?.street, raw?.city].filter(Boolean).join(", ") || null;
  const row: any = {
    job_id: jobId, portal: "casa", listing_id: listingId, url,
    raw_address: rawAddress, citta: city || "padova", cap: null,
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
  };
  // Guardia: Padova comune, canale sale, prezzo >= 10.000€, no aste
  if (city !== "padova") return null;
  if ((raw?.channel ?? "").toString() !== "sale") return null;
  if (!Number.isFinite(prezzo) || (prezzo ?? 0) < 10000) return null;
  if (raw?.is_auction === true) return null;
  return row;
}

function mapperFor(actorId: string, portalTag: string) {
  if (actorId === ACTOR_IDEALISTA) return { fn: mapIdealista, portal: "idealista", allowListviewOverwrite: true };
  if (actorId === ACTOR_IMMO_DETAIL) return { fn: mapImmoDetail, portal: "immobiliare", allowListviewOverwrite: true };
  if (actorId === ACTOR_IMMO_LISTVIEW) return { fn: mapImmoListview, portal: "immobiliare", allowListviewOverwrite: false };
  if (actorId === ACTOR_SUBITO) return { fn: mapSubito, portal: "subito", allowListviewOverwrite: true };
  if (actorId === ACTOR_CASA) return { fn: mapCasa, portal: "casa", allowListviewOverwrite: true };
  // Fallback per portal tag legacy
  if (portalTag.startsWith("idealista")) return { fn: mapIdealista, portal: "idealista", allowListviewOverwrite: true };
  if (portalTag.startsWith("immobiliare")) return { fn: mapImmoDetail, portal: "immobiliare", allowListviewOverwrite: true };
  if (portalTag.startsWith("subito")) return { fn: mapSubito, portal: "subito", allowListviewOverwrite: true };
  if (portalTag.startsWith("casa")) return { fn: mapCasa, portal: "casa", allowListviewOverwrite: true };
  return null;
}

function rawMunicipality(actorId: string, portalTag: string, raw: any): string {
  if (actorId === ACTOR_IDEALISTA || portalTag.startsWith("idealista")) {
    const ub = raw?.ubication ?? {};
    const addr = raw?.contactInfo?.address ?? {};
    return String(addr?.city ?? ub?.city ?? ub?.municipality ??
      ub?.administrativeAreaLevel3 ?? raw?.municipality ?? raw?.city ?? "").trim();
  }
  if (actorId === ACTOR_IMMO_DETAIL) {
    const e = raw?._enhanced ?? {};
    const g = raw?.geography ?? {};
    return String(e.city ?? e.municipality ?? g.city?.name ?? g.cityName ??
      g.municipality ?? "").trim();
  }
  if (actorId === ACTOR_IMMO_LISTVIEW || portalTag.startsWith("immobiliare")) {
    const props = Array.isArray(raw?.properties) ? raw.properties : [];
    const p0 = props.find((entry: any) => entry?.isMain) ?? props[0] ?? {};
    return String(p0?.location?.city ?? "").trim();
  }
  if (actorId === ACTOR_SUBITO || portalTag.startsWith("subito")) {
    return String(raw?.location?.city ?? "").trim();
  }
  if (actorId === ACTOR_CASA || portalTag.startsWith("casa")) {
    return String(raw?.city ?? "").trim();
  }
  return "";
}

async function upsertItems(
  sb: any, mapped: any[], portal: string, allowListviewOverwrite: boolean,
): Promise<{ created: number; updated: number; skipped: number; errors: string[] }> {
  const urls = mapped.map((r) => r.url);
  const existing = new Map<string, number>();
  for (let i = 0; i < urls.length; i += 100) {
    const { data } = await sb.from("padova_collect_v2_items").select("id,url")
      .eq("portal", portal).in("url", urls.slice(i, i + 100));
    for (const r of data ?? []) if (r.url) existing.set(r.url, Number(r.id));
  }
  let created = 0, updated = 0, skipped = 0;
  const errors: string[] = [];
  const inserts: any[] = [];
  for (const row of mapped) {
    const eid = existing.get(row.url);
    const isListview = row.parse_status?.endsWith("_listview");
    if (eid) {
      if (isListview && !allowListviewOverwrite) { skipped++; continue; }
      const { error } = await sb.from("padova_collect_v2_items").update(row).eq("id", eid);
      if (error) errors.push(`upd:${error.message}`); else updated++;
    } else inserts.push(row);
  }
  for (let i = 0; i < inserts.length; i += 200) {
    const slice = inserts.slice(i, i + 200);
    const { error } = await sb.from("padova_collect_v2_items").insert(slice);
    if (error) errors.push(`ins:${error.message}`); else created += slice.length;
  }
  return { created, updated, skipped, errors };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!isJobSecretAuthorized(req.headers, jobSecret)) {
    const auth = jobAuthFailure(Boolean(jobSecret));
    return new Response(JSON.stringify({ ok: false, error: auth.error }),
      { status: auth.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const token = getApifyToken();
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: "APIFY_API_TOKEN_missing" }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  let body: any = {};
  try { body = await req.json(); } catch { /* empty ok */ }

  const staleMinutes = Number(body.stale_minutes ?? 5);
  const maxRuns = Number(body.max_runs ?? 20);
  const maxItemsPerRun = clampMaxItemsPerRun(body.max_items_per_run ?? 10000);
  const dryRun = !!body.dry_run;
  const drainWaitSeconds = Math.max(0, Math.min(50, Number(body.drain_wait_seconds ?? 0)));
  const requireProgress = body.require_progress === true;
  const requireCandidates = body.require_candidates === true;
  const requireTerminal = body.require_terminal === true;
  const requiredPortals = Array.isArray(body.required_portals)
    ? Array.from(new Set(body.required_portals.filter((value: unknown): value is string =>
      ["immobiliare", "idealista", "subito"].includes(String(value))
    )))
    : [];
  const zombieHours = Number(body.zombie_hours ?? 4);
  const autoEnrich = body.auto_enrich !== false; // default true
  const maxEnrichPerRun = Number(body.max_enrich_per_run ?? 200);
  // Auto-backfill: quando un run immobiliare_*_enrich/refresh finisce, lancia
  // il batch successivo di URL con agency IS NULL per completare la recovery.
  const agencyBackfillEnabled = body.agency_backfill_enabled !== false; // default true
  const agencyBackfillBatch = Math.max(1, Math.min(500, Number(body.agency_backfill_batch ?? 300)));
  const agencyBackfillMaxLaunches = Math.max(0, Number(body.agency_backfill_max_launches ?? 1));

  // Modalità costo-zero: nessuna chiamata al provider. La chiusura semantica
  // di una raccolta già terminale viene decisa SOLO su evidenza persistita
  // (righe padova_collect_v2_items toccate nella finestra del run). Assenza di
  // evidenza NON è zero-novità: è mancanza di prova e resta fallimento.
  const dbEvidenceOnly = body.db_evidence_only === true;
  const evidenceWindowHours = Math.max(1, Math.min(48, Number(body.evidence_window_hours ?? 6)));

  // Perimetro corrente: quando l'orchestratore correla l'esatto 05:10, la
  // selezione è vincolata a quei run (o almeno alla loro finestra temporale).
  const scopeStartedAfter = typeof body.scope_started_after === "string" &&
      !Number.isNaN(Date.parse(body.scope_started_after))
    ? new Date(body.scope_started_after).toISOString()
    : null;
  // Residui storici: classificazione auditabile e non distruttiva. Non dichiara
  // mai un import riuscito, marca solo l'assenza di evidenza di import.
  const quarantineStale = body.quarantine_stale === true;
  const quarantineOlderThanHours = Math.max(
    1,
    Math.min(720, Number(body.quarantine_older_than_hours ?? 24)),
  );


  const portalFamilyOf = (portalTag: string): string => {
    if (portalTag.startsWith("immobiliare")) return "immobiliare";
    if (portalTag.startsWith("idealista")) return "idealista";
    if (portalTag.startsWith("subito")) return "subito";
    if (portalTag.startsWith("casa")) return "casa";
    return "";
  };

  // Seleziona candidati: RUNNING più vecchi di staleMinutes, oppure run_ids espliciti.
  // Include anche SUCCEEDED con imported=0: padova-apify-multi-status può
  // arrivare prima di questo job e persistere lo stato finale Apify. Quella
  // run NON va considerata completata finché il dataset non è stato promosso
  // in padova_collect_v2_items.
  let candidates: any[] = [];
  const webhookRunIds = extractCollectRunIds(body);
  if (webhookRunIds.length) {
    const { data } = await sb.from("padova_apify_runs").select("*").in("run_id", webhookRunIds);
    candidates = data ?? [];
    const found = new Set((candidates as any[]).map((row) => String(row?.run_id ?? "")));
    // Webhook for a run not yet in padova_apify_runs: still drain by run_id.
    for (const runId of webhookRunIds) {
      if (!found.has(runId)) {
        candidates.push({ run_id: runId, actor_id: "", portal: "", dataset_id: "", status: "RUNNING" });
      }
    }
  } else if (dbEvidenceOnly) {
    // Solo run già terminali positivi e recenti: i residui storici sono stati
    // riconciliati a stato terminale non-successo e non devono più affiorare.
    const windowStart = new Date(Date.now() - evidenceWindowHours * 3600_000).toISOString();
    const { data } = await sb.from("padova_apify_runs").select("*")
      .eq("status", "SUCCEEDED")
      .gte("started_at", windowStart)
      .order("started_at", { ascending: false }).limit(maxRuns);
    candidates = data ?? [];
  } else {
    const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
    // Ordinamento decrescente + eventuale finestra di scope: i run correnti
    // hanno sempre la precedenza sui residui storici (anti-starvation).
    let runningQuery = sb.from("padova_apify_runs").select("*")
      .eq("status", "RUNNING").lt("started_at", cutoff);
    let succeededQuery = sb.from("padova_apify_runs").select("*")
      .eq("status", "SUCCEEDED")
      .or("imported.is.null,imported.eq.0")
      .lt("started_at", cutoff);
    if (scopeStartedAfter) {
      runningQuery = runningQuery.gte("started_at", scopeStartedAfter);
      succeededQuery = succeededQuery.gte("started_at", scopeStartedAfter);
    }
    const { data: runningRows } = await runningQuery
      .order("started_at", { ascending: false }).limit(maxRuns);
    const { data: succeededUnimportedRows } = await succeededQuery
      .order("started_at", { ascending: false }).limit(maxRuns);
    // Watchdog-expired rows: one last ingest attempt after the lock is released.
    let timedOutQuery = sb.from("padova_apify_runs").select("*")
      .eq("status", "FAILED")
      .eq("error", WATCHDOG_ERROR)
      .or("imported.is.null,imported.eq.0");
    if (scopeStartedAfter) {
      timedOutQuery = timedOutQuery.gte("started_at", scopeStartedAfter);
    }
    const { data: timedOutRows } = await timedOutQuery
      .order("started_at", { ascending: false }).limit(maxRuns);
    const byRunId = new Map<string, any>();
    for (const r of [...(runningRows ?? []), ...(succeededUnimportedRows ?? []), ...(timedOutRows ?? [])]) {
      if (r?.run_id) byRunId.set(String(r.run_id), r);
    }
    candidates = Array.from(byRunId.values()).slice(0, maxRuns);
  }

  // ============ QUARANTENA RESIDUI STORICI (costo zero) ============
  // Marca in modo auditabile i run non terminali/non importati più vecchi del
  // cutoff che NON fanno parte del perimetro corrente. Nessun import dichiarato.
  let quarantinedRuns = 0;
  let quarantineError: string | null = null;
  if (quarantineStale && !dryRun) {
    try {
      const qCutoff = new Date(Date.now() - quarantineOlderThanHours * 3600_000).toISOString();
      const scopeIds = new Set(candidates.map((row: any) => String(row?.run_id ?? "")));
      const { data: staleSucceeded } = await sb.from("padova_apify_runs")
        .select("run_id").eq("status", "SUCCEEDED")
        .or("imported.is.null,imported.eq.0")
        .lt("started_at", qCutoff).limit(500);
      const { data: staleRunning } = await sb.from("padova_apify_runs")
        .select("run_id").eq("status", "RUNNING")
        .lt("started_at", qCutoff).limit(500);
      const ids = Array.from(new Set([...(staleSucceeded ?? []), ...(staleRunning ?? [])]
        .map((row: any) => String(row?.run_id ?? ""))
        .filter((id) => id.length > 0 && !scopeIds.has(id))));
      if (ids.length > 0) {
        const stamp = new Date().toISOString();
        const { error } = await sb.from("padova_apify_runs").update({
          status: "QUARANTINED",
          error: `quarantine:no_import_evidence:${stamp}`,
        }).in("run_id", ids);
        if (error) quarantineError = "quarantine_update_failed";
        else quarantinedRuns = ids.length;
      }
    } catch {
      quarantineError = "quarantine_exception";
    }
  }


  const results: any[] = [];
  for (const row of candidates) {
    const runId: string = row.run_id;
    let actorId: string = row.actor_id ?? "";
    const portalTag: string = row.portal ?? "";
    let dsId: string = row.dataset_id ?? "";
    let finalStatus = "UNKNOWN";
    let itemsCount = 0;
    let created = 0, updated = 0, skipped = 0;
    let rejectedOutOfScope = 0, municipalityMissing = 0;
    const errors: string[] = [];

    if (dbEvidenceOnly) {
      // Nessuna chiamata provider: leggiamo solo cosa è stato realmente
      // persistito dopo l'avvio del run per la famiglia di portale.
      const family = portalFamilyOf(portalTag);
      if (!family) {
        results.push({ run_id: runId, portal: portalTag, action: "skip_unknown_portal_family" });
        continue;
      }
      const sinceIso = new Date(Date.parse(String(row.started_at))).toISOString();
      const portalFilter = family === "casa" ? ["casa", "casa.it"] : [family];
      const { count: createdRows, error: cErr } = await sb.from("padova_collect_v2_items")
        .select("id", { count: "exact", head: true })
        .in("portal", portalFilter)
        .gte("created_at", sinceIso);
      const { count: touchedRows, error: uErr } = await sb.from("padova_collect_v2_items")
        .select("id", { count: "exact", head: true })
        .in("portal", portalFilter)
        .gte("updated_at", sinceIso);
      if (cErr || uErr) {
        results.push({ run_id: runId, portal: portalTag, error: `evidence_query:${cErr?.message ?? uErr?.message}` });
        continue;
      }
      const createdCount = Number(createdRows ?? 0);
      const touchedCount = Number(touchedRows ?? 0);
      const updatedCount = Math.max(0, touchedCount - createdCount);
      if (touchedCount === 0) {
        // Nessuna riga toccata: non è zero-novità, è assenza di prova.
        results.push({
          run_id: runId, dataset_id: dsId, portal: portalTag, status: "SUCCEEDED",
          items: Number(row.items_count ?? 0), action: "db_evidence",
          error: "no_import_evidence", evidence: { created_rows: 0, touched_rows: 0, since: sinceIso },
        });
        continue;
      }
      results.push({
        run_id: runId, dataset_id: dsId, actor_id: actorId, portal: portalTag,
        status: "SUCCEEDED", items: Number(row.items_count ?? 0),
        created: createdCount, updated: updatedCount, skipped: 0, errors: [],
        action: "db_evidence", provider_queried: false,
        zero_novelty: createdCount === 0 && updatedCount > 0,
        evidence: { created_rows: createdCount, touched_rows: touchedCount, since: sinceIso },
        rejected_out_of_scope: 0, municipality_missing: 0, out_of_scope_written: 0,
      });
      continue;
    }

    try {

      const apifyData = await apifyRunStatus(
        runId,
        token,
        waitForFinishSeconds(drainWaitSeconds * 1000),
      );
      if (!apifyData) {
        if (!dryRun) {
          if (row.error === WATCHDOG_ERROR) {
            await sb.from("padova_apify_runs").update({
              error: WATCHDOG_UNRECOVERABLE,
              finished_at: new Date().toISOString(),
            }).eq("run_id", runId);
          } else {
            await sb.from("padova_apify_runs").update({
              error: collectPendingRunError("skip_no_apify_data"),
            }).eq("run_id", runId);
          }
        }
        results.push({
          run_id: runId,
          action: "skip_no_apify_data",
          error: row.error === WATCHDOG_ERROR ? WATCHDOG_UNRECOVERABLE : "apify_run_unreadable",
        });
        continue;
      }
      finalStatus = apifyData.status;
      if (!actorId && apifyData.actId) {
        actorId = String(apifyData.actId).replace("/", "~");
      }
      const datasetId = apifyData.defaultDatasetId ?? dsId;
      if (!dsId && datasetId) dsId = datasetId;

      if (finalStatus === "SUCCEEDED" && datasetId) {
        const mapper = mapperFor(actorId, portalTag);
        if (!mapper) {
          if (!dryRun) {
            await sb.from("padova_apify_runs").update({
              error: collectPendingRunError("skip_unknown_actor"),
            }).eq("run_id", runId);
          }
          results.push({ run_id: runId, action: "skip_unknown_actor", actor_id: actorId, portal: portalTag, error: "unknown_actor" });
          continue;
        }
        const fetched = await fetchDatasetPaged(datasetId, token, maxItemsPerRun);
        const items = fetched.items;
        itemsCount = items.length;
        for (const item of items) {
          const municipality = classifyProviderMunicipality(
            rawMunicipality(actorId, portalTag, item),
          );
          if (municipality === "missing") municipalityMissing++;
          else if (municipality === "out_of_scope") rejectedOutOfScope++;
        }
        const nowIso = new Date().toISOString();
        const jobId = `recovery-${nowIso.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
        const mapped = items.map((it) => mapper.fn(it, jobId, nowIso)).filter(Boolean) as any[];
        // Dedup by URL
        const byUrl = new Map<string, any>();
        for (const r of mapped) byUrl.set(r.url, r);
        const deduped = Array.from(byUrl.values());

        let promoted: { new: number; updated: number } | null = null;
        let promoteError: string | null = null;
        if (!dryRun) {
          const up = await upsertItems(sb, deduped, mapper.portal, mapper.allowListviewOverwrite);
          created = up.created; updated = up.updated; skipped = up.skipped;
          errors.push(...up.errors);

          if (mapper.portal === "subito" && deduped.length > 0) {
            const stagingRows = deduped.map((row) => ({
              raw_json: flattenSubitoForStaging(row.raw_json ?? row),
            }));
            for (let i = 0; i < stagingRows.length; i += 500) {
              const slice = stagingRows.slice(i, i + 500);
              const { error: stErr } = await sb.from("padova_subito_staging").insert(slice);
              if (stErr) errors.push(`staging:${stErr.message}`);
            }
          }



          // Arricchimento detail (subito/idealista) PRIMA della promote: best-effort,
          // bounded e con budget guard interno alla funzione chiamata.
          const importedCount = created + updated;
          if (importedCount > 0 && (mapper.portal === "subito" || mapper.portal === "idealista")) {
            try {
              const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
              if (jobSecret) {
                const er = await fetch(
                  `${Deno.env.get("SUPABASE_URL")}/functions/v1/padova-detail-enrich-collect`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "x-job-secret": jobSecret },
                    body: JSON.stringify({ since_hours: 6, limit: 15 }),
                  },
                );
                if (!er.ok) errors.push(`detail_enrich:HTTP ${er.status}`);
              }
            } catch (e) {
              errors.push(`detail_enrich:${String((e as Error)?.message ?? e)}`);
            }
          }

          // Promote freshly upserted rows into padova_listings (best-effort).
          if (importedCount > 0) {

            try {
              const { data: promoRes, error: promoErr } = await sb.rpc(
                "promote_padova_collect_v2_to_listings",
                { p_since: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString() },
              );
              if (promoErr) {
                promoteError = promoErr.message;
                errors.push(`promote:${promoErr.message}`);
                console.error(`[collect-pending] promote failed for run ${runId}:`, promoErr.message);
              } else if (promoRes && typeof promoRes === "object") {
                promoted = {
                  new: Number((promoRes as Record<string, unknown>).new ?? 0),
                  updated: Number((promoRes as Record<string, unknown>).updated ?? 0),
                };
                console.log(`[collect-pending] promoted run ${runId}:`, JSON.stringify(promoted));
              }
            } catch (e) {
              promoteError = (e as Error)?.message ?? String(e);
              errors.push(`promote_exception:${promoteError}`);
              console.error(`[collect-pending] promote exception for run ${runId}:`, promoteError);
            }
          }

          await sb.from("padova_apify_runs").update({
            status: "SUCCEEDED",
            finished_at: apifyData.finishedAt ?? nowIso,
            items_count: itemsCount,
            imported: importedCount,
            error: itemsCount === 0
              ? "provider_returned_empty_dataset"
              : (importedCount === 0 && deduped.length === 0
                ? "provider_returned_no_mappable_items"
                : null),
          }).eq("run_id", runId);
        }
        // ============ AUTO-TRIGGER PASS B (enrichment) ============
        // Se la run recuperata è di tipo discovery/listview, lancia enrichment
        // detail-by-URL sui soli URL NEW (non ancora presenti in
        // padova_collect_v2_items come detail). Il nuovo run verrà completato
        // dal prossimo tick di collect-pending.
        let enrichKicked: any = null;
        // Enrichment Pass B è riservato SOLO alle discovery di immobiliare.
        // Casa e altri portali non devono mai lanciarlo.
        const isImmobiliareRun =
          actorId === ACTOR_IMMO_LISTVIEW ||
          portalTag.startsWith("immobiliare");
        const isDiscoveryRun =
          isImmobiliareRun && (
            actorId === ACTOR_IMMO_LISTVIEW ||
            portalTag.includes("_discover") ||
            deduped.some((r) => r.parse_status?.endsWith("_listview"))
          );

        if (autoEnrich && !dryRun && isDiscoveryRun) {
          try {
            const portal = mapper.portal;
            const listviewUrls = deduped
              .filter((r) => r.parse_status?.endsWith("_listview"))
              .map((r) => r.url);
            if (listviewUrls.length > 0) {
              // Filtra NEW: non presenti come detail
              const alreadyDetail = new Set<string>();
              for (let i = 0; i < listviewUrls.length; i += 100) {
                const { data } = await sb.from("padova_collect_v2_items")
                  .select("url,parse_status").eq("portal", portal)
                  .in("url", listviewUrls.slice(i, i + 100));
                for (const r of data ?? []) {
                  if (r.url && r.parse_status?.endsWith("_detail")) alreadyDetail.add(r.url);
                }
              }
              const newUrls = listviewUrls.filter((u) => !alreadyDetail.has(u)).slice(0, maxEnrichPerRun);
              if (newUrls.length > 0) {
                const detailActor = portal === "idealista" ? ACTOR_IDEALISTA : ACTOR_IMMO_DETAIL;
                const input = portal === "idealista"
                  ? { Property_urls: newUrls.map((u) => ({ url: u })) }
                  : {
                      startUrls: newUrls,
                      maxItems: newUrls.length,
                      includeAgencyDetails: false,
                    };
                const { run_id: eRid, dataset_id: eDid } = await startRun(detailActor, input, token);
                await sb.from("padova_apify_runs").insert({
                  portal: `${portal}_autoenrich`,
                  actor_id: detailActor,
                  run_id: eRid,
                  dataset_id: eDid,
                  status: "RUNNING",
                  cost_cap_usd: 0.30,
                });
                enrichKicked = { run_id: eRid, urls: newUrls.length, actor: detailActor };
              } else {
                enrichKicked = { skipped: "no_new_urls", listview_seen: listviewUrls.length };
              }
            }
          } catch (e) {
            enrichKicked = { error: String((e as Error)?.message ?? e) };
          }
        }

        results.push({
          run_id: runId, dataset_id: datasetId, actor_id: actorId, portal: portalTag,
          status: finalStatus, items: itemsCount, deduped: deduped.length,
          created, updated, skipped, errors, dry_run: dryRun,
          truncated: fetched.truncated,
          rejected_out_of_scope: rejectedOutOfScope,
          municipality_missing: municipalityMissing,
          out_of_scope_written: 0,
          promoted, promote_error: promoteError,
          auto_enrich: enrichKicked,
        });

      } else if (["FAILED", "ABORTED", "TIMED-OUT"].includes(finalStatus)) {
        if (!dryRun) {
          await sb.from("padova_apify_runs").update({
            status: finalStatus,
            finished_at: apifyData.finishedAt ?? new Date().toISOString(),
            error: collectPendingRunError("marked_failed", finalStatus),
          }).eq("run_id", runId);
        }
        results.push({ run_id: runId, status: finalStatus, action: "marked_failed", dry_run: dryRun });
      } else {
        // Still RUNNING on Apify side. A watchdog-expired row cannot stay
        // open: mark unrecoverable so the next scheduled collect is not skipped.
        if (row.error === WATCHDOG_ERROR && !dryRun) {
          await sb.from("padova_apify_runs").update({
            status: "FAILED",
            error: WATCHDOG_UNRECOVERABLE,
            finished_at: new Date().toISOString(),
          }).eq("run_id", runId);
        }
        results.push({ run_id: runId, status: finalStatus, action: "still_running" });
      }
    } catch (e) {
      results.push({ run_id: runId, error: String((e as Error)?.message ?? e) });
    }
  }

  // ============ AUTO-RECOMPUTE CONTENDIBILI ============
  // Se in questo tick un run agency-backfill ha completato ingest, lancia
  // recompute_padova_listings_contendibili() per misurare subito il delta.
  const recomputeEnabled = body.recompute_after_backfill !== false; // default true
  let recomputeResult: any = null;
  if (!dryRun && recomputeEnabled) {
    const backfillIngested = results.some((r) =>
      r &&
      r.status === "SUCCEEDED" &&
      typeof r.portal === "string" &&
      r.portal === "immobiliare_agency_backfill" &&
      ((r.created ?? 0) + (r.updated ?? 0)) > 0
    );
    if (backfillIngested) {
      try {
        const { data: rc, error: rcErr } = await sb.rpc("recompute_padova_listings_contendibili");
        if (rcErr) {
          recomputeResult = { error: rcErr.message };
          console.error("[collect-pending] recompute failed:", rcErr.message);
        } else {
          recomputeResult = rc ?? { ok: true };
          console.log("[collect-pending] recompute done:", JSON.stringify(recomputeResult));
        }
      } catch (e) {
        recomputeResult = { error: String((e as Error)?.message ?? e) };
        console.error("[collect-pending] recompute exception:", (e as Error)?.message ?? e);
      }
    }
  }



  // ============ AUTO-BACKFILL AGENCY (immobiliare) ============
  // Se in questo tick almeno un run immobiliare detail/refresh ha completato
  // ingest con successo, arruola il batch successivo di URL con agency IS NULL
  // (parse_status='apify_immobiliare_detail' oppure legacy 'radar_ingested'/NULL)
  // e avvia un nuovo run detail-by-URL. Serve a completare la recovery agenzie
  // in modo automatico senza intervento manuale.
  const backfillLaunches: any[] = [];
  if (!dryRun && !dbEvidenceOnly && agencyBackfillEnabled && agencyBackfillMaxLaunches > 0) {
    const immoIngestCompleted = results.some((r) =>
      r &&
      r.actor_id === ACTOR_IMMO_DETAIL &&
      r.status === "SUCCEEDED" &&
      typeof r.portal === "string" &&
      /immobiliare_.*(enrich|refresh|autoenrich)/.test(r.portal) &&
      ((r.created ?? 0) + (r.updated ?? 0)) > 0
    );
    if (immoIngestCompleted) {
      try {
        // Evita di sovrapporre più batch: se c'è già un run immobiliare
        // detail/refresh RUNNING con meno di 2h di età, non lanciarne un altro.
        const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
        const { count: runningCount } = await sb.from("padova_apify_runs")
          .select("run_id", { count: "exact", head: true })
          .eq("status", "RUNNING")
          .eq("actor_id", ACTOR_IMMO_DETAIL)
          .gt("started_at", twoHoursAgo);
        if ((runningCount ?? 0) > 0) {
          backfillLaunches.push({ skipped: "already_running", running: runningCount });
        } else {
          for (let launched = 0; launched < agencyBackfillMaxLaunches; launched++) {
            // Seleziona URL candidati: portal immobiliare, agency null, non scaduti,
            // già presenti come detail (per non re-arricchire listview vuote) o legacy.
            const { data: candRows } = await sb.from("padova_collect_v2_items")
              .select("url")
              .eq("portal", "immobiliare")
              .is("agency", null)
              .in("parse_status", ["apify_immobiliare_detail", "radar_ingested"])
              .order("processed_at", { ascending: true, nullsFirst: true })
              .limit(agencyBackfillBatch);
            const urls = Array.from(new Set((candRows ?? [])
              .map((r: any) => r?.url).filter((u: any) => typeof u === "string" && u.length > 0)));
            if (urls.length === 0) {
              backfillLaunches.push({ skipped: "no_candidates" });
              break;
            }
            const { run_id: bRid, dataset_id: bDid } = await startRun(ACTOR_IMMO_DETAIL, {
              startUrls: urls,
              maxItems: urls.length,
              includeAgencyDetails: false,
            }, token);
            await sb.from("padova_apify_runs").insert({
              portal: "immobiliare_agency_backfill",
              actor_id: ACTOR_IMMO_DETAIL,
              run_id: bRid,
              dataset_id: bDid,
              status: "RUNNING",
              cost_cap_usd: 0.30,
            });
            backfillLaunches.push({ run_id: bRid, urls: urls.length });
            console.log(`[collect-pending] agency-backfill launched run ${bRid} with ${urls.length} urls`);
          }
        }
      } catch (e) {
        backfillLaunches.push({ error: String((e as Error)?.message ?? e) });
        console.error("[collect-pending] agency-backfill failed:", (e as Error)?.message ?? e);
      }
    }
  }

  // ============ ZOMBIE / WATCHDOG CLEANUP ============
  // Open statuses older than zombieHours are FAILED even if Apify still
  // reports RUNNING. Leaving them open forever made later collects skip.
  let zombiesMarked = 0;
  let watchdog = { apify: 0, firecrawl: 0, cron_log: 0 };
  if (!dryRun && !dbEvidenceOnly && zombieHours > 0) {
    watchdog = await expireStaleScrapeJobs(
      sb,
      new Date(),
      zombieHours * 3600_000,
    );
    zombiesMarked = watchdog.apify + watchdog.firecrawl;
  }

  const importsCount = results.reduce(
    (sum, result) => sum + Number(result?.created ?? 0) + Number(result?.updated ?? 0),
    0,
  );
  const terminalFailures = results.filter((result) => {
    if (!result || result.error || result.promote_error) return true;
    if (Array.isArray(result.errors) && result.errors.length > 0) return true;
    if (["FAILED", "ABORTED", "TIMED-OUT"].includes(String(result.status ?? ""))) return true;
    if (["skip_no_apify_data", "skip_unknown_actor"].includes(String(result.action ?? ""))) return true;
    // Un dataset provider vuoto è anomalo per i quattro portali configurati.
    // "Zero novità" significa invece dataset valido senza nuove righe nette.
    if (result.status === "SUCCEEDED" && Number(result.items ?? 0) === 0) return true;
    return false;
  });
  const auxiliaryFailures = [
    ...(quarantineError ? [{ error: quarantineError }] : []),
    ...backfillLaunches.filter((entry) => entry?.error),
    ...(recomputeResult?.error ? [recomputeResult] : []),
  ];
  const completedPortalFamilies = new Set(results
    .filter((result) => result?.status === "SUCCEEDED" && Number(result?.items ?? 0) > 0)
    .map((result) => {
      const portal = String(result?.portal ?? "").toLowerCase();
      if (portal.startsWith("immobiliare")) return "immobiliare";
      if (portal.startsWith("idealista")) return "idealista";
      if (portal.startsWith("subito")) return "subito";
      return "";
    })
    .filter(Boolean));
  const pendingCount = collectPendingCount(results);
  const candidatesOk = !requireCandidates || candidates.length > 0;
  const terminalOk = !requireTerminal || (results.length > 0 && results.every((result) =>
    result?.status === "SUCCEEDED" && Number(result?.items ?? 0) > 0
  ));
  const requiredPortalsOk = requiredPortals.every((portal) =>
    (completedPortalFamilies as Set<string>).has(String(portal))
  );
  const errorsCount = terminalFailures.length + auxiliaryFailures.length + pendingCount;
  const ok = terminalFailures.length === 0 && auxiliaryFailures.length === 0 &&
    pendingCount === 0 &&
    candidatesOk && terminalOk && requiredPortalsOk &&
    (!requireProgress || importsCount > 0);
  const httpStatus = collectHttpStatus({ ok, pendingCount, errorsCount });

  return new Response(JSON.stringify({
    ok, scanned: candidates.length, imports_count: importsCount,
    pending_count: pendingCount,
    zero_novelty: results.length > 0 && importsCount === 0 && pendingCount === 0 && results.every((result) =>
      result?.status === "SUCCEEDED" && Number(result?.items ?? 0) > 0
    ),
    required_portals_complete: requiredPortalsOk,
    completed_count: results.filter((result) => result?.status === "SUCCEEDED").length,
    rejected_out_of_scope: results.reduce((sum, result) =>
      sum + Number(result?.rejected_out_of_scope ?? 0), 0),
    municipality_missing: results.reduce((sum, result) =>
      sum + Number(result?.municipality_missing ?? 0), 0),
    out_of_scope_written: 0,
    errors_count: errorsCount,
    zombies_marked: zombiesMarked,
    watchdog,
    quarantined_runs: quarantinedRuns,
    quarantine_error: quarantineError,
    scope_started_after: scopeStartedAfter,
    scope_run_ids: webhookRunIds.length,
    agency_backfill: backfillLaunches,
    recompute: recomputeResult, results,
    error: ok ? undefined : (!candidatesOk
      ? "no_current_provider_candidates"
      : !terminalOk
      ? "provider_runs_not_terminal"
      : !requiredPortalsOk
      ? "required_portals_incomplete"
      : requireProgress && importsCount === 0
      ? "no_import_progress"
      : pendingCount > 0
      ? "collect_pending_still_running"
      : "collect_pending_partial_failure"),
  }, null, 2), {
    status: httpStatus,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
