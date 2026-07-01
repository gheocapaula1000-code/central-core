// padova-apify-idealista-collect
// Ibrido discovery + refresh per idealista.it via actor Apify
// `dz_omar/idealista-scraper-api`. Scrive direttamente in
// `padova_collect_v2_items` con lo stesso pattern di
// padova-apify-immobiliare-collect.
//
// Modes:
//   - "discovery": usa DEFAULT_DISCOVERY_URLS (o body.discovery_urls),
//                  ogni URL è una pagina di ricerca → desiredResults per URL.
//   - "refresh"  : pesca URL detail da padova_listings dove portal='idealista.it'
//                  e updated_at < now()-7d (o body.refresh_stale_days).
//   - "mixed"    : concatena discovery + refresh in un unico run (default).
//
// Auth: x-job-secret === CENTRAL_CORE_JOB_SECRET.
// NON collegata a nessun cron: chiamata manuale/test.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getApifyToken } from "../_shared/apify.ts";

const APIFY = "https://api.apify.com/v2";
const ACTOR = "dz_omar~idealista-scraper-api";

// URL di ricerca Padova (vendita), ordinati per data pubblicazione desc.
// Coprono l'intero comune con filtri di prezzo per non superare la paginazione
// interna dell'actor.
const DEFAULT_DISCOVERY_URLS = [
  "https://www.idealista.it/vendita-case/padova-padova/con-pubblicato_ultima-settimana/?ordinato-per=pubblicazione-desc",
  "https://www.idealista.it/vendita-case/padova-padova/?ordinato-per=pubblicazione-desc",
  "https://www.idealista.it/vendita-case/padova-padova/con-prezzo-max_200000/?ordinato-per=pubblicazione-desc",
  "https://www.idealista.it/vendita-case/padova-padova/con-prezzo_200000-400000/?ordinato-per=pubblicazione-desc",
  "https://www.idealista.it/vendita-case/padova-padova/con-prezzo-desde_400000/?ordinato-per=pubblicazione-desc",
];

type Mode = "discovery" | "refresh" | "mixed";

interface Body {
  mode?: Mode;
  discovery_urls?: string[];
  desired_results?: number;         // per URL di ricerca
  refresh_urls?: string[];          // override manuale
  max_urls_from_db?: number;        // cap per il pescaggio refresh
  refresh_stale_days?: number;      // default 7
  max_items?: number;               // cap globale hard sul dataset
  wait_seconds?: number;
  dry_run?: boolean;
}

async function startRun(input: Record<string, unknown>, token: string) {
  const r = await fetch(
    `${APIFY}/acts/${encodeURIComponent(ACTOR)}/runs?token=${encodeURIComponent(token)}&waitForFinish=0`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const j = await r.json();
  if (!r.ok) {
    throw new Error(`apify_start_${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  }
  return { run_id: j.data.id as string, dataset_id: j.data.defaultDatasetId as string };
}

async function pollRun(runId: string, token: string, timeoutSec: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutSec * 1000) {
    const r = await fetch(`${APIFY}/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
    const j = await r.json();
    const status = j?.data?.status;
    if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
      return { status, run: j.data };
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  return { status: "TIMEOUT_LOCAL", run: null };
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

function pickPhotos(raw: any): string[] | null {
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

function mapItem(raw: any, jobId: string, nowIso: string) {
  // Skippa i record d'errore (`{url, error}`) e quelli senza payload valido
  if (!raw || raw.error || raw.status && raw.status !== "success") {
    if (!raw?.originalUrl && !raw?.detailWebLink) return null;
  }

  const ub = raw?.ubication ?? {};
  const ci = raw?.contactInfo ?? {};
  const mc = raw?.moreCharacteristics ?? {};
  const pd = raw?.priceDropInfo ?? null;
  const addr = ci?.address ?? {};

  const url = canonUrl(raw?.originalUrl ?? raw?.detailWebLink ?? raw?.url ?? "");
  if (!url) return null;

  const priceRaw = toInt(raw?.price ?? raw?.priceInfo?.amount);

  // Prezzo precedente: se c'è priceDropInfo, prezzo attuale + priceDropValue
  const priceDropValue = toFloat(pd?.priceDropValue);
  const previousPriceEur = priceRaw != null && priceDropValue != null
    ? priceRaw + priceDropValue
    : null;
  const ribassoPct = toFloat(pd?.priceDropPercentage);
  const ribassoEur = priceDropValue;
  const ribassoDate = pd?.dropDate ? new Date(Number(pd.dropDate)).toISOString() : null;

  const streetName = addr?.streetName ?? ub?.title ?? null;
  const streetNumber = addr?.streetNumber ?? null;
  const rawAddress = streetName
    ? (streetNumber ? `${streetName} ${streetNumber}` : streetName)
    : ub?.title ?? null;

  const agency = (ci?.commercialName ?? ci?.contactName ?? ci?.agentInfo?.name ?? "").toString().trim() || null;
  const agencyPhone = ci?.phone1?.formattedPhoneWithPrefix ?? ci?.phone1?.phoneNumber ?? null;
  const isProfessional = ci?.professional === true || ci?.userType === "professional";

  const listingId = String(raw?.propertyId ?? raw?.adid ?? url.match(/immobile\/(\d+)/)?.[1] ?? "");

  return {
    job_id: jobId,
    portal: "idealista",
    listing_id: listingId || null,
    url,
    raw_address: rawAddress,
    citta: "Padova",
    cap: addr?.postalCode ?? null,
    lat: toFloat(ub?.latitude),
    lng: toFloat(ub?.longitude),
    omi_zone: null,
    quartiere: ub?.administrativeAreaLevel4 ?? ub?.administrativeAreaLevel3 ?? ub?.locationName ?? null,
    tipo_lead: isProfessional ? "AGENZIA" : (agency ? "AGENZIA" : "PRIVATO"),
    n_agenzie: agency ? 1 : 0,
    prezzo: priceRaw,
    prezzo_iniziale: previousPriceEur ?? priceRaw,
    mq: toInt(mc?.constructedArea) ?? toInt(mc?.usableArea),
    locali: toInt(mc?.roomNumber),
    bagni: toInt(mc?.bathNumber),
    agency,
    agency_phone: agencyPhone,
    tipologia: raw?.extendedPropertyType ?? raw?.detailedType?.typology ?? raw?.homeType ?? null,
    piano: mc?.floor != null ? String(mc.floor) : null,
    stato: mc?.status ?? null,
    anno_costruzione: null,
    cluster_key: null,
    parse_status: "apify_idealista_ingested",
    processed_at: nowIso,
    http_status: 200,
    log_reason: null,
    attempts: 0,
    // Colonne ribasso native Idealista
    previous_price_eur: previousPriceEur,
    ribasso_pct: ribassoPct,
    ribasso_eur: ribassoEur,
    ribasso_date: ribassoDate,
    raw_json: { ...raw, _photos: pickPhotos(raw) },
    updated_at: nowIso,
  };
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
  try { body = await req.json(); } catch { /* empty ok */ }

  const mode: Mode = body.mode ?? "mixed";
  const desiredResults = body.desired_results ?? 50;
  const maxItems = body.max_items ?? 300;
  const timeoutSec = body.wait_seconds ?? 300;
  const staleDays = body.refresh_stale_days ?? 7;
  const dbCap = body.max_urls_from_db ?? 100;

  // 1) Compone lista URL
  const discoveryUrls =
    mode === "refresh" ? [] : (body.discovery_urls ?? DEFAULT_DISCOVERY_URLS);

  let refreshUrls: string[] = [];
  if (mode === "refresh" || mode === "mixed") {
    if (body.refresh_urls?.length) {
      refreshUrls = body.refresh_urls.slice(0, dbCap);
    } else {
      const cutoff = new Date(Date.now() - staleDays * 86400_000).toISOString();
      const { data } = await sb
        .from("padova_listings")
        .select("url")
        .eq("portal", "idealista.it")
        .lt("updated_at", cutoff)
        .not("url", "is", null)
        .order("updated_at", { ascending: true })
        .limit(dbCap);
      refreshUrls = (data ?? []).map((r: any) => r.url).filter(Boolean);
    }
  }

  const allUrls = [...discoveryUrls, ...refreshUrls];
  if (allUrls.length === 0) {
    return new Response(
      JSON.stringify({ ok: false, error: "no_urls_for_mode", mode }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const { run_id, dataset_id } = await startRun(
      {
        Property_urls: allUrls.map((u) => ({ url: u })),
        desiredResults,
      },
      token,
    );

    await sb.from("padova_apify_runs").insert({
      portal: `idealista_collect_${mode}`,
      actor_id: ACTOR,
      run_id,
      dataset_id,
      status: "RUNNING",
      cost_cap_usd: 0.50,
    });

    const { status } = await pollRun(run_id, token, timeoutSec);
    if (status !== "SUCCEEDED") {
      return new Response(
        JSON.stringify({
          ok: false, run_id, dataset_id, status, mode,
          discovery_count: discoveryUrls.length,
          refresh_count: refreshUrls.length,
          note: "run non terminato, alza wait_seconds o pesca dataset a mano",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const items = await fetchDataset(dataset_id, token, maxItems);
    const nowIso = new Date().toISOString();
    const jobId = `apify-idealista-${nowIso.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
    const mapped = items.map((it) => mapItem(it, jobId, nowIso)).filter(Boolean) as any[];

    // Dedup per url in-batch (Idealista può restituire lo stesso annuncio da più URL di search)
    const byUrl = new Map<string, any>();
    for (const r of mapped) byUrl.set(r.url, r);
    const deduped = Array.from(byUrl.values());

    const priceDropCount = deduped.filter((r) => r.ribasso_eur != null).length;

    if (body.dry_run) {
      return new Response(
        JSON.stringify({
          ok: true, run_id, dataset_id, mode, dry_run: true,
          discovery_count: discoveryUrls.length,
          refresh_count: refreshUrls.length,
          dataset_size: items.length,
          mapped: mapped.length,
          deduped: deduped.length,
          price_drop_count: priceDropCount,
          sample: deduped.slice(0, 2),
        }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Upsert manuale (portal='idealista', url)
    const urls = deduped.map((r) => r.url);
    const existing = new Map<string, number>();
    for (let i = 0; i < urls.length; i += 100) {
      const { data } = await sb
        .from("padova_collect_v2_items")
        .select("id,url")
        .eq("portal", "idealista")
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
        if (error) errors.push(`upd:${error.message}`);
        else updated++;
      } else {
        inserts.push(row);
      }
    }
    for (let i = 0; i < inserts.length; i += 200) {
      const slice = inserts.slice(i, i + 200);
      const { error } = await sb.from("padova_collect_v2_items").insert(slice);
      if (error) errors.push(`ins:${error.message}`);
      else created += slice.length;
    }

    await sb.from("padova_apify_runs").update({ status: "SUCCEEDED" }).eq("run_id", run_id);

    return new Response(
      JSON.stringify({
        ok: true, run_id, dataset_id, job_id: jobId, mode,
        discovery_count: discoveryUrls.length,
        refresh_count: refreshUrls.length,
        dataset_size: items.length,
        mapped: mapped.length,
        deduped: deduped.length,
        price_drop_count: priceDropCount,
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
