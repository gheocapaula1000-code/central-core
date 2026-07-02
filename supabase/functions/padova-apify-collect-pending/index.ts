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

const APIFY = "https://api.apify.com/v2";

const ACTOR_IDEALISTA = "dz_omar~idealista-scraper-api";
const ACTOR_IMMO_DETAIL = "memo23~immobiliare-scraper";
const ACTOR_IMMO_LISTVIEW = "azzouzana~immobiliare-it-listing-page-scraper-by-search-url";

async function apifyRunStatus(runId: string, token: string) {
  const r = await fetch(`${APIFY}/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
  if (!r.ok) return null;
  const j = await r.json();
  return j?.data ?? null;
}

async function startRun(actor: string, input: Record<string, unknown>, token: string) {
  const r = await fetch(
    `${APIFY}/acts/${encodeURIComponent(actor)}/runs?token=${encodeURIComponent(token)}&waitForFinish=0`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
  );
  const j = await r.json();
  if (!r.ok) throw new Error(`apify_start_${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return { run_id: j.data.id as string, dataset_id: j.data.defaultDatasetId as string };
}


async function fetchDataset(datasetId: string, token: string, limit: number) {
  const r = await fetch(
    `${APIFY}/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&clean=1&limit=${limit}`,
  );
  if (!r.ok) throw new Error(`apify_dataset_${r.status}`);
  return (await r.json()) as any[];
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
  const mq = toInt(String(p0?.surface ?? "").match(/\d+/)?.[0]);
  const locali = toInt(String(p0?.rooms ?? "").match(/\d+/)?.[0]);
  const bagni = toInt(String(p0?.bathrooms ?? "").match(/\d+/)?.[0]);
  return {
    job_id: jobId, portal: "immobiliare", listing_id: listingId || null, url,
    raw_address: loc?.address ?? null, citta: loc?.city ?? "Padova",
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

function mapperFor(actorId: string, portalTag: string) {
  if (actorId === ACTOR_IDEALISTA) return { fn: mapIdealista, portal: "idealista", allowListviewOverwrite: true };
  if (actorId === ACTOR_IMMO_DETAIL) return { fn: mapImmoDetail, portal: "immobiliare", allowListviewOverwrite: true };
  if (actorId === ACTOR_IMMO_LISTVIEW) return { fn: mapImmoListview, portal: "immobiliare", allowListviewOverwrite: false };
  // Fallback per portal tag legacy
  if (portalTag.startsWith("idealista")) return { fn: mapIdealista, portal: "idealista", allowListviewOverwrite: true };
  if (portalTag.startsWith("immobiliare")) return { fn: mapImmoDetail, portal: "immobiliare", allowListviewOverwrite: true };
  return null;
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
  if (!jobSecret || req.headers.get("x-job-secret") !== jobSecret) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
  const maxItemsPerRun = Number(body.max_items_per_run ?? 1500);
  const dryRun = !!body.dry_run;
  const zombieHours = Number(body.zombie_hours ?? 4);
  const autoEnrich = body.auto_enrich !== false; // default true
  const maxEnrichPerRun = Number(body.max_enrich_per_run ?? 200);


  // Seleziona candidati: RUNNING più vecchi di staleMinutes, oppure run_ids espliciti.
  let candidates: any[] = [];
  if (Array.isArray(body.run_ids) && body.run_ids.length) {
    const { data } = await sb.from("padova_apify_runs").select("*").in("run_id", body.run_ids);
    candidates = data ?? [];
  } else {
    const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
    const { data } = await sb.from("padova_apify_runs").select("*")
      .eq("status", "RUNNING").lt("started_at", cutoff)
      .order("started_at", { ascending: true }).limit(maxRuns);
    candidates = data ?? [];
  }

  const results: any[] = [];
  for (const row of candidates) {
    const runId: string = row.run_id;
    const actorId: string = row.actor_id ?? "";
    const portalTag: string = row.portal ?? "";
    const dsId: string = row.dataset_id ?? "";
    let finalStatus = "UNKNOWN";
    let itemsCount = 0;
    let created = 0, updated = 0, skipped = 0;
    const errors: string[] = [];

    try {
      const apifyData = await apifyRunStatus(runId, token);
      if (!apifyData) {
        results.push({ run_id: runId, action: "skip_no_apify_data" });
        continue;
      }
      finalStatus = apifyData.status;
      const datasetId = apifyData.defaultDatasetId ?? dsId;

      if (finalStatus === "SUCCEEDED" && datasetId) {
        const mapper = mapperFor(actorId, portalTag);
        if (!mapper) {
          results.push({ run_id: runId, action: "skip_unknown_actor", actor_id: actorId, portal: portalTag });
          continue;
        }
        const items = await fetchDataset(datasetId, token, maxItemsPerRun);
        itemsCount = items.length;
        const nowIso = new Date().toISOString();
        const jobId = `recovery-${nowIso.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
        const mapped = items.map((it) => mapper.fn(it, jobId, nowIso)).filter(Boolean) as any[];
        // Dedup by URL
        const byUrl = new Map<string, any>();
        for (const r of mapped) byUrl.set(r.url, r);
        const deduped = Array.from(byUrl.values());

        if (!dryRun) {
          const up = await upsertItems(sb, deduped, mapper.portal, mapper.allowListviewOverwrite);
          created = up.created; updated = up.updated; skipped = up.skipped;
          errors.push(...up.errors);
          await sb.from("padova_apify_runs").update({
            status: "SUCCEEDED",
            finished_at: apifyData.finishedAt ?? nowIso,
            items_count: itemsCount,
          }).eq("run_id", runId);
        }
        results.push({
          run_id: runId, actor_id: actorId, portal: portalTag,
          status: finalStatus, items: itemsCount, deduped: deduped.length,
          created, updated, skipped, errors, dry_run: dryRun,
        });
      } else if (["FAILED", "ABORTED", "TIMED-OUT"].includes(finalStatus)) {
        if (!dryRun) {
          await sb.from("padova_apify_runs").update({
            status: finalStatus,
            finished_at: apifyData.finishedAt ?? new Date().toISOString(),
          }).eq("run_id", runId);
        }
        results.push({ run_id: runId, status: finalStatus, action: "marked_failed", dry_run: dryRun });
      } else {
        // Still RUNNING on Apify side → leave the row alone
        results.push({ run_id: runId, status: finalStatus, action: "still_running" });
      }
    } catch (e) {
      results.push({ run_id: runId, error: String((e as Error)?.message ?? e) });
    }
  }

  return new Response(JSON.stringify({
    ok: true, scanned: candidates.length, results,
  }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
