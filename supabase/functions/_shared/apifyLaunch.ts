// Pure Apify launch helpers — no Deno.env, no network.
// Used by startApifyRun() and covered by Node/Vitest tests.

export const ACTOR_SUBITO = "emastra~subito-it-immobili";

export const SUBITO_PADOVA_SEARCH_URLS = [
  "https://www.subito.it/annunci-veneto/vendita/immobili/padova/padova/",
  "https://www.subito.it/annunci-veneto/vendita/appartamenti/padova/padova/",
] as const;

export const COLLECT_PENDING_FN = "padova-apify-collect-pending";

export const SUBITO_SCHEDULER_JOBS = [
  "portal-subito-padova",
  "apify-subito-weekly",
  "central-core-padova-subito-promote",
  "portal-subito-promote",
] as const;

/** Apify path IDs use ~; callers sometimes pass username/name. */
export function normalizeApifyActorId(actor: string): string {
  const raw = (actor ?? "").trim();
  if (!raw) return "";
  const slash = raw.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (slash) return `${slash[1]}~${slash[2]}`;
  return raw;
}

export function isKnownSubitoActor(actor: string): boolean {
  return normalizeApifyActorId(actor) === ACTOR_SUBITO;
}

export const APIFY_TERMINAL_WEBHOOK_EVENTS = [
  "ACTOR.RUN.SUCCEEDED",
  "ACTOR.RUN.FAILED",
  "ACTOR.RUN.ABORTED",
  "ACTOR.RUN.TIMED_OUT",
] as const;

export interface CollectPendingWebhook {
  eventTypes: string[];
  requestUrl: string;
  payloadTemplate: string;
  headersTemplate: string;
}

/**
 * Webhook that POSTs collect-pending with the finished run_id.
 * payloadTemplate is required: the default Apify body has no `run_ids`,
 * and collect-pending would skip runs younger than stale_minutes.
 */
export function buildCollectPendingWebhook(
  collectUrl: string,
  jobSecret: string,
): CollectPendingWebhook | null {
  const url = (collectUrl ?? "").trim();
  const secret = (jobSecret ?? "").trim();
  if (!url.startsWith("https://") || !secret) return null;
  return {
    eventTypes: [...APIFY_TERMINAL_WEBHOOK_EVENTS],
    requestUrl: url,
    payloadTemplate: '{"run_ids":["{{resource.id}}"]}',
    headersTemplate: JSON.stringify({
      "Content-Type": "application/json",
      "x-job-secret": secret,
    }),
  };
}

export function encodeApifyWebhooksParam(webhooks: CollectPendingWebhook[]): string {
  const json = JSON.stringify(webhooks);
  if (typeof btoa === "function") {
    return btoa(json);
  }
  return Buffer.from(json, "utf8").toString("base64");
}

export function formatApifyStartError(status: number, bodyText: string): string {
  const clipped = (bodyText ?? "").replace(/\s+/g, " ").trim().slice(0, 220);
  const safe = clipped.replace(/token=[^&\s"]+/gi, "token=[REDACTED]");
  return `APIFY_START_HTTP_${status}${safe ? `:${safe}` : ""}`;
}

export function syntheticFailedRunId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `failed-local-${Date.now()}-${rand}`;
}

export interface NightlySemanticInput {
  httpOk: boolean;
  ok?: unknown;
  error?: unknown;
  skipped?: unknown;
  started?: unknown;
  errors?: unknown;
  run_id?: unknown;
}

export interface NightlySemanticResult {
  ok: boolean;
  started_count: number;
  errors_count: number;
  reason: string | null;
}

function startedRuns(input: NightlySemanticInput): unknown[] {
  if (Array.isArray(input.started) && input.started.length > 0) return input.started;
  if (typeof input.run_id === "string" && input.run_id.trim() !== "") return [input.run_id];
  return [];
}

/** Nightly wrapper success = at least one Apify run actually started. */
export function classifyNightlyCollectResult(input: NightlySemanticInput): NightlySemanticResult {
  const started = startedRuns(input);
  const errors = Array.isArray(input.errors) ? input.errors : [];
  const skipped = input.skipped === true ||
    (typeof input.skipped === "string" && input.skipped.trim() !== "");
  if (!input.httpOk) {
    return {
      ok: false,
      started_count: started.length,
      errors_count: errors.length,
      reason: typeof input.error === "string" && input.error
        ? String(input.error).slice(0, 300)
        : "downstream_http_failure",
    };
  }
  if (input.ok === false || (typeof input.error === "string" && input.error)) {
    return {
      ok: false,
      started_count: started.length,
      errors_count: errors.length,
      reason: String(input.error ?? "downstream_semantic_failure").slice(0, 300),
    };
  }
  if (skipped) {
    return {
      ok: false,
      started_count: started.length,
      errors_count: errors.length,
      reason: `skipped:${String(input.skipped)}`.slice(0, 300),
    };
  }
  if (started.length === 0) {
    return { ok: false, started_count: 0, errors_count: errors.length, reason: "no_apify_run_started" };
  }
  if (errors.length > 0) {
    return { ok: false, started_count: started.length, errors_count: errors.length, reason: "downstream_errors" };
  }
  return { ok: true, started_count: started.length, errors_count: 0, reason: null };
}

export function sourceRegistryPatch(
  outcome: { ok: boolean; records?: number; error?: string },
  nowIso: string,
  prefix = "[subito-apify]",
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    last_run_at: nowIso,
    updated_at: nowIso,
  };
  if (outcome.ok) {
    patch.last_success_at = nowIso;
    patch.last_error = null;
    if (typeof outcome.records === "number") patch.record_count = outcome.records;
  } else {
    patch.last_error = `${prefix} ${String(outcome.error ?? "unknown").slice(0, 450)}`;
  }
  return patch;
}

/** Accept collect-pending bodies from our template OR raw Apify webhook payloads. */
export function extractCollectRunIds(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const row = body as Record<string, unknown>;
  const fromArray = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.map((x) => String(x ?? "").trim()).filter((x) => x.length > 0)
      : [];
  const direct = fromArray(row.run_ids);
  if (direct.length) return Array.from(new Set(direct));
  const eventData = row.eventData && typeof row.eventData === "object"
    ? row.eventData as Record<string, unknown>
    : null;
  const resource = row.resource && typeof row.resource === "object"
    ? row.resource as Record<string, unknown>
    : null;
  const singles = [
    typeof eventData?.actorRunId === "string" ? eventData.actorRunId : "",
    typeof resource?.id === "string" ? resource.id : "",
  ].map((s) => s.trim()).filter(Boolean);
  return Array.from(new Set(singles));
}
