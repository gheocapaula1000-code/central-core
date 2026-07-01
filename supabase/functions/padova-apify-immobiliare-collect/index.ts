// padova-apify-immobiliare-collect
// Manual/test entrypoint that runs the Apify actor `memo23~immobiliare-scraper`
// on a set of Padova detail URLs and writes the result directly into
// `padova_collect_v2_items` using the same shape produced by the casa.it flow.
//
// Auth: x-job-secret === CENTRAL_CORE_JOB_SECRET
// Not wired to any pg_cron. Intended for manual test runs only.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getApifyToken } from "../_shared/apify.ts";

const APIFY = "https://api.apify.com/v2";
const ACTOR = "memo23~immobiliare-scraper";

interface Body {
  start_urls?: string[];
  max_items?: number;
  max_urls_from_db?: number;
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

function mapItem(raw: any, jobId: string, nowIso: string) {
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
  const priceStart = toInt(p.startPrice) ?? priceRaw;
  const agency = ((e.agencyName ?? "") + "").trim() || null;
  const phones: string[] = Array.isArray(e.contactPhones) ? e.contactPhones : [];
  const listingId = String(
    raw?.realEstateAdId ??
      raw?.id ??
      url.match(/annunci\/(\d+)/)?.[1] ??
      "",
  );

  // Fallback robusti: l'actor a volte omette _enhanced.* mentre gli stessi
  // dati sono presenti in topology/analytics del payload top-level.
  const roomsFallback = toInt(String(t?.rooms ?? "").match(/\d+/)?.[0]); // "5+" → 5
  const surfaceFallback = toInt(t?.surface?.size);

  return {
    job_id: jobId,
    portal: "immobiliare",
    listing_id: listingId || null,
    url,
    raw_address: e.address ?? g.street ?? null,
    citta: "Padova",
    cap: e.zipcode ?? g.zipcode ?? null, // nessun fallback: quando manca è offuscato alla sorgente
    lat,
    lng,
    omi_zone: null, // risolto in post da recompute/resolver
    quartiere: g?.microzone?.name ?? e.microzone ?? a?.microzone ?? null,
    tipo_lead: agency ? "AGENZIA" : "PRIVATO",
    n_agenzie: agency ? 1 : 0,
    prezzo: priceRaw,
    prezzo_iniziale: priceStart,
    mq: toInt(e.surfaceSqm ?? e.commercialSurfaceSqm) ?? surfaceFallback,
    locali: toInt(e.rooms) ?? roomsFallback,
    bagni: toInt(e.bathrooms) ?? toInt(t?.bathrooms),
    agency,
    agency_phone: phones[0] ?? null,
    tipologia: e.propertyType ?? t?.typology?.name ?? null,
    piano: e.floor ?? t?.floor ?? null,
    stato: e.condition ?? a?.propertyStatus ?? null,
    anno_costruzione: toInt(e.yearBuilt),
    cluster_key: null,
    parse_status: "apify_immobiliare_ingested",
    processed_at: nowIso,
    http_status: 200,
    log_reason: null,
    attempts: 0,
    raw_json: raw,
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
  try {
    body = await req.json();
  } catch {
    // body vuoto: ok, useremo default
  }
  const maxItems = body.max_items ?? 20;
  const timeoutSec = body.wait_seconds ?? 180;

  // Pesca URL immobiliare esistenti se non forniti
  let startUrls = body.start_urls ?? [];
  if (startUrls.length === 0) {
    const cap = body.max_urls_from_db ?? 20;
    const { data } = await sb
      .from("padova_immobiliare_detail_staging")
      .select("raw_json")
      .not("raw_json", "is", null)
      .limit(cap);
    startUrls = (data ?? [])
      .map((r: any) => r?.raw_json?.shareUrl ?? r?.raw_json?._enhanced?.sourceUrl)
      .filter(Boolean)
      .slice(0, cap);
  }
  if (startUrls.length === 0) {
    return new Response(
      JSON.stringify({ ok: false, error: "no_start_urls_available" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    // 1) Launch actor
    const { run_id, dataset_id } = await startRun(
      {
        startUrls: startUrls.map((u) => ({ url: u })),
        maxItems,
        includeAgencyDetails: false,
        proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
      },
      token,
    );

    await sb.from("padova_apify_runs").insert({
      portal: "immobiliare_collect_test",
      actor_id: ACTOR,
      run_id,
      dataset_id,
      status: "RUNNING",
      cost_cap_usd: 0.30,
    });

    // 2) Poll
    const { status } = await pollRun(run_id, token, timeoutSec);
    if (status !== "SUCCEEDED") {
      return new Response(
        JSON.stringify({
          ok: false,
          run_id,
          dataset_id,
          status,
          note: "run non terminato in tempo, riprova con wait_seconds più alto o pesca il dataset a mano",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 3) Fetch dataset
    const items = await fetchDataset(dataset_id, token, maxItems);
    const nowIso = new Date().toISOString();
    const jobId = `apify-immo-${nowIso.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
    const mapped = items
      .map((it) => mapItem(it, jobId, nowIso))
      .filter(Boolean) as any[];

    if (body.dry_run) {
      return new Response(
        JSON.stringify(
          {
            ok: true,
            run_id,
            dataset_id,
            dry_run: true,
            dataset_size: items.length,
            mapped: mapped.length,
            sample: mapped.slice(0, 2),
          },
          null,
          2,
        ),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 4) Upsert manuale su (portal='immobiliare', url) — stesso pattern di casa
    const urls = mapped.map((r) => r.url);
    const existing = new Map<string, number>();
    for (let i = 0; i < urls.length; i += 100) {
      const { data } = await sb
        .from("padova_collect_v2_items")
        .select("id,url")
        .eq("portal", "immobiliare")
        .in("url", urls.slice(i, i + 100));
      for (const r of data ?? []) if (r.url) existing.set(r.url, Number(r.id));
    }

    let created = 0;
    let updated = 0;
    const errors: string[] = [];
    const inserts: any[] = [];

    for (const row of mapped) {
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
      JSON.stringify(
        {
          ok: true,
          run_id,
          dataset_id,
          job_id: jobId,
          dataset_size: items.length,
          mapped: mapped.length,
          created,
          updated,
          errors,
        },
        null,
        2,
      ),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
