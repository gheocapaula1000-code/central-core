// padova-apify-subito-collect
// Collect subito.it listings Padova via actor Apify `emastra/subito-it-immobili`.
// Scrive in `padova_collect_v2_items` con portal='subito', usando lo stesso
// pattern async_start / ingest_run_id di idealista + immobiliare.
//
// Modes:
//   - default sync: start + wait + ingest
//   - { async_start: true }: start, registra RUNNING in padova_apify_runs, ritorna 202
//   - { dry_run: true, max_items }: start + wait, ritorna sample senza scrivere
//   - { ingest_run_id }: (per collect-pending) legge dataset di run già SUCCEEDED
//
// Auth: x-job-secret === CENTRAL_CORE_JOB_SECRET.
// Nessun cron collegato — solo test manuale.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getApifyToken, startApifyRun } from "../_shared/apify.ts";
import { expireStaleScrapeJobs } from "../_shared/scrapeJobWatchdog.ts";


const APIFY = "https://api.apify.com/v2";
const ACTOR = "emastra~subito-it-immobili";

const DEFAULT_SEARCH_URLS = [
  "https://www.subito.it/annunci-veneto/vendita/immobili/padova/padova/",
  "https://www.subito.it/annunci-veneto/vendita/appartamenti/padova/padova/",
];

interface Body {
  search_urls?: string[];
  max_items?: number;
  wait_seconds?: number;
  dry_run?: boolean;
  async_start?: boolean;
  ingest_run_id?: string; // per raccogliere dataset di un run già terminato
}

// startRun locale rimossa: usare startApifyRun da _shared/apify.ts.


async function pollRun(runId: string, token: string, timeoutSec: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutSec * 1000) {
    const r = await fetch(`${APIFY}/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
    const j = await r.json();
    const status = j?.data?.status;
    if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
      return { status, run: j.data, dataset_id: j.data.defaultDatasetId as string };
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  return { status: "TIMEOUT_LOCAL", run: null, dataset_id: null };
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
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// Estrai il valore di una "feature" Subito qualsiasi sia lo shape (array/oggetto/scalare).
function featVal(features: any, keys: string[]): any {
  if (!features) return null;
  if (Array.isArray(features)) {
    for (const k of keys) {
      const f = features.find((x: any) =>
        (x?.uri ?? x?.key ?? x?.name ?? "").toString().toLowerCase().includes(k.toLowerCase()),
      );
      if (f) return f.value ?? f.values?.[0]?.value ?? f.values?.[0]?.key ?? null;
    }
    return null;
  }
  if (typeof features === "object") {
    for (const k of keys) {
      const v = features[k];
      if (v !== undefined) return typeof v === "object" ? (v.value ?? v.key ?? null) : v;
    }
  }
  return null;
}

function pickPhotos(raw: any): string[] | null {
  const src = raw?.images;
  if (!Array.isArray(src)) return null;
  const urls = src.filter((u: any) => typeof u === "string" && /^https?:\/\//.test(u));
  return urls.length ? urls.slice(0, 20) : null;
}

// Mapper per lo shape reale dell'actor emastra/subito-it-immobili.
// Campi verificati via dry_run 2026-07-02.
function mapSubito(raw: any, jobId: string, nowIso: string) {
  if (!raw || raw.error) return null;

  const url = canonUrl(raw?.page_url ?? "");
  if (!url) return null;

  const listingId = String(url.match(/-(\d+)\.htm$/)?.[1] ?? "");

  // Location
  const loc = raw?.location ?? {};
  const city: string = (loc?.city ?? "").toString();
  const province: string = (loc?.province ?? "").toString();
  const region: string = (loc?.region ?? "").toString();
  const lat = toFloat(loc?.coordinates?.latitude);
  const lng = toFloat(loc?.coordinates?.longitude);

  // Features (oggetto piatto con {label,value})
  const f = raw?.features ?? {};
  const feat = (k: string) => f?.[k]?.value ?? null;
  const featLabel = (k: string) => f?.[k]?.label ?? null;

  const priceRaw = toInt(raw?.price?.value);
  const mq = toInt(feat("size_sqm"));
  const locali = toInt(feat("rooms"));
  const bagni = toInt(feat("bathrooms"));
  // Fallback: se floor.value è null ma floor.label è testuale ("Rialzato", "Terra", "Seminterrato"),
  // preserva il valore testuale invece di scartarlo.
  const floorValue = feat("floor");
  const floorLabel = featLabel("floor");
  const piano = floorValue != null
    ? String(floorValue)
    : (floorLabel != null && String(floorLabel).trim() !== "" ? String(floorLabel).trim() : null);
  const stato = featLabel("building_condition");

  // Advertiser
  const adv = raw?.advertiser ?? {};
  const advType = (adv?.type ?? "").toString().toLowerCase();
  const isCompany = advType === "azienda" || raw?.isPrivateAdvertiser === false;
  const agency = isCompany ? (adv?.name ?? null) : null;
  const agencyPhone = adv?.phone_number ?? null;

  // Tipologia = sub_category (es. "appartamenti", "case", "attici")
  const tipologia = raw?.sub_category ?? raw?.title ?? null;

  // Address grezzo: Subito non espone via civico, solo città+provincia
  const rawAddress = [city, province].filter(Boolean).join(", ") || null;

  // Tipo transazione: filtra fuori affitti se presenti (guard applicata sopra)
  const tipoTransazione = (raw?.type ?? "").toString();

  return {
    job_id: jobId,
    portal: "subito",
    listing_id: listingId || null,
    url,
    raw_address: rawAddress,
    citta: "Padova",
    cap: null, // Subito non espone CAP
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
      ...raw,
      _photos: pickPhotos(raw),
      _shape: "subito",
      _city: city,
      _province: province,
      _region: region,
      _tipo_transazione: tipoTransazione,
    },
    updated_at: nowIso,
  };
}

// Guard: solo Padova comune, solo vendita, prezzo >= 10.000€
function isPadovaSaleValid(row: any): boolean {
  const city = (row?.raw_json?._city ?? "").toString().toLowerCase();
  if (city !== "padova") return false;
  const tipo = (row?.raw_json?._tipo_transazione ?? "").toString().toLowerCase();
  if (tipo && !tipo.includes("vendita")) return false;
  const prezzo = Number(row?.prezzo);
  if (!Number.isFinite(prezzo) || prezzo < 10000) return false;
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!jobSecret || req.headers.get("x-job-secret") !== jobSecret) {
    return new Response(
      JSON.stringify({ ok: false, error: "unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const token = getApifyToken();
  if (!token) {
    return new Response(
      JSON.stringify({ ok: false, error: "APIFY_API_TOKEN_missing" }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  let body: Body = {};
  try { body = await req.json(); } catch { /* empty */ }

  const rawMax = Number(body.max_items ?? 300);
  const maxItems = Math.min(1000, Math.max(1, Number.isFinite(rawMax) ? Math.trunc(rawMax) : 300));
  const timeoutSec = body.wait_seconds ?? 240;
  const searchUrls = body.search_urls ?? DEFAULT_SEARCH_URLS;
  // Apify Subito cost estimate: 5 USD / 1000 items → max_items * 5 / 1000
  const estCostUsd = Number(((maxItems * 5) / 1000).toFixed(3));

  try {
    // Modo "ingest_run_id": raccogli dataset di un run già terminato (usato da collect-pending)
    let run_id: string;
    let dataset_id: string;

    if (body.ingest_run_id) {
      const r = await fetch(`${APIFY}/actor-runs/${body.ingest_run_id}?token=${encodeURIComponent(token)}`);
      const j = await r.json();
      if (!r.ok || !j?.data?.defaultDatasetId) {
        throw new Error(`apify_run_lookup_${r.status}`);
      }
      run_id = body.ingest_run_id;
      dataset_id = j.data.defaultDatasetId;
    } else {
      // Release skip-locks held by jobs stuck in RUNNING past the watchdog timeout
      // before the 6h dedup check, otherwise a hung run blocks every later collect.
      await expireStaleScrapeJobs(sb);

      // Guard: dedup run in-flight (RUNNING nelle ultime 6h)
      const sixHoursAgo = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
      const { data: inflight, error: inflightErr } = await sb
        .from("padova_apify_runs")
        .select("run_id, started_at")
        .eq("portal", "subito_collect")
        .eq("status", "RUNNING")
        .gte("started_at", sixHoursAgo)
        .limit(1);
      if (inflightErr) {
        // Fail-closed: non avviare né contabilizzare nulla se il check dedup fallisce.
        return new Response(
          JSON.stringify({ ok: false, code: "APIFY_DEDUP_CHECK_FAILED" }),
          { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (inflight && inflight.length > 0) {
        return new Response(
          JSON.stringify({
            ok: false, skipped: true,
            skipped_reason: "subito_run_already_running",
            existing_run_id: inflight[0].run_id,
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Guardia budget + lancio unificato (canSpendApify/recordApifySpend + insert padova_apify_runs).
      const launched = await startApifyRun(
        ACTOR,
        { startUrls: searchUrls, maxResultItems: maxItems },
        { portal: "subito_collect", estUsd: estCostUsd, costCapUsd: estCostUsd },
      );
      if (!launched.started) {
        console.warn(`[apify] lancio saltato: ${launched.reason} portal=subito_collect`);
        return new Response(
          JSON.stringify({ ok: false, skipped: true, reason: launched.reason }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      run_id = launched.run_id;
      dataset_id = launched.dataset_id;



      if (body.async_start) {
        return new Response(
          JSON.stringify({
            ok: true, async_start: true, run_id, dataset_id,
            search_urls: searchUrls.length,
            note: "run avviato in async: collect-pending completerà ingest",
          }, null, 2),
          { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const { status } = await pollRun(run_id, token, timeoutSec);
      if (status !== "SUCCEEDED") {
        return new Response(
          JSON.stringify({
            ok: false, run_id, dataset_id, status,
            note: "run non terminato, alza wait_seconds o pesca via ingest_run_id",
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    const items = await fetchDataset(dataset_id, token, maxItems);
    if (items.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "provider_returned_zero_items", run_id, dataset_id }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const nowIso = new Date().toISOString();
    const jobId = `apify-subito-${nowIso.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
    const mappedAll = items.map((it) => mapSubito(it, jobId, nowIso)).filter(Boolean) as any[];
    const mapped = mappedAll.filter(isPadovaSaleValid);
    const droppedOutOfScope = mappedAll.length - mapped.length;

    // Dedup per url
    const byUrl = new Map<string, any>();
    for (const r of mapped) byUrl.set(r.url, r);
    const deduped = Array.from(byUrl.values());

    if (body.dry_run) {
      // Estrai le "top-level keys" del primo raw per capire la shape reale
      const rawKeys = items[0] ? Object.keys(items[0]).sort() : [];
      const geoKeys = items[0]?.geo ? Object.keys(items[0].geo) : null;
      const advKeys = items[0]?.advertiser ? Object.keys(items[0].advertiser) : null;
      const featsSample = items[0]?.features
        ? (Array.isArray(items[0].features)
          ? items[0].features.slice(0, 8)
          : Object.keys(items[0].features).slice(0, 20))
        : null;

      return new Response(
        JSON.stringify({
          ok: true, dry_run: true, run_id, dataset_id,
          dataset_size: items.length,
          mapped_total: mappedAll.length,
          padova_kept: mapped.length,
          dropped_out_of_scope: droppedOutOfScope,
          deduped: deduped.length,
          schema_probe: {
            raw_top_level_keys: rawKeys,
            geo_keys: geoKeys,
            advertiser_keys: advKeys,
            features_sample: featsSample,
          },
          sample_mapped: deduped.slice(0, 3),
          sample_raw: items.slice(0, 2),
        }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Upsert (portal='subito', url)
    const urls = deduped.map((r) => r.url);
    const existing = new Map<string, number>();
    for (let i = 0; i < urls.length; i += 100) {
      const { data } = await sb
        .from("padova_collect_v2_items")
        .select("id,url").eq("portal", "subito")
        .in("url", urls.slice(i, i + 100));
      for (const r of data ?? []) if (r.url) existing.set(r.url, Number(r.id));
    }

    let created = 0, updated = 0;
    const errors: string[] = [];
    const inserts: any[] = [];
    for (const row of deduped) {
      const eid = existing.get(row.url);
      if (eid) {
        const { error } = await sb.from("padova_collect_v2_items").update(row).eq("id", eid);
        if (error) errors.push(`upd:${error.message}`); else updated++;
      } else {
        inserts.push(row);
      }
    }
    for (let i = 0; i < inserts.length; i += 200) {
      const slice = inserts.slice(i, i + 200);
      const { error } = await sb.from("padova_collect_v2_items").insert(slice);
      if (error) errors.push(`ins:${error.message}`); else created += slice.length;
    }

    await sb.from("padova_apify_runs").update({ status: "SUCCEEDED" }).eq("run_id", run_id);

    const ok = errors.length === 0 && deduped.length > 0 && created + updated > 0;
    return new Response(
      JSON.stringify({
        ok, run_id, dataset_id, job_id: jobId,
        dataset_size: items.length,
        mapped_total: mappedAll.length,
        padova_kept: mapped.length,
        dropped_out_of_scope: droppedOutOfScope,
        deduped: deduped.length,
        created, updated, errors,
      }, null, 2),
      { status: ok ? 200 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
