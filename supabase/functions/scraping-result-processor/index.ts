// scraping-result-processor
// Livello separato per processare i "result" dei job scraping già riusciti,
// senza ripetere chiamate a pagamento verso Firecrawl / Perplexity / Apify.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WORKER_TOKEN = Deno.env.get("SCRAPING_WORKER_TOKEN")!;

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-worker-token, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

type ProcessorFn = (job: Job) => Promise<{ ok: true } | never>;

const PROCESSOR_TIMEOUT_MS: Record<string, number> = {
  queue_smoke_test: 5_000,
};

const PROCESSORS: Record<string, ProcessorFn> = {
  queue_smoke_test: async (job) => {
    if (!job.result || typeof job.result !== "object") {
      throw new ProcessorError(
        "missing_result",
        false,
        "missing_result",
      );
    }
    return { ok: true };
  },
};

// -------- Helpers --------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let handle: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(
      () =>
        reject(
          new ProcessorError("processor_timeout", true, "processor_timeout"),
        ),
      ms,
    ) as unknown as number;
  });
  try {
    return await Promise.race([p, timeout]);
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

async function complete(job: Job, workerId: string) {
  const { error } = await sb.rpc("scraping_processing_complete", {
    p_id: job.id,
    p_worker_id: workerId,
  });
  if (error) throw new Error(`complete_failed: ${error.message}`);
}

async function fail(
  job: Job,
  workerId: string,
  err: ProcessorError | Error,
) {
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
  const { error } = await sb.rpc("scraping_processing_fail", payload);
  if (error) {
    console.error("[scraping-result-processor] fail rpc error", error);
  }
}

async function process(job: Job, workerId: string) {
  const fn = PROCESSORS[job.processor];
  if (!fn) {
    await fail(
      job,
      workerId,
      new ProcessorError(
        `unknown_processor:${job.processor}`,
        false,
        "unknown_processor",
      ),
    );
    return { id: job.id, processor: job.processor, ok: false, reason: "unknown_processor" };
  }
  const timeoutMs = PROCESSOR_TIMEOUT_MS[job.processor] ?? 15_000;
  try {
    await withTimeout(fn(job), timeoutMs);
    await complete(job, workerId);
    return { id: job.id, processor: job.processor, ok: true };
  } catch (err) {
    console.error(
      "[scraping-result-processor] processor failed",
      { id: job.id, processor: job.processor },
      err,
    );
    await fail(job, workerId, err as Error);
    return { id: job.id, processor: job.processor, ok: false };
  }
}

// -------- HTTP handler --------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const token = req.headers.get("x-worker-token");
  if (!WORKER_TOKEN || !token || token !== WORKER_TOKEN) {
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
    console.error("[scraping-result-processor] claim error", e);
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
  const pumps = Array.from({ length: Math.min(concurrency, jobs.length) }, () =>
    pump(),
  );
  await Promise.allSettled(pumps);

  return json({ claimed: jobs.length, results });
});
