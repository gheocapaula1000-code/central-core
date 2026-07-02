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
import { getApifyToken } from "../_shared/apify.ts";

const APIFY = "https://api.apify.com/v2";
const ACTOR = "emastra~subito-it-immobili";

const DEFAULT_SEARCH_URLS = [
  "https://www.subito.it/annunci-veneto/vendita/case/padova/",
  "https://www.subito.it/annunci-veneto/vendita/appartamenti/padova/",
];

interface Body {
  search_urls?: string[];
  max_items?: number;
  wait_seconds?: number;
  dry_run?: boolean;
  async_start?: boolean;
  ingest_run_id?: string; // per raccogliere dataset di un run già terminato
}

async function startRun(input: Record<string, unknown>, token: string) {
  const r = await fetch(
    `${APIFY}/acts/${encodeURIComponent(ACTOR)}/runs?token=${encodeURIComponent(token)}&waitForFinish=0`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
  );
  const j = await r.json();
  if (!r.ok) throw new Error(`apify_start_${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return { run_id: j.data.id as string, dataset_id: j.data.defaultDatasetId as string };
}

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
  const src = raw?.images ?? raw?.pics ?? raw?.photos ?? raw?.imageUrls ?? null;
  if (!src) return null;
  const urls: string[] = [];
  const walk = (v: any) => {
    if (!v) return;
    if (typeof v === "string" && /^https?:\/\//.test(v)) urls.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(src);
  return urls.length ? Array.from(new Set(urls)).slice(0, 20) : null;
}

function mapSubito(raw: any, jobId: string, nowIso: string) {
  if (!raw || raw.error) return null;

  const url = canonUrl(
    raw?.urls?.default ?? raw?.url ?? raw?.link ?? raw?.detailUrl ?? "",
  );
  if (!url) return null;

  const listingId = String(
    raw?.urn ?? raw?.id ?? raw?.itemId ?? url.match(/-(\d+)\.htm/)?.[1] ?? "",
  );

  // Geo — Subito espone geo in diverse forme a seconda dello scraper
  const geo = raw?.geo ?? raw?.location ?? {};
  const town = geo?.town?.value ?? geo?.town ?? geo?.city?.value ?? geo?.city ?? null;
  const region = geo?.region?.value ?? geo?.region ?? null;
  const zone = geo?.city?.value ?? geo?.zone?.value ?? geo?.microzone?.value ?? null;
  const cap = geo?.zipcode ?? geo?.postalCode ?? geo?.zip ?? null;
  const lat = toFloat(geo?.map?.latitude ?? geo?.lat ?? raw?.latitude);
  const lng = toFloat(geo?.map?.longitude ?? geo?.lng ?? geo?.lon ?? raw?.longitude);

  // Features — la sorgente varia: array con {uri,value} oppure oggetto piatto
  const feats = raw?.features ?? raw?.attributes ?? raw?.ad?.features ?? null;
  const priceRaw = toInt(
    featVal(feats, ["price", "prezzo"]) ?? raw?.price?.value ?? raw?.price,
  );
  const mq = toInt(
    featVal(feats, ["mq", "size", "superficie", "surface"]) ?? raw?.size,
  );
  const locali = toInt(
    featVal(feats, ["locali", "rooms"]) ?? raw?.rooms,
  );
  const bagni = toInt(
    featVal(feats, ["bagni", "bathrooms"]) ?? raw?.bathrooms,
  );
  const piano = featVal(feats, ["piano", "floor"]);
  const stato = featVal(feats, ["stato", "condizioni", "condition"]);
  const tipologia = featVal(feats, ["tipologia", "typology"])
    ?? raw?.category?.label ?? raw?.category?.name ?? raw?.subject ?? null;

  // Advertiser
  const adv = raw?.advertiser ?? raw?.user ?? raw?.seller ?? {};
  const advType = (adv?.type ?? adv?.userType ?? "").toString().toLowerCase();
  const isCompany = advType === "company" || advType === "impresa" || advType === "agency";
  const agency = isCompany ? (adv?.name ?? adv?.displayName ?? null) : null;
  const agencyPhone = adv?.phone ?? adv?.phoneNumber ?? adv?.contactPhone ?? null;

  const rawAddress = [
    featVal(feats, ["indirizzo", "address"]) ?? null,
    town,
  ].filter(Boolean).join(", ") || null;

  return {
    job_id: jobId,
    portal: "subito",
    listing_id: listingId || null,
    url,
    raw_address: rawAddress,
    citta: "Padova",
    cap: cap ? String(cap) : null,
    lat,
    lng,
    omi_zone: null,
    quartiere: zone && zone !== town ? zone : null,
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
    piano: piano != null ? String(piano) : null,
    stato: stato != null ? String(stato) : null,
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
    raw_json: { ...raw, _photos: pickPhotos(raw), _shape: "subito", _town: town, _region: region },
    updated_at: nowIso,
  };
}

// Guard geografico: tiene solo Padova comune (CAP 35100-35143) o town='Padova'
function isPadova(row: any): boolean {
  const town = (row?.raw_json?._town ?? "").toString().toLowerCase();
  if (town.includes("padova")) {
    const capNum = parseInt(row?.cap ?? "", 10);
    if (Number.isFinite(capNum)) return capNum >= 35100 && capNum <= 35143;
    return true;
  }
  return false;
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

  const maxItems = body.max_items ?? 200;
  const timeoutSec = body.wait_seconds ?? 240;
  const searchUrls = body.search_urls ?? DEFAULT_SEARCH_URLS;

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
      // Start — actor emastra/subito-it-immobili usa `startUrls` come stringList
      // e `maxResultItems` (0 = illimitato).
      const started = await startRun(
        {
          startUrls: searchUrls,
          maxResultItems: maxItems,
        },
        token,
      );
      run_id = started.run_id;
      dataset_id = started.dataset_id;

      await sb.from("padova_apify_runs").insert({
        portal: "subito_collect",
        actor_id: ACTOR,
        run_id,
        dataset_id,
        status: "RUNNING",
        cost_cap_usd: 0.05,
      });

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
    const nowIso = new Date().toISOString();
    const jobId = `apify-subito-${nowIso.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
    const mappedAll = items.map((it) => mapSubito(it, jobId, nowIso)).filter(Boolean) as any[];
    const mapped = mappedAll.filter(isPadova);
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

    return new Response(
      JSON.stringify({
        ok: true, run_id, dataset_id, job_id: jobId,
        dataset_size: items.length,
        mapped_total: mappedAll.length,
        padova_kept: mapped.length,
        dropped_out_of_scope: droppedOutOfScope,
        deduped: deduped.length,
        created, updated, errors,
      }, null, 2),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
