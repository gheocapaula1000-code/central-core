// Pure Apify launch helpers — no Deno.env, no network.
// Used by startApifyRun() and covered by Node/Vitest tests.

export const ACTOR_SUBITO = "emastra~subito-it-immobili";
export const ACTOR_IMMO_LISTVIEW = "azzouzana~immobiliare-it-listing-page-scraper-by-search-url";
export const ACTOR_IMMO_DETAIL = "memo23~immobiliare-scraper";
export const ACTOR_IDEALISTA = "dz_omar~idealista-scraper-api";

export const SUBITO_PADOVA_SEARCH_URLS = [
  "https://www.subito.it/annunci-veneto/vendita/immobili/padova/padova/",
  "https://www.subito.it/annunci-veneto/vendita/appartamenti/padova/padova/",
] as const;

export const IMMOBILIARE_PADOVA_SEARCH_URLS = [
  "https://www.immobiliare.it/vendita-case/padova/?prezzoMassimo=150000",
  "https://www.immobiliare.it/vendita-case/padova/?prezzoMinimo=150000&prezzoMassimo=250000",
  "https://www.immobiliare.it/vendita-case/padova/?prezzoMinimo=250000&prezzoMassimo=400000",
  "https://www.immobiliare.it/vendita-case/padova/?prezzoMinimo=400000",
] as const;

// Comune di Padova only. Italian path + Italian filters (never Spanish
// `desde` / `ordenado-por`, which 404 on idealista.it and yield empty runs).
export const IDEALISTA_PADOVA_DISCOVERY_URLS = [
  "https://www.idealista.it/vendita-case/padova-padova/con-ultime-2-settimane_1/",
  "https://www.idealista.it/vendita-case/padova-padova/",
  "https://www.idealista.it/vendita-case/padova-padova/con-prezzo-max_200000/",
  "https://www.idealista.it/vendita-case/padova-padova/con-prezzo_200000-400000/",
  "https://www.idealista.it/vendita-case/padova-padova/con-prezzo-min_400000/",
] as const;

export const COLLECT_PENDING_FN = "padova-apify-collect-pending";

export const SUBITO_SCHEDULER_JOBS = [
  "portal-subito-padova",
  "apify-subito-weekly",
  "central-core-padova-subito-promote",
  "portal-subito-promote",
] as const;

export const IMMOBILIARE_SOURCE_CODES = ["F21"] as const;
export const IMMOBILIARE_SCHEDULER_JOBS = [
  "portal-immobiliare-padova",
  "central-core-apify-immobiliare-nightly",
] as const;

export const IDEALISTA_SOURCE_CODES = ["F21"] as const;
export const IDEALISTA_SCHEDULER_JOBS = [
  "portal-idealista-padova",
  "central-core-apify-idealista-nightly",
] as const;

const IDEALISTA_URL_RE = /^https:\/\/www\.idealista\.(com|pt|it)\/.+/i;

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

export function isKnownImmobiliareActor(actor: string): boolean {
  const id = normalizeApifyActorId(actor);
  return id === ACTOR_IMMO_LISTVIEW || id === ACTOR_IMMO_DETAIL;
}

export function isKnownIdealistaActor(actor: string): boolean {
  return normalizeApifyActorId(actor) === ACTOR_IDEALISTA;
}

export function isValidIdealistaUrl(url: string): boolean {
  return IDEALISTA_URL_RE.test((url ?? "").trim());
}

/** azzouzana listing-page actor: startUrl + maxItems. */
export function buildImmobiliareDiscoverInput(startUrl: string, maxItems: number): {
  startUrl: string;
  maxItems: number;
} {
  return { startUrl, maxItems };
}

/**
 * memo23 detail actor: startUrls as URL strings (schema prefill is string[]).
 * Do not send a proxy override — the actor already uses its own residential lane
 * and a caller-supplied RESIDENTIAL group can stall or fail the run.
 */
export function buildImmobiliareDetailInput(urls: string[], maxItems: number): {
  startUrls: string[];
  maxItems: number;
  includeAgencyDetails: false;
} {
  return {
    startUrls: urls.slice(0, maxItems),
    maxItems,
    includeAgencyDetails: false,
  };
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
 * Optional apikey is added so the Supabase gateway does not 401 the callback.
 */
export function buildCollectPendingWebhook(
  collectUrl: string,
  jobSecret: string,
  apikey = "",
): CollectPendingWebhook | null {
  const url = (collectUrl ?? "").trim();
  const secret = (jobSecret ?? "").trim();
  if (!url.startsWith("https://") || !secret) return null;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-job-secret": secret,
    "x-internal-secret": secret,
  };
  if (apikey) {
    headers.apikey = apikey;
    headers.Authorization = `Bearer ${apikey}`;
  }
  return {
    eventTypes: [...APIFY_TERMINAL_WEBHOOK_EVENTS],
    requestUrl: url,
    payloadTemplate: '{"run_ids":["{{resource.id}}"]}',
    headersTemplate: JSON.stringify(headers),
  };
}

export function encodeApifyWebhooksParam(webhooks: CollectPendingWebhook[]): string {
  const json = JSON.stringify(webhooks);
  const b64 = typeof btoa === "function"
    ? btoa(json)
    : Buffer.from(json, "utf8").toString("base64");
  // Apify richiede base64 URL-safe senza padding.
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

/** Persist a readable error on a RUNNING row instead of leaving last_scrape stuck. */
export function collectPendingRunError(
  action: string,
  apifyStatus?: string | null,
): string {
  if (action === "skip_no_apify_data") return "apify_run_unreadable";
  if (action === "skip_unknown_actor") return "unknown_actor";
  if (action === "marked_failed") return `apify_${String(apifyStatus ?? "FAILED").toLowerCase()}`;
  return action.slice(0, 200);
}

export function extractStartedRunIds(payload: Record<string, unknown> | null): string[] {
  if (!payload) return [];
  const fromStarted = Array.isArray(payload.started)
    ? payload.started
      .map((row) => {
        if (!row || typeof row !== "object") return "";
        return String((row as Record<string, unknown>).run_id ?? "").trim();
      })
      .filter(Boolean)
    : [];
  if (fromStarted.length) return Array.from(new Set(fromStarted));
  const top = typeof payload.run_id === "string" ? payload.run_id.trim() : "";
  return top ? [top] : [];
}
