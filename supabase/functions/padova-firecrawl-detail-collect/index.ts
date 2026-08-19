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
import { canSpendApify, recordApifySpend } from "../_shared/apifyBudget.ts";
import { expireStaleScrapeJobs } from "../_shared/scrapeJobWatchdog.ts";
import {
  jobSecretAuthorized,
  missingJobSecretConfigResponse,
  readIncomingJobSecret,
  unauthorizedJobResponse,
} from "../_shared/jobSecretAuth.ts";
import { extractFromContent } from "./extract.ts";
import {
  DEFAULT_COLLECT_JOB_ID,
  SOURCE_JOB_ID,
  logReason,
  remainingQueueOrFilter,
  shouldContinueChaining,
  storedStatus,
  type ParseStatus,
} from "./queue.ts";

// inline fcScrape (no cross-function imports)
async function fcScrape(
  url: string,
  opts: { timeoutMs?: number; formats?: string[] } = {},
): Promise<{ ok: boolean; markdown?: string; html?: string; error?: string; httpStatus?: number; errorKind?: "timeout" | "http" | "network" | "missing_key" }> {
  const key = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
  if (!key) return { ok: false, error: "FIRECRAWL_API_KEY missing", errorKind: "missing_key" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        formats: opts.formats ?? ["markdown", "html"],
        onlyMainContent: false,
      }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    const root = data?.data ?? data;
    const upstreamStatus: number | undefined =
      Number(root?.metadata?.statusCode) ||
      Number(data?.metadata?.statusCode) ||
      undefined;
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, httpStatus: upstreamStatus ?? res.status, errorKind: "http" };
    }
    return {
      ok: true,
      markdown: typeof root?.markdown === "string" ? root.markdown.slice(0, 25000) : "",
      html: typeof root?.html === "string" ? root.html.slice(0, 80000) : "",
      httpStatus: upstreamStatus,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = /abort|timeout/i.test(msg);
    return { ok: false, error: msg, errorKind: isTimeout ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}
import { getApifyToken } from "../_shared/apify.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BATCH = 60;            // URLs per invocation
const CONC = 6;              // parallel Firecrawl calls
const FIRECRAWL_COST_PER_SCRAPE = 0.002; // $/scrape (stima)
const APIFY_COST_PER_FALLBACK = 0.0025;

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SB_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const INTERNAL_TOKEN = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "internal";
const FN_URL = `${SB_URL}/functions/v1/padova-firecrawl-detail-collect`;

function sb() {
  return createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
}

function applyRemainingQueueFilter<T extends { eq: Function; not: Function; lt: Function; or: Function }>(q: T): T {
  return q
    .eq("job_id", SOURCE_JOB_ID)
    .not("url", "is", null)
    .lt("attempts", 2)
    .or(remainingQueueOrFilter()) as T;
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
  parseStatus: ParseStatus;
  httpStatus?: number;
  error?: string;
}> {
  let md = "";
  let html = "";
  let apifyUsed = false;
  let httpStatus: number | undefined;
  let lastError: string | undefined;
  let firecrawlErrorKind: string | undefined;

  const fc = await fcScrape(row.url, { formats: ["markdown", "html"], timeoutMs: 30_000 });
  httpStatus = fc.httpStatus;
  if (fc.ok && (fc.markdown || fc.html)) {
    md = fc.markdown ?? "";
    html = fc.html ?? "";
  } else {
    lastError = fc.error;
    firecrawlErrorKind = fc.errorKind;
    // Try apify fallback only for non-404 errors
    if (!(httpStatus && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429 && httpStatus !== 403)) {
      const af = await apifyDetailFallback(row.url);
      if (af) {
        md = af.md;
        html = af.html;
        apifyUsed = true;
      }
    }
  }

  if (!md && !html) {
    // classify failure
    let parseStatus: ParseStatus;
    if (httpStatus && httpStatus >= 400 && httpStatus < 600 && httpStatus !== 429 && httpStatus !== 403) {
      parseStatus = "dead_404";
    } else if (httpStatus === 403 || httpStatus === 429) {
      parseStatus = "anti_bot";
    } else if (firecrawlErrorKind === "timeout") {
      parseStatus = "timeout";
    } else {
      parseStatus = "network_error";
    }
    return { ok: false, apifyUsed, fields: {}, parseStatus, httpStatus, error: lastError };
  }

  const fields = extractFromContent(md, html);
  // Detect 404 pages that returned 200 with "page not found" content
  if (fields._gone) {
    fields.raw_json = { md: md.slice(0, 2000), html: html.slice(0, 4000), parse_status: "dead_404", http_status: httpStatus, processed_at: new Date().toISOString() };
    return { ok: false, apifyUsed, fields, parseStatus: "dead_404", httpStatus };
  }
  // Detect anti-bot pages (cloudflare/captcha shells)
  const lowText = (md + " " + html).toLowerCase();
  if (!fields.mq && /captcha|access denied|cloudflare|just a moment|enable javascript and cookies/.test(lowText) && html.length < 5000) {
    fields.raw_json = { md: md.slice(0, 2000), html: html.slice(0, 4000), parse_status: "anti_bot", http_status: httpStatus, processed_at: new Date().toISOString() };
    return { ok: false, apifyUsed, fields, parseStatus: "anti_bot", httpStatus };
  }

  const parseStatus: ParseStatus = fields.mq ? "done_ok" : "empty_parse";
  fields.raw_json = {
    md: md.slice(0, 20000),
    html: html.slice(0, 60000),
    parse_status: parseStatus,
    http_status: httpStatus,
    processed_at: new Date().toISOString(),
    via: apifyUsed ? "apify_fallback" : "firecrawl",
  };
  return { ok: parseStatus === "done_ok", apifyUsed, fields, parseStatus, httpStatus };
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

type BatchOutcomes = {
  done_ok: number;
  dead_404: number;
  timeout: number;
  anti_bot: number;
  empty_parse: number;
  network_error: number;
  error: number;
};

async function processBatch(
  jobId: string,
  batchSize = BATCH,
): Promise<{ remaining: number; processed: number; outcomes: BatchOutcomes; latlng: number }> {
  const c = sb();

  // Atomic claim with FOR UPDATE SKIP LOCKED + attempts++ to avoid double-processing
  // across parallel cron invocations.
  const { data: claimed } = await c.rpc("claim_padova_detail_batch", { p_size: batchSize });
  const rows = (claimed ?? []) as { id: number; url: string; attempts: number }[];

  const empty: BatchOutcomes = { done_ok: 0, dead_404: 0, timeout: 0, anti_bot: 0, empty_parse: 0, network_error: 0, error: 0 };

  if (!rows || rows.length === 0) {
    await c
      .from("padova_firecrawl_jobs")
      .update({ status: "done", finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("job_id", jobId);
    return { remaining: 0, processed: 0, outcomes: empty, latlng: 0 };
  }


  const results = await pMap(rows as { id: number; url: string; attempts: number }[], CONC, processOne);

  let ok = 0,
    fail = 0,
    apifyUsed = 0;
  const cov = { mq: 0, locali: 0, piano: 0, bagni: 0, civico: 0, agency: 0, agency_phone: 0, tipologia: 0, latlng: 0 };
  const outcomes: BatchOutcomes = { ...empty };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as { id: number; url: string; attempts: number };
    const res = results[i];
    const nextAttempts = r.attempts ?? 1; // already incremented by claim_padova_detail_batch
    outcomes[res.parseStatus] = (outcomes[res.parseStatus] ?? 0) + 1;
    const persistedStatus = storedStatus(res.parseStatus, nextAttempts);
    if (persistedStatus === "error" || persistedStatus === "dead_unrecoverable") outcomes.error++;
    const f = res.fields;
    const nowIso = new Date().toISOString();
    const raw_json = {
      ...(typeof f.raw_json === "object" && f.raw_json ? f.raw_json as Record<string, unknown> : {}),
      parse_status: persistedStatus,
      detected_status: res.parseStatus,
      http_status: res.httpStatus ?? null,
      log_reason: logReason(res.parseStatus, res.error),
      processed_at: nowIso,
      attempts: nextAttempts,
    };

    const { data: ckRow } = await c.rpc("compute_cluster_key", {
      p_via: null,
      p_civico: (f.civico as string | undefined) ?? null,
      p_mq: (f.mq as number | undefined) ?? null,
      p_locali: (f.locali as number | undefined) ?? null,
    });
    const cluster_key = typeof ckRow === "string" ? ckRow : null;

    if (!res.ok) {
      fail++;
      await c
        .from("padova_collect_v2_items")
        .update({
          mq: f.mq ?? null,
          locali: f.locali ?? null,
          piano: f.piano ?? null,
          bagni: f.bagni ?? null,
          agency: f.agency ?? null,
          agency_phone: (f.agency_phone as string | null) ?? null,
          civico: f.civico ?? null,
          tipologia: f.tipologia ?? null,
          riscaldamento: f.riscaldamento ?? null,
          stato: f.stato ?? null,
          anno_costruzione: f.anno_costruzione ?? null,
          lat: f.lat ?? null,
          lng: f.lng ?? null,
          raw_json,
          cluster_key,
          parse_status: persistedStatus,
          http_status: res.httpStatus ?? null,
          log_reason: logReason(res.parseStatus, res.error),
          processed_at: nowIso,
          attempts: nextAttempts,
        })
        .eq("id", r.id);
      continue;
    }
    ok++;
    if (res.apifyUsed) apifyUsed++;
    if (f.mq) cov.mq++;
    if (f.locali) cov.locali++;
    if (f.piano) cov.piano++;
    if (f.bagni) cov.bagni++;
    if (f.civico) cov.civico++;
    if (f.agency) cov.agency++;
    if (f.agency_phone) cov.agency_phone++;
    if (f.tipologia) cov.tipologia++;
    if (f.lat && f.lng) cov.latlng++;

    await c
      .from("padova_collect_v2_items")
      .update({
        mq: f.mq ?? null,
        locali: f.locali ?? null,
        piano: f.piano ?? null,
        bagni: f.bagni ?? null,
        agency: f.agency ?? null,
        agency_phone: (f.agency_phone as string | null) ?? null,
        civico: f.civico ?? null,
        tipologia: f.tipologia ?? null,
        riscaldamento: f.riscaldamento ?? null,
        stato: f.stato ?? null,
        anno_costruzione: f.anno_costruzione ?? null,
        lat: f.lat ?? null,
        lng: f.lng ?? null,
        raw_json,
        cluster_key,
        parse_status: persistedStatus,
        http_status: res.httpStatus ?? null,
        log_reason: null,
        processed_at: nowIso,
        attempts: nextAttempts,
      })
      .eq("id", r.id);
  }

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

  const { count: remainingCount } = await applyRemainingQueueFilter(
    c.from("padova_collect_v2_items").select("id", { count: "exact", head: true }),
  );

  return { remaining: remainingCount ?? 0, processed: rows.length, outcomes, latlng: cov.latlng };
}

async function selfInvoke(jobId: string, action: "process" | "run_full" = "process") {
  const gatewayKey = SB_ANON_KEY || SB_KEY;
  try {
    const body = action === "run_full"
      ? { action: "run_full", job_id: jobId, _chain: true, _internal_token: INTERNAL_TOKEN }
      : { action: "process", job_id: jobId, _internal_token: INTERNAL_TOKEN };
    const res = await fetch(FN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${gatewayKey}`,
        "apikey": gatewayKey,
        "x-internal-secret": INTERNAL_TOKEN,
        "x-job-secret": INTERNAL_TOKEN,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) console.warn("selfInvoke non-ok:", res.status, text.slice(0, 300));
  } catch (e) {
    console.warn("selfInvoke error:", String(e));
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ───────────────────────── handler ──────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const expectedSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!expectedSecret) return missingJobSecretConfigResponse(corsHeaders);
  const incoming = readIncomingJobSecret(req.headers);
  const bodyPeek = await req.json().catch(() => ({}));
  const internalToken = String((bodyPeek as { _internal_token?: string })?._internal_token ?? "");
  const internalOk = Boolean(INTERNAL_TOKEN && internalToken && jobSecretAuthorized(INTERNAL_TOKEN, internalToken));
  if (!jobSecretAuthorized(expectedSecret, incoming) && !internalOk) {
    return unauthorizedJobResponse(corsHeaders);
  }

  const body = bodyPeek as Record<string, unknown>;
  const action = String(body?.action ?? "");
  const c = sb();
  // Expire jobs whose updated_at heartbeat is older than the watchdog timeout
  // so a stuck "running" row cannot block the next scheduled collect forever.
  await expireStaleScrapeJobs(c);

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
    const jobId = String(body?.job_id ?? DEFAULT_COLLECT_JOB_ID);

    // DB-grounded counters (source of truth)
    const countWhere = async (
      build: (q: ReturnType<typeof c.from> extends infer T ? T : never) => unknown,
    ): Promise<number> => {
      // helper unused — we inline below for typing simplicity
      return 0;
    };
    void countWhere;

    const baseFilter = () =>
      c.from("padova_collect_v2_items").select("id", { count: "exact", head: true })
        .eq("job_id", SOURCE_JOB_ID).not("url", "is", null);

    const [totRes, notYetRes, processedRes, doneOkRes, dead404Res, emptyRes, errorRes, failedUnkRes, deadUnrecRes, codaRes] = await Promise.all([
      baseFilter(),
      baseFilter().is("processed_at", null),
      baseFilter().not("processed_at", "is", null),
      baseFilter().eq("parse_status", "done_ok"),
      baseFilter().eq("parse_status", "dead_404"),
      baseFilter().eq("parse_status", "empty_parse"),
      baseFilter().eq("parse_status", "error"),
      baseFilter().eq("parse_status", "failed_processed_unknown"),
      baseFilter().eq("parse_status", "dead_unrecoverable"),
      baseFilter().lt("attempts", 2).or("processed_at.is.null,parse_status.in.(failed_processed_unknown,error)"),
    ]);

    const job = await c.from("padova_firecrawl_jobs").select("*").eq("job_id", jobId).maybeSingle();
    const jobData = job.data;

    return new Response(JSON.stringify({
      ok: true,
      job_id: jobId,
      totale: totRes.count ?? 0,
      coda_rimasta: codaRes.count ?? 0,
      not_yet: notYetRes.count ?? 0,
      processed_at_pieni: processedRes.count ?? 0,
      done_ok: doneOkRes.count ?? 0,
      dead_404: dead404Res.count ?? 0,
      dead_unrecoverable: deadUnrecRes.count ?? 0,
      empty_parse: emptyRes.count ?? 0,
      error: errorRes.count ?? 0,
      failed_processed_unknown_residui: failedUnkRes.count ?? 0,
      stato: jobData?.status ?? "unknown",
      spesa_firecrawl_usd: Number(jobData?.spesa_firecrawl_usd ?? 0),
      spesa_apify_usd: Number(jobData?.spesa_apify_usd ?? 0),
      updated_at: jobData?.updated_at ?? null,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  if (action === "run_one_batch") {
    const jobId = String(body?.job_id ?? DEFAULT_COLLECT_JOB_ID);

    const { data: existing } = await c.from("padova_firecrawl_jobs").select("*").eq("job_id", jobId).maybeSingle();
    if (!existing) {
      await c.from("padova_firecrawl_jobs").insert({
        job_id: jobId,
        status: "running",
        source_job_id: SOURCE_JOB_ID,
        annunci_totali: 0,
      });
    } else if (existing.status !== "running") {
      await c.from("padova_firecrawl_jobs")
        .update({ status: "running", updated_at: new Date().toISOString() })
        .eq("job_id", jobId);
    }

    let result: { remaining: number; processed: number; outcomes: BatchOutcomes; latlng: number };
    try {
      result = await processBatch(jobId, 8);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await c.from("padova_firecrawl_jobs")
        .update({ status: "running", last_error: msg.slice(0, 500), updated_at: new Date().toISOString() })
        .eq("job_id", jobId);
      return new Response(JSON.stringify({ ok: false, processate: 0, rimaste: null, error: msg.slice(0, 500) }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let cronAutoSpento = false;
    if (result.remaining === 0) {
      const { data: unscheduled } = await c.rpc("unschedule_padova_detail_chain");
      cronAutoSpento = Boolean(unscheduled);
      await c.from("padova_firecrawl_jobs")
        .update({ status: "done", finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("job_id", jobId);
    }

    return new Response(JSON.stringify({
      ok: true,
      job_id: jobId,
      processate: result.processed,
      rimaste: result.remaining,
      esiti_batch: result.outcomes,
      lat_lng_recuperati_nel_batch: result.latlng,
      cron_auto_spento: cronAutoSpento,
      stato: result.remaining === 0 ? "done" : "running",
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // ── run_full: process one 40-row batch sync, then self-chain via SUPABASE_ANON_KEY ──
  if (action === "run_full") {
    const jobId = String(body?.job_id ?? DEFAULT_COLLECT_JOB_ID);
    const BATCH_SIZE = Math.min(Math.max(Number(body?.batch_size ?? 40), 5), 80);
    const resetFailedUnknown = body?.reset_failed_unknown === true;
    const isChain = body?._chain === true;

    // STEP 0: reset failed_processed_unknown rows (only on first non-chain call)
    let resetCount = 0;
    if (resetFailedUnknown && !isChain) {
      const { data: toReset } = await c
        .from("padova_collect_v2_items")
        .select("id, raw_json")
        .eq("job_id", SOURCE_JOB_ID)
        .is("mq", null)
        .not("raw_json", "is", null)
        .limit(10000);
      const ids: number[] = [];
      for (const r of (toReset ?? []) as Array<{ id: number; raw_json: Record<string, unknown> }>) {
        const rj = r.raw_json ?? {};
        const ps = String(rj.parse_status ?? "");
        const keep = ["done_ok", "dead_404", "empty_parse", "anti_bot", "gone_404", "empty", "empty_after_apify"];
        if (!keep.includes(ps)) ids.push(r.id);
      }
      for (let i = 0; i < ids.length; i += 500) {
        await c.from("padova_collect_v2_items").update({ raw_json: null }).in("id", ids.slice(i, i + 500));
      }
      resetCount = ids.length;
    }

    // Ensure job row exists & running
    const { data: existing } = await c.from("padova_firecrawl_jobs").select("*").eq("job_id", jobId).maybeSingle();
    if (!existing) {
      await c.from("padova_firecrawl_jobs").insert({
        job_id: jobId, status: "running", source_job_id: SOURCE_JOB_ID, annunci_totali: 0,
      });
    } else if (existing.status !== "running") {
      await c.from("padova_firecrawl_jobs")
        .update({ status: "running", updated_at: new Date().toISOString() })
        .eq("job_id", jobId);
    }

    // Count remaining BEFORE processing
    const { count: beforeCount } = await applyRemainingQueueFilter(
      c.from("padova_collect_v2_items").select("id", { count: "exact", head: true }),
    );
    const daProcessareTotale = beforeCount ?? 0;
    console.log(`[run_full] job=${jobId} chain=${isChain} da_processare_totale=${daProcessareTotale} reset=${resetCount}`);

    // Process ONE batch synchronously
    let processed = 0;
    const outcomes: BatchOutcomes = { done_ok: 0, dead_404: 0, timeout: 0, anti_bot: 0, empty_parse: 0, network_error: 0, error: 0 };
    let writeError: string | null = null;
    try {
      const r = await processBatch(jobId, BATCH_SIZE);
      processed = r.processed;
      for (const k of Object.keys(outcomes) as (keyof BatchOutcomes)[]) outcomes[k] += r.outcomes[k] ?? 0;
    } catch (e) {
      writeError = e instanceof Error ? e.message : String(e);
      await c.from("padova_firecrawl_jobs")
        .update({ last_error: writeError.slice(0, 500), updated_at: new Date().toISOString() })
        .eq("job_id", jobId);
    }

    // Count remaining AFTER
    const { count: afterCount } = await applyRemainingQueueFilter(
      c.from("padova_collect_v2_items").select("id", { count: "exact", head: true }),
    );
    const rimanenti = afterCount ?? 0;

    let chaining = false;
    if (shouldContinueChaining(processed, rimanenti, writeError)) {
      await sleep(800);
      // @ts-ignore EdgeRuntime
      EdgeRuntime.waitUntil(selfInvoke(jobId, "run_full"));
      chaining = true;
    } else if (rimanenti === 0) {
      await c.from("padova_firecrawl_jobs")
        .update({ status: "done", finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("job_id", jobId);
    }

    return new Response(JSON.stringify({
      ok: !writeError,
      job_id: jobId,
      da_processare_totale: daProcessareTotale,
      batch_size: BATCH_SIZE,
      batch_processato_ora: processed,
      esiti_batch: outcomes,
      rimanenti: rimanenti,
      failed_unknown_rimessi_in_coda: resetCount,
      chaining: chaining ? "avviato" : (rimanenti === 0 ? "completato" : "fermo"),
      stato: rimanenti === 0 ? "done" : "running",
      error: writeError,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

  if (action === "run_batch") {
    const jobId = String(body?.job_id ?? "");
    const n = Math.min(Math.max(Number(body?.n ?? 400), 10), 1500);
    const SPEND_CAP_USD = Number(body?.spend_cap_usd ?? 1000); // crediti abbondanti, no cap stretto
    const resetFailedUnknown = body?.reset_failed_unknown === true;
    if (!jobId) {
      return new Response(JSON.stringify({ ok: false, error: "job_id_required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // STEP 0: reset failed_processed_unknown rows so they get retried.
    // These are rows with raw_json.error == 'scrape_failed' but NO explicit parse_status
    // (dead_404, anti_bot, timeout). Confirmed dead_404 / anti_bot / etc. stay marked.
    let resetCount = 0;
    if (resetFailedUnknown) {
      const { data: toReset } = await c
        .from("padova_collect_v2_items")
        .select("id, raw_json")
        .eq("job_id", SOURCE_JOB_ID)
        .is("mq", null)
        .not("raw_json", "is", null)
        .limit(5000);
      const idsToReset: number[] = [];
      for (const r of (toReset ?? []) as Array<{ id: number; raw_json: Record<string, unknown> }>) {
        const rj = r.raw_json ?? {};
        const ps = String(rj.parse_status ?? "");
        // Reset if it's a generic scrape_failed with no specific classification.
        // Keep: dead_404, anti_bot, gone_404, empty (already parsed)
        if (rj.error === "scrape_failed" && !["dead_404", "anti_bot", "gone_404", "empty", "empty_after_apify"].includes(ps)) {
          idsToReset.push(r.id);
        }
      }
      // chunked update
      for (let i = 0; i < idsToReset.length; i += 500) {
        const chunk = idsToReset.slice(i, i + 500);
        await c.from("padova_collect_v2_items").update({ raw_json: null }).in("id", chunk);
      }
      resetCount = idsToReset.length;
    }

    const { data: pre } = await c.from("padova_firecrawl_jobs").select("*").eq("job_id", jobId).maybeSingle();
    const spent = Number(pre?.spesa_firecrawl_usd ?? 0);
    if (spent >= SPEND_CAP_USD) {
      await c.from("padova_firecrawl_jobs")
        .update({ status: "stopped_spend_cap", last_error: `spend_cap_reached_${spent}`, updated_at: new Date().toISOString() })
        .eq("job_id", jobId);
      return new Response(JSON.stringify({ ok: false, skipped: "spend_cap", spesa_firecrawl_usd: spent, cap: SPEND_CAP_USD }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    await c.from("padova_firecrawl_jobs")
      .update({ status: "running", updated_at: new Date().toISOString() })
      .eq("job_id", jobId);

    // Run mini-batches SYNCHRONOUSLY (so we can return per-reason outcomes)
    const totals: BatchOutcomes = { done_ok: 0, dead_404: 0, timeout: 0, anti_bot: 0, empty_parse: 0, network_error: 0, error: 0 };
    let totalProcessed = 0;
    let totalLatLng = 0;
    const deadline = Date.now() + 300_000; // 5 min hard deadline
    while (totalProcessed < n && Date.now() < deadline) {
      try {
        const r = await processBatch(jobId, Math.min(60, n - totalProcessed));
        totalProcessed += r.processed;
        totalLatLng += r.latlng;
        for (const k of Object.keys(totals) as (keyof BatchOutcomes)[]) {
          totals[k] += r.outcomes[k] ?? 0;
        }
        if (r.processed === 0) break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await c.from("padova_firecrawl_jobs")
          .update({ last_error: msg.slice(0, 500), updated_at: new Date().toISOString() })
          .eq("job_id", jobId);
        break;
      }
    }

    const { count: leftCount } = await applyRemainingQueueFilter(
      c.from("padova_collect_v2_items").select("id", { count: "exact", head: true }),
    );

    const { data: cur } = await c.from("padova_firecrawl_jobs").select("*").eq("job_id", jobId).maybeSingle();
    const p = cur?.annunci_processati || 1;
    const stato = (leftCount ?? 0) === 0 ? "done" : "running";
    if (stato === "done") {
      await c.from("padova_firecrawl_jobs")
        .update({ status: "done", finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("job_id", jobId);
    }

    const latLngPct = totalProcessed > 0 ? Math.round((totalLatLng / totalProcessed) * 100) : 0;

    return new Response(JSON.stringify({
      ok: true,
      failed_unknown_rimessi_da_fare: resetCount,
      batch_processati_ora: totalProcessed,
      esiti_batch: totals,
      lat_lng_recuperati_nel_batch_pct: latLngPct,
      rimanenti_da_fare: leftCount ?? 0,
      done_ok_totali: cur?.annunci_ok ?? 0,
      annunci_processati_totali: cur?.annunci_processati ?? 0,
      annunci_fail: cur?.annunci_fail ?? 0,
      spesa_firecrawl_usd_totale: Number(cur?.spesa_firecrawl_usd ?? 0),
      spesa_apify_usd_totale: Number(cur?.spesa_apify_usd ?? 0),
      fallback_apify_usati: cur?.fallback_apify_usati ?? 0,
      copertura_campi_percentuale: cur ? {
        mq: Math.round((cur.cov_mq / p) * 100),
        locali: Math.round((cur.cov_locali / p) * 100),
        piano: Math.round((cur.cov_piano / p) * 100),
        bagni: Math.round((cur.cov_bagni / p) * 100),
        civico: Math.round((cur.cov_civico / p) * 100),
        agency: Math.round((cur.cov_agency / p) * 100),
        tipologia: Math.round((cur.cov_tipologia / p) * 100),
        lat_lng: Math.round((cur.cov_latlng / p) * 100),
      } : {},
      stato,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }


  // ── reextract_empty: re-parse rows with raw_json present but mq=null (free, no scraping) ──
  if (action === "reextract_empty") {
    const portal = String(body?.portal ?? "immobiliare");
    const urlFilter = portal === "immobiliare" ? "%immobiliare%"
                    : portal === "idealista" ? "%idealista%"
                    : portal === "casa" ? "%casa.it%"
                    : portal === "subito" ? "%subito%" : "%";
    const { data: rows } = await c
      .from("padova_collect_v2_items")
      .select("id, url, raw_json")
      .eq("job_id", SOURCE_JOB_ID)
      .is("mq", null)
      .not("raw_json", "is", null)
      .ilike("url", urlFilter)
      .limit(500);

    let recovered = 0, gone = 0, still_empty = 0;
    for (const r of (rows ?? []) as Array<{ id: number; url: string; raw_json: { md?: string; html?: string; error?: string } }>) {
      const md = r.raw_json?.md ?? "";
      const html = r.raw_json?.html ?? "";
      if (!md && !html) { still_empty++; continue; }
      const f = extractFromContent(md, html);
      if (f._gone) {
        gone++;
        await c.from("padova_collect_v2_items")
          .update({ raw_json: { ...r.raw_json, parse_status: "gone_404" } })
          .eq("id", r.id);
        continue;
      }
      if (f.mq) {
        recovered++;
        const { data: ck } = await c.rpc("compute_cluster_key", {
          p_via: null, p_civico: (f.civico as string) ?? null,
          p_mq: (f.mq as number) ?? null, p_locali: (f.locali as number) ?? null,
        });
        await c.from("padova_collect_v2_items").update({
          mq: f.mq ?? null, locali: f.locali ?? null, piano: f.piano ?? null,
          bagni: f.bagni ?? null, agency: f.agency ?? null, agency_phone: (f.agency_phone as string | null) ?? null, civico: f.civico ?? null,
          tipologia: f.tipologia ?? null, riscaldamento: f.riscaldamento ?? null,
          stato: f.stato ?? null, anno_costruzione: f.anno_costruzione ?? null,
          lat: f.lat ?? null, lng: f.lng ?? null,
          cluster_key: typeof ck === "string" ? ck : null,
        }).eq("id", r.id);
      } else {
        still_empty++;
        await c.from("padova_collect_v2_items")
          .update({ raw_json: { ...r.raw_json, parse_status: "empty" } })
          .eq("id", r.id);
      }
    }
    return new Response(JSON.stringify({
      ok: true, portal, scanned: rows?.length ?? 0, recovered, gone_404: gone, still_empty,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // ── retry_idealista_apify: retry hard_fail idealista rows via Apify fallback ──
  if (action === "retry_idealista_apify") {
    const { data: rows } = await c
      .from("padova_collect_v2_items")
      .select("id, url, raw_json")
      .eq("job_id", SOURCE_JOB_ID)
      .is("mq", null)
      .not("raw_json", "is", null)
      .ilike("url", "%idealista%")
      .limit(50);

    const targets = (rows ?? []).filter((r: { raw_json: { error?: string } }) => r.raw_json?.error);
    let recovered = 0, apify_attempted = 0, apify_spent = 0;

    for (const r of targets as Array<{ id: number; url: string; raw_json: Record<string, unknown> }>) {
      const budget = await canSpendApify(APIFY_COST_PER_FALLBACK);
      if (!budget.ok) break;
      apify_attempted++;
      const af = await apifyDetailFallback(r.url);
      apify_spent += APIFY_COST_PER_FALLBACK;
      if (!af) {
        await c.from("padova_collect_v2_items")
          .update({ raw_json: { ...r.raw_json, apify_retry: "failed", at: new Date().toISOString() } })
          .eq("id", r.id);
        continue;
      }
      const f = extractFromContent(af.md, af.html);
      const raw_json = { md: af.md.slice(0, 6000), html: af.html.slice(0, 12000), via: "apify_retry" };
      if (f.mq) {
        recovered++;
        const { data: ck } = await c.rpc("compute_cluster_key", {
          p_via: null, p_civico: (f.civico as string) ?? null,
          p_mq: (f.mq as number) ?? null, p_locali: (f.locali as number) ?? null,
        });
        await c.from("padova_collect_v2_items").update({
          mq: f.mq ?? null, locali: f.locali ?? null, piano: f.piano ?? null,
          bagni: f.bagni ?? null, agency: f.agency ?? null, agency_phone: (f.agency_phone as string | null) ?? null, civico: f.civico ?? null,
          tipologia: f.tipologia ?? null, riscaldamento: f.riscaldamento ?? null,
          stato: f.stato ?? null, anno_costruzione: f.anno_costruzione ?? null,
          lat: f.lat ?? null, lng: f.lng ?? null, raw_json,
          cluster_key: typeof ck === "string" ? ck : null,
        }).eq("id", r.id);
      } else {
        await c.from("padova_collect_v2_items")
          .update({ raw_json: { ...raw_json, parse_status: "empty_after_apify" } })
          .eq("id", r.id);
      }
    }
    return new Response(JSON.stringify({
      ok: true,
      idealista_hard_fail_totali: targets.length,
      apify_tentati: apify_attempted,
      recuperati: recovered,
      spesa_apify_usd: Number(apify_spent.toFixed(4)),
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  if (action === "reextract_agency") {
    const sbc = sb();
    const requestedLimit = Number(body?.limit ?? 20);
    const limit = Math.max(1, Math.min(100, Number.isFinite(requestedLimit) ? requestedLimit : 20));
    const dryRun = body?.dry_run === true;

    const { data: rows, error: selErr } = await sbc
      .from("padova_collect_v2_items")
      .select("id, url, agency, agency_phone, raw_json")
      .eq("contendibile", true)
      .ilike("url",
        body?.portal_filter === "casa" ? "%casa.it%" :
        body?.portal_filter === "idealista" ? "%idealista%" :
        body?.portal_filter === "subito" ? "%subito%" :
        "%immobiliare%"
      )
      .not("raw_json", "is", null)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (selErr) {
      return new Response(JSON.stringify({ ok: false, error: "DB_ERROR", message: selErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: Array<{
      id: number; url: string | null;
      agency_before: string | null; agency_after: string | null;
      phone_before: string | null; phone_after: string | null;
      updated: boolean; skipped_reason?: string;
    }> = [];
    let updatedCount = 0, unchangedCount = 0, skippedNoContent = 0;

    for (const row of (rows ?? []) as Array<{ id: number; url: string | null; agency: string | null; agency_phone: string | null; raw_json: Record<string, unknown> | null }>) {
      const raw = row.raw_json;
      const md = (raw?.md as string) ?? (raw?.markdown as string) ?? (raw?.content as string) ?? "";
      const html = (raw?.html as string) ?? (raw?.rawHtml as string) ?? "";

      if (!md && !html) {
        skippedNoContent++;
        results.push({
          id: row.id, url: row.url,
          agency_before: row.agency, agency_after: row.agency,
          phone_before: row.agency_phone, phone_after: row.agency_phone,
          updated: false, skipped_reason: "no_markdown_no_html_in_raw_json",
        });
        continue;
      }

      const extracted = extractFromContent(md, html);
      const newAgency = (extracted.agency as string | null | undefined) ?? null;
      const newPhone = (extracted.agency_phone as string | null | undefined) ?? null;

      const finalAgency = newAgency ?? row.agency;
      const finalPhone = newPhone ?? row.agency_phone;
      const changed = finalAgency !== row.agency || finalPhone !== row.agency_phone;

      if (changed && !dryRun) {
        const { error: updErr } = await sbc
          .from("padova_collect_v2_items")
          .update({ agency: finalAgency, agency_phone: finalPhone })
          .eq("id", row.id);
        if (updErr) {
          results.push({
            id: row.id, url: row.url,
            agency_before: row.agency, agency_after: row.agency,
            phone_before: row.agency_phone, phone_after: row.agency_phone,
            updated: false, skipped_reason: `update_error: ${updErr.message}`,
          });
          continue;
        }
        updatedCount++;
      } else if (!changed) {
        unchangedCount++;
      }

      results.push({
        id: row.id, url: row.url,
        agency_before: row.agency, agency_after: finalAgency,
        phone_before: row.agency_phone, phone_after: finalPhone,
        updated: changed && !dryRun,
      });
    }

    return new Response(JSON.stringify({
      ok: true, action: "reextract_agency", dry_run: dryRun,
      scanned: rows?.length ?? 0,
      updated: updatedCount, unchanged: unchangedCount, skipped_no_content: skippedNoContent,
      results,
    }, null, 2), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  if (action === "recrawl_ids") {
    const sbc = sb();
    const idsRaw = Array.isArray(body?.ids) ? body.ids : [];
    const ids = idsRaw
      .map((x: unknown) => Number(x))
      .filter((n: number) => Number.isInteger(n) && n > 0);
    if (ids.length === 0 || ids.length > 10) {
      return new Response(JSON.stringify({
        ok: false, error: "INVALID_IDS",
        message: "ids must be a non-empty array of integers, max 10",
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: rows, error: selErr } = await sbc
      .from("padova_collect_v2_items")
      .select("id, url, contendibile")
      .in("id", ids)
      .eq("contendibile", true)
      .not("url", "is", null);

    if (selErr) {
      return new Response(JSON.stringify({ ok: false, error: "DB_ERROR", message: selErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: Array<{ id: number; url: string | null; ok: boolean; md_len_new?: number; html_len_new?: number; error?: string }> = [];

    for (const row of (rows ?? []) as Array<{ id: number; url: string; contendibile: boolean }>) {
      try {
        const fc = await fcScrape(row.url, { timeoutMs: 30_000, formats: ["markdown", "html"] });
        if (!fc.ok) {
          results.push({ id: row.id, url: row.url, ok: false, error: fc.error ?? "scrape_failed" });
          continue;
        }
        const md = fc.markdown ?? "";
        const html = fc.html ?? "";
        const newRaw = {
          md: md.slice(0, 20000),
          html: html.slice(0, 60000),
          recrawled_at: new Date().toISOString(),
          via: "recrawl_ids",
        };
        const { error: updErr } = await sbc
          .from("padova_collect_v2_items")
          .update({ raw_json: newRaw })
          .eq("id", row.id);
        if (updErr) {
          results.push({ id: row.id, url: row.url, ok: false, error: `update_error: ${updErr.message}` });
          continue;
        }
        results.push({
          id: row.id, url: row.url, ok: true,
          md_len_new: newRaw.md.length,
          html_len_new: newRaw.html.length,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ id: row.id, url: row.url, ok: false, error: msg });
      }
    }

    const notFound = ids.filter((id) => !(rows ?? []).some((r: { id: number }) => r.id === id));
    return new Response(JSON.stringify({
      ok: true, action: "recrawl_ids",
      requested: ids.length, processed: results.length, not_found_or_not_contendibile: notFound,
      results,
    }, null, 2), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({ ok: false, error: "unknown_action" }), {
    status: 400,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
