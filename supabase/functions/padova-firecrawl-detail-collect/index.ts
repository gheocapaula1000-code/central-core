// padova-firecrawl-detail-collect
// Riempie i dettagli (mq, locali, piano, bagni, agency, civico, tipologia,
// riscaldamento, stato, lat/lng, raw_json) per i ~5514 annunci di Padova
// del job sorgente e9709a73-e91f-49c4-bc11-a8bf27829875, via Firecrawl.
// Apify SOLO come fallback mirato, gated by canSpendApify().
//
// Azioni:
//   POST { action: "start" }    → crea job, lancia processing in background
//   POST { action: "status", job_id }
//   POST { action: "process", job_id, _internal_token }  (self-invocation)
//
// Salvataggio a blocchi: aggiorna ogni riga subito; batch da BATCH per invocation.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { fcScrape } from "../civiko-radar-veneto/firecrawl/firecrawlClient.ts";
import { canSpendApify, recordApifySpend } from "../_shared/apifyBudget.ts";
import { getApifyToken } from "../_shared/apify.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SOURCE_JOB_ID = "e9709a73-e91f-49c4-bc11-a8bf27829875";
const BATCH = 60;            // URLs per invocation
const CONC = 6;              // parallel Firecrawl calls
const FIRECRAWL_COST_PER_SCRAPE = 0.002; // $/scrape (stima)
const APIFY_COST_PER_FALLBACK = 0.0025;

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const INTERNAL_TOKEN = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "internal";
const FN_URL = `${SB_URL}/functions/v1/padova-firecrawl-detail-collect`;

function sb() {
  return createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
}

// ───────────────────────── extraction ──────────────────────────
function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}
function num(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = String(s).replace(/\./g, "").replace(",", ".").match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}
function intOnly(s: string | null | undefined): number | null {
  const n = num(s);
  return n == null ? null : Math.round(n);
}

function extractFromContent(markdown: string, html: string): Record<string, unknown> {
  const text = `${markdown}\n${html.replace(/<[^>]+>/g, " ")}`.toLowerCase();
  const out: Record<string, unknown> = {};

  // mq / superficie
  const mqM = text.match(/(?:superficie|mq|m²|m2)[^0-9]{0,15}(\d{2,4})\s*(?:mq|m²|m2)?/);
  if (mqM) out.mq = intOnly(mqM[1]);
  if (!out.mq) {
    const m2 = text.match(/(\d{2,4})\s*(?:mq|m²|m2)\b/);
    if (m2) out.mq = intOnly(m2[1]);
  }

  // locali
  const lM = text.match(/(\d{1,2})\s*(?:loca(?:li|le)|stanze|vani|camere)\b/);
  if (lM) out.locali = intOnly(lM[1]);

  // bagni
  const bM = text.match(/(\d{1,2})\s*bagn[io]\b/);
  if (bM) out.bagni = intOnly(bM[1]);

  // piano
  const piM = text.match(/piano[:\s]+([a-z0-9°\-\s]{1,30})/);
  if (piM) out.piano = clean(piM[1]).slice(0, 60);

  // tipologia
  const tipoM = text.match(/\b(appartamento|attico|villa|villetta|bilocale|trilocale|quadrilocale|monolocale|loft|mansarda|rustico|casa indipendente|porzione di casa)\b/);
  if (tipoM) out.tipologia = tipoM[1];

  // riscaldamento
  const rM = text.match(/riscaldamento[:\s]+([a-z0-9,\s\-]{3,60})/);
  if (rM) out.riscaldamento = clean(rM[1]).slice(0, 80);

  // stato
  const sM = text.match(/\bstato[:\s]+([a-z\s]{3,40})/);
  if (sM) out.stato = clean(sM[1]).slice(0, 60);

  // anno
  const aM = text.match(/\banno (?:di )?costruzione[:\s]+(\d{4})/);
  if (aM) out.anno_costruzione = intOnly(aM[1]);

  // civico
  const cM = text.match(/\b(?:via|viale|piazza|corso|largo|vicolo|strada|borgo|riviera|lungargine|calle|contr[aà]|stradella)\s+[a-zà-ù'.\s]{3,40}[, ]+(\d{1,4}[a-z]?)\b/i);
  if (cM) out.civico = cM[1];

  // agency
  const agM = html.match(/agenz[ia][^<]{0,80}<[^>]+>([^<]{3,80})/i)
           ?? html.match(/data-agency[^>]*>([^<]{3,80})/i)
           ?? markdown.match(/agenz[ia][^\n]{0,80}\n([^\n]{3,80})/i);
  if (agM) out.agency = clean(agM[1]).slice(0, 120);

  // lat/lng from JSON-LD or scripts
  const llM = html.match(/"latitude"\s*:\s*"?(-?\d+\.\d+)"?[\s\S]{0,80}?"longitude"\s*:\s*"?(-?\d+\.\d+)"?/)
           ?? html.match(/"lat"\s*:\s*(-?\d+\.\d+)[\s\S]{0,80}?"l[no]g(?:itude)?"\s*:\s*(-?\d+\.\d+)/i);
  if (llM) {
    out.lat = Number(llM[1]);
    out.lng = Number(llM[2]);
  }

  return out;
}

// ───────────────────────── apify fallback ──────────────────────────
async function apifyDetailFallback(url: string): Promise<{ md: string; html: string } | null> {
  const token = getApifyToken();
  if (!token) return null;
  const budget = await canSpendApify(APIFY_COST_PER_FALLBACK);
  if (!budget.ok) return null;
  try {
    // Use a generic content scraper as fallback (apify/web-scraper would need setup;
    // use apify/cheerio-scraper run-sync for a single URL with a basic page function).
    const res = await fetch(
      `https://api.apify.com/v2/acts/apify~cheerio-scraper/run-sync-get-dataset-items?token=${token}&timeout=60&memory=512`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startUrls: [{ url }],
          maxRequestsPerCrawl: 1,
          pageFunction: "async function pageFunction({ $, request, body }) { return { url: request.url, html: body }; }",
          proxyConfiguration: { useApifyProxy: true },
        }),
        signal: AbortSignal.timeout(75_000),
      },
    );
    await recordApifySpend(APIFY_COST_PER_FALLBACK);
    if (!res.ok) return null;
    const items = await res.json();
    const html = String(items?.[0]?.html ?? "");
    if (!html || html.length < 200) return null;
    const md = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").slice(0, 8000);
    return { md, html: html.slice(0, 20000) };
  } catch {
    return null;
  }
}

// ───────────────────────── processing ──────────────────────────
async function processOne(row: { id: number; url: string }): Promise<{
  ok: boolean;
  apifyUsed: boolean;
  fields: Record<string, unknown>;
}> {
  let md = "";
  let html = "";
  let apifyUsed = false;

  const fc = await fcScrape(row.url, { formats: ["markdown", "html"], timeoutMs: 30_000 });
  if (fc.ok && (fc.markdown || (fc as { html?: string }).html)) {
    md = fc.markdown ?? "";
    html = ((fc as unknown) as { html?: string }).html ?? "";
  } else {
    const af = await apifyDetailFallback(row.url);
    if (af) {
      md = af.md;
      html = af.html;
      apifyUsed = true;
    }
  }

  if (!md && !html) {
    return { ok: false, apifyUsed, fields: {} };
  }

  const fields = extractFromContent(md, html);
  fields.raw_json = { md: md.slice(0, 6000), html: html.slice(0, 12000) };
  return { ok: true, apifyUsed, fields };
}

async function pMap<T, R>(items: T[], conc: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(conc, items.length) }, async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

async function processBatch(jobId: string): Promise<{ remaining: number }> {
  const c = sb();

  // pick next BATCH rows from source job that don't have raw_json yet
  const { data: rows } = await c
    .from("padova_collect_v2_items")
    .select("id, url")
    .eq("job_id", SOURCE_JOB_ID)
    .is("raw_json", null)
    .not("url", "is", null)
    .limit(BATCH);

  if (!rows || rows.length === 0) {
    await c
      .from("padova_firecrawl_jobs")
      .update({ status: "done", finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("job_id", jobId);
    return { remaining: 0 };
  }

  const results = await pMap(rows as { id: number; url: string }[], CONC, processOne);

  let ok = 0,
    fail = 0,
    apifyUsed = 0;
  const cov = { mq: 0, locali: 0, piano: 0, bagni: 0, civico: 0, agency: 0, tipologia: 0, latlng: 0 };

  // update rows individually (so partial failures don't lose batch)
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as { id: number; url: string };
    const res = results[i];
    if (!res.ok) {
      fail++;
      // mark as processed-with-empty to avoid infinite retry
      await c
        .from("padova_collect_v2_items")
        .update({ raw_json: { error: "scrape_failed", at: new Date().toISOString() } })
        .eq("id", r.id);
      continue;
    }
    ok++;
    if (res.apifyUsed) apifyUsed++;
    const f = res.fields;
    if (f.mq) cov.mq++;
    if (f.locali) cov.locali++;
    if (f.piano) cov.piano++;
    if (f.bagni) cov.bagni++;
    if (f.civico) cov.civico++;
    if (f.agency) cov.agency++;
    if (f.tipologia) cov.tipologia++;
    if (f.lat && f.lng) cov.latlng++;

    // compute cluster_key via RPC-less direct call
    const { data: ckRow } = await c.rpc("compute_cluster_key", {
      p_via: null,
      p_civico: (f.civico as string | undefined) ?? null,
      p_mq: (f.mq as number | undefined) ?? null,
      p_locali: (f.locali as number | undefined) ?? null,
    });
    const cluster_key = typeof ckRow === "string" ? ckRow : null;

    await c
      .from("padova_collect_v2_items")
      .update({
        mq: f.mq ?? null,
        locali: f.locali ?? null,
        piano: f.piano ?? null,
        bagni: f.bagni ?? null,
        agency: f.agency ?? null,
        civico: f.civico ?? null,
        tipologia: f.tipologia ?? null,
        riscaldamento: f.riscaldamento ?? null,
        stato: f.stato ?? null,
        anno_costruzione: f.anno_costruzione ?? null,
        lat: f.lat ?? null,
        lng: f.lng ?? null,
        raw_json: f.raw_json,
        cluster_key,
      })
      .eq("id", r.id);
  }

  // increment counters
  const { data: cur } = await c
    .from("padova_firecrawl_jobs")
    .select("*")
    .eq("job_id", jobId)
    .maybeSingle();
  if (cur) {
    await c
      .from("padova_firecrawl_jobs")
      .update({
        annunci_processati: (cur.annunci_processati ?? 0) + rows.length,
        annunci_ok: (cur.annunci_ok ?? 0) + ok,
        annunci_fail: (cur.annunci_fail ?? 0) + fail,
        fallback_apify_usati: (cur.fallback_apify_usati ?? 0) + apifyUsed,
        spesa_firecrawl_usd: Number(((cur.spesa_firecrawl_usd ?? 0) + (rows.length - apifyUsed) * FIRECRAWL_COST_PER_SCRAPE).toFixed(4)),
        spesa_apify_usd: Number(((cur.spesa_apify_usd ?? 0) + apifyUsed * APIFY_COST_PER_FALLBACK).toFixed(4)),
        cov_mq: (cur.cov_mq ?? 0) + cov.mq,
        cov_locali: (cur.cov_locali ?? 0) + cov.locali,
        cov_piano: (cur.cov_piano ?? 0) + cov.piano,
        cov_bagni: (cur.cov_bagni ?? 0) + cov.bagni,
        cov_civico: (cur.cov_civico ?? 0) + cov.civico,
        cov_agency: (cur.cov_agency ?? 0) + cov.agency,
        cov_tipologia: (cur.cov_tipologia ?? 0) + cov.tipologia,
        cov_latlng: (cur.cov_latlng ?? 0) + cov.latlng,
        updated_at: new Date().toISOString(),
      })
      .eq("job_id", jobId);
  }

  return { remaining: rows.length === BATCH ? -1 : 0 };
}

async function selfInvoke(jobId: string) {
  try {
    await fetch(FN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""}`,
      },
      body: JSON.stringify({ action: "process", job_id: jobId, _internal_token: INTERNAL_TOKEN }),
    });
  } catch (e) {
    console.warn("selfInvoke error:", String(e));
  }
}

// ───────────────────────── handler ──────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const body = await req.json().catch(() => ({}));
  const action = String(body?.action ?? "");
  const c = sb();

  if (action === "start") {
    const { count } = await c
      .from("padova_collect_v2_items")
      .select("id", { count: "exact", head: true })
      .eq("job_id", SOURCE_JOB_ID)
      .not("url", "is", null);
    const total = count ?? 0;

    const jobId = crypto.randomUUID();
    await c.from("padova_firecrawl_jobs").insert({
      job_id: jobId,
      status: "running",
      source_job_id: SOURCE_JOB_ID,
      annunci_totali: total,
    });

    // reset raw_json so rows get re-scraped (only if user wants fresh run)
    // NOTE: we don't reset — we only fill rows that have raw_json IS NULL.
    // If you want a re-run, do it manually.

    // kick off background processing
    // @ts-ignore EdgeRuntime is available in Supabase Edge Functions
    EdgeRuntime.waitUntil(selfInvoke(jobId));

    return new Response(
      JSON.stringify({
        ok: true,
        nuovo_job_id: jobId,
        metodo: "firecrawl",
        apify_fallback_attivo: true,
        salvataggio_a_blocchi: BATCH,
        stima_costo_firecrawl_usd: Number((total * FIRECRAWL_COST_PER_SCRAPE).toFixed(2)),
        annunci_totali: total,
        note: "raccolta avviata — interroga action status per avanzamento",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (action === "status") {
    const jobId = String(body?.job_id ?? "");
    const { data } = await c.from("padova_firecrawl_jobs").select("*").eq("job_id", jobId).maybeSingle();
    if (!data) {
      return new Response(JSON.stringify({ ok: false, error: "job_not_found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const p = data.annunci_processati || 1;
    return new Response(
      JSON.stringify({
        ok: true,
        job_id: data.job_id,
        annunci_totali: data.annunci_totali,
        annunci_processati: data.annunci_processati,
        annunci_ok: data.annunci_ok,
        annunci_fail: data.annunci_fail,
        fallback_apify_usati: data.fallback_apify_usati,
        spesa_firecrawl_usd: Number(data.spesa_firecrawl_usd),
        spesa_apify_usd: Number(data.spesa_apify_usd),
        copertura_campi_percentuale: {
          mq: Math.round((data.cov_mq / p) * 100),
          locali: Math.round((data.cov_locali / p) * 100),
          piano: Math.round((data.cov_piano / p) * 100),
          bagni: Math.round((data.cov_bagni / p) * 100),
          civico: Math.round((data.cov_civico / p) * 100),
          agency: Math.round((data.cov_agency / p) * 100),
          tipologia: Math.round((data.cov_tipologia / p) * 100),
          lat_lng: Math.round((data.cov_latlng / p) * 100),
        },
        stato: data.status,
        updated_at: data.updated_at,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (action === "process") {
    if (String(body?._internal_token ?? "") !== INTERNAL_TOKEN) {
      return new Response(JSON.stringify({ ok: false, error: "forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const jobId = String(body?.job_id ?? "");
    if (!jobId) {
      return new Response(JSON.stringify({ ok: false, error: "job_id_required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    try {
      const { remaining } = await processBatch(jobId);
      if (remaining !== 0) {
        // more work — schedule next batch
        // @ts-ignore EdgeRuntime
        EdgeRuntime.waitUntil(selfInvoke(jobId));
      }
      return new Response(JSON.stringify({ ok: true, remaining }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await c
        .from("padova_firecrawl_jobs")
        .update({ last_error: msg.slice(0, 500), updated_at: new Date().toISOString() })
        .eq("job_id", jobId);
      // try to continue
      // @ts-ignore EdgeRuntime
      EdgeRuntime.waitUntil(selfInvoke(jobId));
      return new Response(JSON.stringify({ ok: false, error: msg }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  return new Response(JSON.stringify({ ok: false, error: "unknown_action" }), {
    status: 400,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
