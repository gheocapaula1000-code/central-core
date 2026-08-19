// scraping-result-processor
// Livello separato per processare i "result" dei job scraping già riusciti,
// senza ripetere chiamate a pagamento verso Firecrawl / Perplexity / Apify.
//
// Backend-only: nessun CORS, nessun OPTIONS. Solo POST autenticato via
// header x-worker-token confrontato in tempo costante.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  ALLOWED_PORTALS,
  parseFirecrawlResult,
  type PortalProcessorContext,
  type PortalSource,
} from "../_shared/queue-processors/padovaPortalParser.ts";
import {
  buildPageGroupKey,
  buildPageIdempotencyKey,
  buildPortalPageUrl,
  getAbsoluteMaxPages,
  validatePageNumber,
  type Mode as PageMode,
  type Portal as PagePortal,
} from "../_shared/queue-processors/padovaPortalPages.ts";
import {
  parseContendibileDetail,
} from "../_shared/queue-processors/civikoContendibileDetail.ts";
import {
  APIFY_DATASET_PROCESSOR,
  PROCESSOR_DRAIN_WALL_MS,
  processorClaimLimit,
  shouldClaimAnotherWave,
} from "../_shared/scrapingLocks.ts";


const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WORKER_TOKEN = Deno.env.get("SCRAPING_WORKER_TOKEN") ?? "";

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

class ProcessorError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
    readonly code = "processor_error",
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type Job = {
  id: string;
  provider: string;
  operation: string;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  result_ref: string | null;
  processor: string;
  processor_context: Record<string, unknown> | null;
  processing_attempt: number;
  processing_max_attempts: number;
};

// -------- Classificazione errori RPC --------
// Retryable SOLO per errori temporanei; validazione/lease/context = non retryable.
const RETRYABLE_SQLSTATES = new Set<string>([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available
  "57014", // query_canceled
  "57P01", // admin_shutdown
]);
const RETRYABLE_CLASS_PREFIXES = ["08", "53", "58"]; // connection, resources, system

function classifyRpcError(code: string | null | undefined): boolean {
  const c = (code ?? "").toUpperCase();
  if (!c) return true; // sconosciuto → prudente retry
  if (RETRYABLE_SQLSTATES.has(c)) return true;
  if (RETRYABLE_CLASS_PREFIXES.some((pref) => c.startsWith(pref))) return true;
  // Non retryable esplicitamente: 22023 (context invalid), P0002 (not found), ecc.
  return false;
}

// -------- Processors registry --------
//
// NOTA VINCOLANTE: gli upsert applicativi devono essere in RPC atomiche.
// AbortSignal interrompe I/O ma non fa rollback di scritture già eseguite.

type ProcessorFn = (
  job: Job,
  signal: AbortSignal,
  workerId: string,
) => Promise<{ ok: true }>;

const PROCESSOR_TIMEOUT_MS: Record<string, number> = {
  queue_smoke_test: 5_000,
  padova_portal_collect_v2: 20_000,
  civiko_contendibile_detail_v1: 20_000,
  [APIFY_DATASET_PROCESSOR]: 45_000,
};


const PROCESSORS: Record<string, ProcessorFn> = {
  queue_smoke_test: async (job, signal, _workerId) => {
    if (signal.aborted) {
      throw new ProcessorError("processor_aborted", true, "processor_aborted");
    }
    if (!job.result || typeof job.result !== "object") {
      throw new ProcessorError("missing_result", false, "missing_result");
    }
    if (signal.aborted) {
      throw new ProcessorError("processor_aborted", true, "processor_aborted");
    }
    return { ok: true };
  },

  padova_portal_collect_v2: async (job, signal, workerId) => {
    if (signal.aborted) {
      throw new ProcessorError("processor_aborted", true, "processor_aborted");
    }
    if (job.provider !== "firecrawl") {
      throw new ProcessorError(`invalid_provider:${job.provider}`, false, "invalid_provider");
    }
    if (job.operation !== "scrape") {
      throw new ProcessorError(`invalid_operation:${job.operation}`, false, "invalid_operation");
    }
    const ctx = (job.processor_context ?? {}) as Record<string, unknown>;
    const municipality = String(ctx.municipality ?? "");
    const province = String(ctx.province ?? "");
    const portal = String(ctx.portal ?? "") as PortalSource;
    const mode = String(ctx.mode ?? "");
    if (municipality !== "Padova") throw new ProcessorError("invalid_municipality", false, "invalid_context");
    if (province !== "PD") throw new ProcessorError("invalid_province", false, "invalid_context");
    if (!ALLOWED_PORTALS.includes(portal)) throw new ProcessorError("invalid_portal", false, "invalid_context");
    if (mode !== "soft" && mode !== "full") throw new ProcessorError("invalid_mode", false, "invalid_context");
    if (!job.result || typeof job.result !== "object") {
      throw new ProcessorError("missing_result", false, "missing_result");
    }

    // ─── Contesto multipagina (Fase 1B) con retro-compat Fase 1A ───
    // Se page/max_pages/run_date sono assenti, degradare a page=1/max_pages=1
    // → nessun accodamento della pagina successiva.
    const RUN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const hasMulti = "page" in ctx || "max_pages" in ctx || "run_date" in ctx;
    let page = 1;
    let max_pages = 1;
    let run_date: string | null = null;
    let multipageEnabled = false;
    if (hasMulti) {
      const p = validatePageNumber(ctx.page);
      const mp = validatePageNumber(ctx.max_pages);
      const rd = typeof ctx.run_date === "string" ? ctx.run_date : "";
      const modeCap = getAbsoluteMaxPages(mode as PageMode);
      if (
        p === null || mp === null || !RUN_DATE_RE.test(rd) ||
        p > mp || mp > modeCap
      ) {
        throw new ProcessorError(
          "invalid_multipage_context",
          false,
          "invalid_context",
        );
      }
      page = p;
      max_pages = mp;
      run_date = rd;
      multipageEnabled = true;
    }

    if (signal.aborted) {
      throw new ProcessorError("processor_aborted", true, "processor_aborted");
    }

    const context: PortalProcessorContext = {
      municipality, province, portal, mode: mode as "soft" | "full",
      ...(multipageEnabled ? { page, max_pages, run_date: run_date! } : {}),
    };

    // Parser puro
    let listings;
    try {
      listings = parseFirecrawlResult(job.result, context);
    } catch (e) {
      throw new ProcessorError(
        `parser_error:${(e as Error).message}`.slice(0, 200),
        false,
        "parser_error",
      );
    }

    // Parse vuoto → non chiamare la RPC, non produrre falso verde.
    if (!listings || listings.length === 0) {
      throw new ProcessorError("empty_parse", false, "empty_parse");
    }

    if (signal.aborted) {
      throw new ProcessorError("processor_aborted", true, "processor_aborted");
    }

    // RPC atomica: .abortSignal(signal) permette l'interruzione HTTP reale.
    const { data, error } = await sb
      .rpc("process_padova_portal_collect_v2", {
        p_queue_id: job.id,
        p_worker_id: workerId,
        p_listings: listings,
      })
      .abortSignal(signal);

    if (error) {
      const isAbort =
        (error.message ?? "").toLowerCase().includes("abort") ||
        (error.name ?? "").toLowerCase() === "aborterror";
      const retryable = isAbort ? true : classifyRpcError(error.code);
      throw new ProcessorError(
        `rpc_error:${error.code ?? ""}:${(error.message ?? "").slice(0, 160)}`,
        retryable,
        isAbort ? "processor_aborted" : "rpc_error",
        { code: error.code },
      );
    }

    // Validazione rigorosa del riepilogo restituito dalla RPC.
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ProcessorError("invalid_rpc_summary", false, "invalid_rpc_summary");
    }
    const summary = data as Record<string, unknown>;
    const received = summary.received;
    const created = summary.created;
    const updated = summary.updated;
    const rejected = summary.rejected;
    const isNonNegInt = (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v) &&
      Number.isInteger(v) && v >= 0;
    if (
      !isNonNegInt(received) ||
      !isNonNegInt(created) ||
      !isNonNegInt(updated) ||
      !isNonNegInt(rejected) ||
      received !== listings.length ||
      created + updated + rejected !== received
    ) {
      throw new ProcessorError("invalid_rpc_summary", false, "invalid_rpc_summary");
    }
    if (created + updated === 0) {
      throw new ProcessorError(
        "all_listings_rejected", false, "all_listings_rejected",
        { received, rejected },
      );
    }

    // ─── Accodamento pagina successiva (Fase 1B) ───
    // Soltanto se:
    //  - contesto multipagina valido presente sul job corrente;
    //  - page < max_pages;
    //  - il parser ha prodotto almeno 10 annunci validi;
    //  - signal non è aborted.
    let next_page: number | null = null;
    let next_queue_id: string | null = null;
    if (
      multipageEnabled &&
      !signal.aborted &&
      page < max_pages &&
      listings.length >= 10
    ) {
      const nextP = page + 1;
      try {
        const nextPortal = portal as PagePortal;
        const nextMode = mode as PageMode;
        const nextUrl = buildPortalPageUrl(nextPortal, nextP);
        const urlBuf = await crypto.subtle.digest(
          "SHA-1",
          new TextEncoder().encode(nextUrl),
        );
        const urlHash16 = Array.from(new Uint8Array(urlBuf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
          .slice(0, 16);
        const nextIdem = buildPageIdempotencyKey({
          runDate: run_date!, portal: nextPortal, mode: nextMode,
          page: nextP, urlHash16,
        });
        const nextGroup = buildPageGroupKey(nextPortal);
        const basePriority = nextMode === "full" ? 700 : 500;
        const nextPriority = basePriority - (nextP - 1);
        const nextPayload = {
          url: nextUrl, formats: ["markdown"],
          onlyMainContent: false, waitFor: 3000,
        };
        const nextCtx = {
          municipality: "Padova", province: "PD",
          portal: nextPortal, mode: nextMode,
          page: nextP, max_pages, run_date,
        };

        const { data: enqData, error: enqErr } = await sb.rpc(
          "scraping_enqueue_processed",
          {
            p_provider: "firecrawl",
            p_operation: "scrape",
            p_payload: nextPayload,
            p_processor: "padova_portal_collect_v2",
            p_processor_context: nextCtx,
            p_idempotency_key: nextIdem,
            p_group_key: nextGroup,
            p_priority: nextPriority,
            p_max_attempts: 3,
            p_timeout_seconds: 45,
            p_processing_max_attempts: 5,
          },
        );
        if (enqErr) {
          // idempotency: se già presente la RPC risponde con id esistente,
          // quindi qui abbiamo un errore reale → retryable senza payload.
          throw new ProcessorError(
            `enqueue_next_page_failed:${enqErr.code ?? ""}`.slice(0, 200),
            true,
            "enqueue_next_page_failed",
            { next_page: nextP },
          );
        }
        const rawNextId =
          typeof enqData === "string"
            ? enqData
            : (enqData as { id?: unknown } | null)?.id;
        const UUID_RE =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (typeof rawNextId !== "string" || !UUID_RE.test(rawNextId)) {
          throw new ProcessorError(
            "enqueue_next_page_failed",
            true,
            "enqueue_next_page_failed",
            { next_page: nextP },
          );
        }
        next_page = nextP;
        next_queue_id = rawNextId;
      } catch (e) {
        if (e instanceof ProcessorError) throw e;
        throw new ProcessorError(
          "enqueue_next_page_failed",
          true,
          "enqueue_next_page_failed",
          { next_page: nextP },
        );
      }
    }

    // Log riepilogo compatto — nessun dump di markdown/result/payload.
    console.log("[padova_portal_collect_v2] ok", {
      queue_id: job.id,
      portal,
      page,
      parsed_count: listings.length,
      created,
      updated,
      rejected,
      next_page,
      next_queue_id,
    });
    return { ok: true };
  },

  civiko_contendibile_detail_v1: async (job, signal, workerId) => {
    if (signal.aborted) throw new ProcessorError("processor_aborted", true, "processor_aborted");
    if (job.provider !== "firecrawl" || job.operation !== "scrape") {
      throw new ProcessorError("invalid_detail_job", false, "invalid_context");
    }
    if (!job.result || typeof job.result !== "object") {
      throw new ProcessorError("missing_result", false, "missing_result");
    }
    const ctx = (job.processor_context ?? {}) as Record<string, unknown>;
    const listingId = Number(ctx.listing_id);
    const url = String(ctx.url ?? "");
    const zone = String(ctx.commercial_zone_slug ?? "");
    if (!Number.isInteger(listingId) || listingId <= 0 || !/^https:\/\//i.test(url) || !zone) {
      throw new ProcessorError("invalid_detail_context", false, "invalid_context");
    }

    let parsed;
    try {
      parsed = parseContendibileDetail(job.result, {
        listing_id: listingId,
        url,
        commercial_zone_slug: zone,
      });
    } catch (e) {
      throw new ProcessorError(
        `detail_parser_error:${(e as Error).message}`.slice(0, 200),
        false,
        "parser_error",
      );
    }

    let descrFp: string | null = null;
    if (parsed.descr_fp_input) {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(parsed.descr_fp_input),
      );
      descrFp = "sha256:" + Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    const evidence = {
      via_norm: parsed.via_norm,
      civico_norm: parsed.civico_norm,
      piano_key: parsed.piano_key,
      descr_fp: descrFp,
      unit_ref: parsed.unit_ref,
      image_refs: parsed.image_refs,
      text_chars: parsed.text_chars,
      version: parsed.version,
    };
    const { data, error } = await sb.rpc("process_civiko_contendibile_detail_v1", {
      p_queue_id: job.id,
      p_worker_id: workerId,
      p_listing_id: listingId,
      p_url: url,
      p_commercial_zone_slug: zone,
      p_evidence: evidence,
    }).abortSignal(signal);
    if (error) {
      throw new ProcessorError(
        `detail_rpc_error:${error.code ?? ""}:${(error.message ?? "").slice(0, 140)}`,
        classifyRpcError(error.code),
        "rpc_error",
        { code: error.code },
      );
    }
    if (!data || typeof data !== "object" || Array.isArray(data) || (data as Record<string, unknown>).ok !== true) {
      throw new ProcessorError("invalid_detail_rpc_summary", false, "invalid_rpc_summary");
    }
    console.log("[civiko_contendibile_detail_v1] ok", {
      queue_id: job.id,
      listing_id: listingId,
      zone,
      has_civico: Boolean(parsed.civico_norm),
      has_piano: Boolean(parsed.piano_key),
      has_descr_fp: Boolean(descrFp),
      image_refs: parsed.image_refs.length,
    });
    return { ok: true };
  },

  [APIFY_DATASET_PROCESSOR]: async (job, signal, _workerId) => {
    if (signal.aborted) {
      throw new ProcessorError("processor_aborted", true, "processor_aborted");
    }
    if (job.provider !== "apify") {
      throw new ProcessorError(`invalid_provider:${job.provider}`, false, "invalid_provider");
    }
    const ctx = (job.processor_context ?? {}) as Record<string, unknown>;
    const payload = (job.payload ?? {}) as Record<string, unknown>;
    const result = (job.result ?? {}) as Record<string, unknown>;
    const runObj = result.run && typeof result.run === "object"
      ? result.run as Record<string, unknown>
      : {};
    const runId = String(
      job.result_ref ?? payload.run_id ?? runObj.id ?? ctx.run_id ?? "",
    ).trim();
    if (!runId) {
      throw new ProcessorError("run_id_missing", false, "invalid_context");
    }
    const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
    const base = Deno.env.get("SUPABASE_URL") ?? "";
    if (!jobSecret || !base) {
      throw new ProcessorError("collect_pending_config_missing", true, "config_missing");
    }
    if (signal.aborted) {
      throw new ProcessorError("processor_aborted", true, "processor_aborted");
    }
    const response = await fetch(
      `${base}/functions/v1/padova-apify-collect-pending`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-job-secret": jobSecret,
        },
        body: JSON.stringify({
          run_ids: [runId],
          stale_minutes: 0,
          max_items_per_run: 10000,
          drain_wait_seconds: 20,
        }),
        signal,
      },
    );
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      parsed = {};
    }
    if (response.status === 202 || Number(parsed.pending_count ?? 0) > 0) {
      throw new ProcessorError("apify_still_running", true, "apify_still_running");
    }
    if (!response.ok || parsed.ok === false) {
      throw new ProcessorError(
        `collect_pending_http_${response.status}`,
        response.status >= 500 || response.status === 429,
        "collect_pending_failed",
      );
    }
    console.log("[padova_apify_dataset_v1] ok", {
      queue_id: job.id,
      run_id: runId,
      imports_count: parsed.imports_count ?? 0,
    });
    return { ok: true };
  },
};


// -------- Helpers --------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function withTimeout(
  fn: (signal: AbortSignal) => Promise<{ ok: true }>,
  ms: number,
): Promise<{ ok: true }> {
  const controller = new AbortController();
  let handle: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => {
      controller.abort();
      reject(new ProcessorError("processor_timeout", true, "processor_timeout"));
    }, ms) as unknown as number;
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

async function claim(workerId: string, limit: number): Promise<Job[]> {
  const { data, error } = await sb.rpc("scraping_processing_claim", {
    p_worker_id: workerId,
    p_limit: limit,
    p_lease_seconds: 90,
  });
  if (error) throw new Error(`claim_failed: ${error.message}`);
  return (data ?? []) as Job[];
}

async function complete(job: Job, workerId: string): Promise<boolean> {
  const { data, error } = await sb.rpc("scraping_processing_complete", {
    p_id: job.id,
    p_worker_id: workerId,
  });
  if (error) {
    console.error("[scraping-result-processor] complete rpc error", {
      id: job.id, code: error.code, message: error.message,
    });
    return false;
  }
  return data === true;
}

async function fail(
  job: Job,
  workerId: string,
  err: ProcessorError | Error,
): Promise<string> {
  const retryable = err instanceof ProcessorError ? err.retryable : true;
  const code = err instanceof ProcessorError ? err.code : "unhandled_error";
  const detail =
    err instanceof ProcessorError && err.detail ? err.detail : undefined;
  const payload = {
    p_id: job.id,
    p_worker_id: workerId,
    p_error: { code, message: err.message, ...(detail ? { detail } : {}) },
    p_retryable: retryable,
  };
  const { data, error } = await sb.rpc("scraping_processing_fail", payload);
  if (error) {
    console.error("[scraping-result-processor] fail rpc error", {
      id: job.id, code: error.code, message: error.message,
    });
    return "rpc_error";
  }
  const status = typeof data === "string" ? data : "unknown";
  console.log("[scraping-result-processor] fail outcome", {
    id: job.id, processor: job.processor, status, code,
  });
  return status;
}

async function process(job: Job, workerId: string) {
  const fn = PROCESSORS[job.processor];
  if (!fn) {
    const status = await fail(job, workerId, new ProcessorError(
      `unknown_processor:${job.processor}`, false, "unknown_processor",
    ));
    return { id: job.id, processor: job.processor, ok: false, reason: "unknown_processor", status };
  }
  const timeoutMs = PROCESSOR_TIMEOUT_MS[job.processor] ?? 15_000;
  try {
    await withTimeout((signal) => fn(job, signal, workerId), timeoutMs);
  } catch (err) {
    console.error("[scraping-result-processor] processor failed", {
      id: job.id,
      processor: job.processor,
      code: err instanceof ProcessorError ? err.code : "unhandled_error",
      message: err instanceof Error ? err.message : String(err),
    });
    const status = await fail(job, workerId, err as Error);
    return { id: job.id, processor: job.processor, ok: false, status };
  }

  const completed = await complete(job, workerId);
  if (!completed) {
    console.warn("[scraping-result-processor] lost_lease on complete", {
      id: job.id, processor: job.processor,
    });
    return { id: job.id, processor: job.processor, ok: false, status: "lost_lease" };
  }
  return { id: job.id, processor: job.processor, ok: true, status: "succeeded" };
}

// -------- HTTP handler --------

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const token = req.headers.get("x-worker-token") ?? "";
  if (!WORKER_TOKEN || !safeEqual(token, WORKER_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: { limit?: number; concurrency?: number; drain?: boolean } = {};
  try {
    if (req.headers.get("content-length") !== "0") {
      body = (await req.json().catch(() => ({}))) ?? {};
    }
  } catch { body = {}; }

  const limit = Math.min(20, Math.max(1, Math.trunc(Number(body.limit) || 5)));
  const concurrency = Math.min(5, Math.max(1, Math.trunc(Number(body.concurrency) || 3)));
  const drain = body.drain !== false;
  const effectiveLimit = processorClaimLimit({ limit, concurrency, drain });
  const workerId = crypto.randomUUID();

  try {
    await sb.rpc("scraping_processing_reap_expired");
  } catch {
    // Reaper is best-effort; claim still proceeds.
  }

  const startedAt = Date.now();
  const results: unknown[] = [];
  let claimedTotal = 0;
  let lastClaimed = 0;

  do {
    let jobs: Job[];
    try {
      jobs = await claim(workerId, effectiveLimit);
    } catch (e) {
      console.error("[scraping-result-processor] claim error", { message: (e as Error).message });
      if (claimedTotal === 0) {
        return json({ error: "claim_failed", message: (e as Error).message }, 500);
      }
      break;
    }
    lastClaimed = jobs.length;
    claimedTotal += lastClaimed;
    if (jobs.length === 0) break;

    let cursor = 0;
    async function pump() {
      while (cursor < jobs.length) {
        const i = cursor++;
        const outcome = await Promise.allSettled([process(jobs[i], workerId)]);
        const r = outcome[0];
        results.push(
          r.status === "fulfilled"
            ? r.value
            : { id: jobs[i].id, ok: false, reason: "pool_error" },
        );
      }
    }
    const pumps = Array.from(
      { length: Math.min(concurrency, jobs.length) },
      () => pump(),
    );
    await Promise.allSettled(pumps);
  } while (drain && shouldClaimAnotherWave({
    startedAtMs: startedAt,
    nowMs: Date.now(),
    wallMs: PROCESSOR_DRAIN_WALL_MS,
    lastClaimed,
  }));

  return json({ claimed: claimedTotal, results });
});
