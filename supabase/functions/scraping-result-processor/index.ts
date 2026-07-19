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

// -------- Processors registry (Fase 1: solo smoke test) --------
//
// NOTA VINCOLANTE (leggere prima di aggiungere processor applicativi):
// I processor applicativi futuri devono usare RPC PostgreSQL atomiche e
// idempotenti per gli upsert (dedupe_key, transazioni singole, ON CONFLICT).
// AbortSignal da solo NON garantisce il rollback di scritture già iniziate:
// serve solo a interrompere I/O in corso, non a ripulire side-effect già
// applicati al database.

type ProcessorFn = (job: Job, signal: AbortSignal) => Promise<{ ok: true }>;

const PROCESSOR_TIMEOUT_MS: Record<string, number> = {
  queue_smoke_test: 5_000,
  padova_portal_collect_v2: 15_000,
};

const PROCESSORS: Record<string, ProcessorFn> = {
  queue_smoke_test: async (job, signal) => {
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

  padova_portal_collect_v2: async (job, signal) => {
    if (signal.aborted) {
      throw new ProcessorError("processor_aborted", true, "processor_aborted");
    }
    // Validazione provider / operation — non retryable
    if (job.provider !== "firecrawl") {
      throw new ProcessorError(
        `invalid_provider:${job.provider}`,
        false,
        "invalid_provider",
      );
    }
    if (job.operation !== "scrape") {
      throw new ProcessorError(
        `invalid_operation:${job.operation}`,
        false,
        "invalid_operation",
      );
    }
    // Validazione context — non retryable
    const ctx = (job.processor_context ?? {}) as Record<string, unknown>;
    const municipality = String(ctx.municipality ?? "");
    const province = String(ctx.province ?? "");
    const portal = String(ctx.portal ?? "") as PortalSource;
    const mode = String(ctx.mode ?? "");
    if (municipality !== "Padova") {
      throw new ProcessorError("invalid_municipality", false, "invalid_context");
    }
    if (province !== "PD") {
      throw new ProcessorError("invalid_province", false, "invalid_context");
    }
    if (!ALLOWED_PORTALS.includes(portal)) {
      throw new ProcessorError("invalid_portal", false, "invalid_context");
    }
    if (mode !== "soft" && mode !== "full") {
      throw new ProcessorError("invalid_mode", false, "invalid_context");
    }
    if (!job.result || typeof job.result !== "object") {
      throw new ProcessorError("missing_result", false, "missing_result");
    }
    if (signal.aborted) {
      throw new ProcessorError("processor_aborted", true, "processor_aborted");
    }

    const context: PortalProcessorContext = {
      municipality,
      province,
      portal,
      mode: mode as "soft" | "full",
    };

    // Parser puro (nessun log del result, nessuna PII in log)
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

    if (signal.aborted) {
      throw new ProcessorError("processor_aborted", true, "processor_aborted");
    }

    // UNA sola RPC atomica per la persistenza + promozione
    const { data, error } = await sb.rpc("process_padova_portal_collect_v2", {
      p_queue_id: job.id,
      p_context: context as unknown as Record<string, unknown>,
      p_listings: listings,
    });

    if (error) {
      // Errori DB temporanei → retryable
      throw new ProcessorError(
        `rpc_error:${error.code ?? ""}:${(error.message ?? "").slice(0, 160)}`,
        true,
        "rpc_error",
        { code: error.code },
      );
    }
    console.log("[padova_portal_collect_v2] rpc_result", {
      queue_id: job.id,
      portal,
      mode,
      summary: data,
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

// Confronto in tempo costante sull'intera stringa (no short-circuit).
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
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
      reject(
        new ProcessorError("processor_timeout", true, "processor_timeout"),
      );
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

// Ritorna true solo se il DB conferma il completamento.
async function complete(job: Job, workerId: string): Promise<boolean> {
  const { data, error } = await sb.rpc("scraping_processing_complete", {
    p_id: job.id,
    p_worker_id: workerId,
  });
  if (error) {
    console.error("[scraping-result-processor] complete rpc error", {
      id: job.id,
      code: error.code,
      message: error.message,
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
      id: job.id,
      code: error.code,
      message: error.message,
    });
    return "rpc_error";
  }
  const status = typeof data === "string" ? data : "unknown";
  console.log("[scraping-result-processor] fail outcome", {
    id: job.id,
    processor: job.processor,
    status,
    code,
  });
  return status;
}

async function process(job: Job, workerId: string) {
  const fn = PROCESSORS[job.processor];
  if (!fn) {
    const status = await fail(
      job,
      workerId,
      new ProcessorError(
        `unknown_processor:${job.processor}`,
        false,
        "unknown_processor",
      ),
    );
    return {
      id: job.id,
      processor: job.processor,
      ok: false,
      reason: "unknown_processor",
      status,
    };
  }
  const timeoutMs = PROCESSOR_TIMEOUT_MS[job.processor] ?? 15_000;
  try {
    await withTimeout((signal) => fn(job, signal), timeoutMs);
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
    // Lease perso: NON chiamare fail (perderemmo di nuovo il lease).
    console.warn("[scraping-result-processor] lost_lease on complete", {
      id: job.id,
      processor: job.processor,
    });
    return {
      id: job.id,
      processor: job.processor,
      ok: false,
      status: "lost_lease",
    };
  }
  return {
    id: job.id,
    processor: job.processor,
    ok: true,
    status: "succeeded",
  };
}

// -------- HTTP handler --------

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const token = req.headers.get("x-worker-token") ?? "";
  if (!WORKER_TOKEN || !safeEqual(token, WORKER_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: { limit?: number; concurrency?: number } = {};
  try {
    if (req.headers.get("content-length") !== "0") {
      body = (await req.json().catch(() => ({}))) ?? {};
    }
  } catch {
    body = {};
  }

  const limit = Math.min(
    20,
    Math.max(1, Math.trunc(Number(body.limit) || 5)),
  );
  const concurrency = Math.min(
    5,
    Math.max(1, Math.trunc(Number(body.concurrency) || 3)),
  );
  const workerId = crypto.randomUUID();

  let jobs: Job[];
  try {
    jobs = await claim(workerId, limit);
  } catch (e) {
    console.error("[scraping-result-processor] claim error", {
      message: (e as Error).message,
    });
    return json({ error: "claim_failed", message: (e as Error).message }, 500);
  }

  if (jobs.length === 0) {
    return json({ claimed: 0, results: [] });
  }

  // Concorrenza limitata via pool semplice.
  const results: unknown[] = [];
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

  return json({ claimed: jobs.length, results });
});
