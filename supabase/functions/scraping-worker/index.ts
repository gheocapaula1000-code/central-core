import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  buildApifyRunWebhooks,
  collectPendingWebhookUrl,
  encodeApifyWebhooksQuery,
  isApifyPending,
  isApifySucceeded,
} from "../_shared/apifyDrain.ts";
import {
  APIFY_DATASET_PROCESSOR,
  apifyPollAvailableAt,
  safeEqual,
  shouldClaimAnotherWave,
  WORKER_DRAIN_WALL_MS,
  WORKER_LEASE_SECONDS,
} from "../_shared/scrapingLocks.ts";

type Provider = "firecrawl" | "perplexity" | "apify";

type Job = {
  id: string;
  provider: Provider;
  operation: string;
  payload: Record<string, unknown>;
  timeout_seconds: number;
  attempt: number;
};

type Outcome = {
  result: unknown;
  status: number;
  resultRef?: string;
};

class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = true,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WORKER_TOKEN = Deno.env.get("SCRAPING_WORKER_TOKEN")!;

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: {
    persistSession: false,
  },
});

function env(name: string): string {
  const value = Deno.env.get(name);

  if (!value) {
    throw new ProviderError(`${name}_missing`, undefined, false);
  }

  return value;
}

function integer(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const number = Number(value);

  return Number.isFinite(number)
    ? Math.min(max, Math.max(min, Math.trunc(number)))
    : fallback;
}

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");

  if (!raw) {
    return undefined;
  }

  const seconds = Number(raw);

  if (Number.isFinite(seconds)) {
    return Math.max(1, Math.trunc(seconds));
  }

  const date = Date.parse(raw);

  return Number.isFinite(date)
    ? Math.max(1, Math.ceil((date - Date.now()) / 1000))
    : undefined;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; body: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("provider_timeout"), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });

    const text = await response.text();

    let body: any;

    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {
        raw: text.slice(0, 4000),
      };
    }

    return {
      response,
      body,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ProviderError("provider_timeout", 408, true);
    }

    throw new ProviderError(
      error instanceof Error ? error.message : "network_error",
      undefined,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

function assertOk(response: Response, body: any): void {
  if (response.ok) {
    return;
  }

  const retryable =
    response.status === 408 ||
    response.status === 409 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500;

  throw new ProviderError(
    `provider_http_${response.status}:${JSON.stringify(body).slice(0, 500)}`,
    response.status,
    retryable,
    retryAfter(response),
  );
}

async function firecrawl(job: Job, timeoutMs: number): Promise<Outcome> {
  if (job.operation !== "scrape") {
    throw new ProviderError(
      `unsupported_firecrawl_operation:${job.operation}`,
      400,
      false,
    );
  }

  const url = String(job.payload.url ?? "");

  if (!/^https?:\/\//i.test(url)) {
    throw new ProviderError("invalid_url", 400, false);
  }

  const { response, body } = await fetchJson(
    "https://api.firecrawl.dev/v2/scrape",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("FIRECRAWL_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: job.payload.formats ?? ["markdown"],
        onlyMainContent: job.payload.onlyMainContent ?? true,
        waitFor: integer(job.payload.waitFor, 0, 0, 5000),
        timeout: Math.min(timeoutMs - 1000, 30000),
        ...(job.payload.proxy ? { proxy: job.payload.proxy } : {}),
        ...(job.payload.headers ? { headers: job.payload.headers } : {}),
      }),
    },
    timeoutMs,
  );

  assertOk(response, body);

  return {
    result: body,
    status: response.status,
  };
}

async function perplexity(job: Job, timeoutMs: number): Promise<Outcome> {
  if (job.operation !== "search" && job.operation !== "chat") {
    throw new ProviderError(
      `unsupported_perplexity_operation:${job.operation}`,
      400,
      false,
    );
  }

  const messages = job.payload.messages ?? [
    {
      role: "user",
      content: String(job.payload.query ?? ""),
    },
  ];

  const { response, body } = await fetchJson(
    "https://api.perplexity.ai/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("PERPLEXITY_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: job.payload.model ?? "sonar",
        messages,
        temperature: job.payload.temperature ?? 0.1,
        max_tokens: integer(job.payload.max_tokens, 1200, 100, 4000),
        return_citations: true,
      }),
    },
    timeoutMs,
  );

  assertOk(response, body);

  return {
    result: body,
    status: response.status,
  };
}

async function apify(job: Job, timeoutMs: number): Promise<Outcome> {
  const token = env("APIFY_API_TOKEN");

  if (job.operation === "start") {
    const actorId = String(job.payload.actor_id ?? "").replace("/", "~");

    if (!actorId) {
      throw new ProviderError("actor_id_missing", 400, false);
    }

    const webhooks = buildApifyRunWebhooks({
      requestUrl: collectPendingWebhookUrl(SUPABASE_URL),
      jobSecret: Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "",
    });
    const webhookQuery = webhooks
      ? `&webhooks=${encodeURIComponent(encodeApifyWebhooksQuery(webhooks))}`
      : "";

    const { response, body } = await fetchJson(
      `https://api.apify.com/v2/acts/${
        encodeURIComponent(actorId)
      }/runs?token=${encodeURIComponent(token)}&waitForFinish=0${webhookQuery}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(job.payload.input ?? {}),
      },
      Math.min(timeoutMs, 10000),
    );

    assertOk(response, body);

    const run = body.data ?? body;

    return {
      result: run,
      status: response.status,
      resultRef: run.id,
    };
  }

  if (job.operation === "poll") {
    const runId = String(job.payload.run_id ?? "");

    if (!runId) {
      throw new ProviderError("run_id_missing", 400, false);
    }

    const runResponse = await fetchJson(
      `https://api.apify.com/v2/actor-runs/${
        encodeURIComponent(runId)
      }?token=${encodeURIComponent(token)}`,
      {},
      Math.min(timeoutMs, 10000),
    );

    assertOk(runResponse.response, runResponse.body);

    const run = runResponse.body.data ?? runResponse.body;

    if (isApifyPending(run.status)) {
      throw new ProviderError(
        `apify_${String(run.status).toLowerCase()}`,
        202,
        true,
        30,
      );
    }

    if (!isApifySucceeded(run.status)) {
      throw new ProviderError(
        `apify_${String(run.status).toLowerCase()}`,
        502,
        ["TIMING-OUT", "TIMED-OUT"].includes(run.status),
      );
    }

    const datasetId = String(run.defaultDatasetId ?? "");

    return {
      result: {
        run,
        dataset_id: datasetId,
        items: [],
      },
      status: runResponse.response.status,
      resultRef: runId,
    };
  }

  throw new ProviderError(
    `unsupported_apify_operation:${job.operation}`,
    400,
    false,
  );
}

async function execute(job: Job): Promise<Outcome> {
  const timeoutMs = Math.min(
    55000,
    Math.max(5000, job.timeout_seconds * 1000),
  );

  if (job.provider === "firecrawl") {
    return firecrawl(job, timeoutMs);
  }

  if (job.provider === "perplexity") {
    return perplexity(job, timeoutMs);
  }

  return apify(job, timeoutMs);
}

async function processJob(
  job: Job,
  workerId: string,
): Promise<Record<string, unknown>> {
  const started = Date.now();

  try {
    const outcome = await execute(job);

    const { data, error } = await sb.rpc("scraping_complete", {
      p_id: job.id,
      p_worker_id: workerId,
      p_result: outcome.result,
      p_http_status: outcome.status,
      p_duration_ms: Date.now() - started,
      p_result_ref: outcome.resultRef ?? null,
    });

    if (error) {
      throw error;
    }

    if (
      data === true &&
      job.provider === "apify" &&
      job.operation === "start" &&
      outcome.resultRef
    ) {
      const pollPayload = {
        run_id: outcome.resultRef,
        limit: job.payload.limit ?? 10000,
      };

      const { error: enqueueError } = await sb.rpc("scraping_enqueue_processed", {
        p_provider: "apify",
        p_operation: "poll",
        p_payload: pollPayload,
        p_processor: APIFY_DATASET_PROCESSOR,
        p_processor_context: { source: "apify_start" },
        p_idempotency_key: `apify-poll:${outcome.resultRef}`,
        p_group_key: null,
        p_priority: 100,
        p_max_attempts: 20,
        p_timeout_seconds: 30,
        p_available_at: apifyPollAvailableAt(),
        p_parent_id: job.id,
        p_depends_on: [job.id],
        p_processing_max_attempts: 5,
      });

      if (enqueueError) {
        return {
          id: job.id,
          ok: true,
          warning: `poll_enqueue_failed:${enqueueError.message}`,
        };
      }
    }

    return {
      id: job.id,
      ok: data === true,
    };
  } catch (error) {
    const providerError = error instanceof ProviderError
      ? error
      : new ProviderError(
        error instanceof Error ? error.message : "unknown_error",
      );

    const { data, error: rpcError } = await sb.rpc("scraping_fail", {
      p_id: job.id,
      p_worker_id: workerId,
      p_error: {
        code: providerError.message.split(":", 1)[0],
        message: providerError.message,
      },
      p_retryable: providerError.retryable,
      p_http_status: providerError.status ?? null,
      p_retry_after_seconds: providerError.retryAfter ?? null,
      p_duration_ms: Date.now() - started,
    });

    return {
      id: job.id,
      ok: false,
      state: data,
      error: rpcError?.message ?? providerError.message,
    };
  }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return new Response("method_not_allowed", {
      status: 405,
    });
  }

  const suppliedToken = request.headers.get("x-worker-token") ?? "";

  if (!WORKER_TOKEN || !safeEqual(suppliedToken, WORKER_TOKEN)) {
    return new Response("unauthorized", {
      status: 401,
    });
  }

  let input: Record<string, unknown> = {};

  try {
    input = await request.json();
  } catch {
    // Usa i valori predefiniti.
  }

  const workerId = crypto.randomUUID();
  const limit = integer(input.limit, 10, 1, 20);

  const provider = ["firecrawl", "perplexity", "apify"].includes(
      String(input.provider),
    )
    ? input.provider
    : null;

  try {
    await sb.rpc("scraping_reap_expired");
  } catch {
    // Reaper is best-effort; claim still proceeds.
  }

  const startedAt = Date.now();
  const allResults: unknown[] = [];
  let claimedTotal = 0;
  let lastClaimed = 0;

  do {
    const { data: jobs, error } = await sb.rpc("scraping_claim", {
      p_worker_id: workerId,
      p_limit: limit,
      p_provider: provider,
      p_lease_seconds: WORKER_LEASE_SECONDS,
    });

    if (error) {
      if (claimedTotal === 0) {
        return Response.json(
          {
            ok: false,
            error: error.message,
          },
          {
            status: 500,
          },
        );
      }
      break;
    }

    const batch = (jobs ?? []) as Job[];
    lastClaimed = batch.length;
    claimedTotal += lastClaimed;
    if (lastClaimed === 0) break;

    const results = await Promise.allSettled(
      batch.map((job) => processJob(job, workerId)),
    );
    allResults.push(
      ...results.map((result) =>
        result.status === "fulfilled"
          ? result.value
          : {
            ok: false,
            error: String(result.reason),
          }
      ),
    );
  } while (shouldClaimAnotherWave({
    startedAtMs: startedAt,
    nowMs: Date.now(),
    wallMs: WORKER_DRAIN_WALL_MS,
    lastClaimed,
  }));

  return Response.json({
    ok: true,
    worker_id: workerId,
    claimed: claimedTotal,
    results: allResults,
  });
});
