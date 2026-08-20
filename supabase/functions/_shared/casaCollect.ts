// Pure helpers for Casa.it Apify Padova collection.
// Actor: benthepythondev/casa-it-scraper (locations + channel + maxResults).
// searchUrls is a defective actor branch — never sent.
// No Deno.env, no secrets. Callers inject URLs/tokens at runtime.

export const ACTOR_CASA = "benthepythondev~casa-it-scraper";
export const CASA_PORTAL = "casa_collect";
export const CASA_CRON_JOB = "portal-casa-padova";
export const CASA_DEFAULT_LOCATION = "Padova";
export const CASA_CHANNEL = "sale" as const;
export const CASA_DEFAULT_MAX_ITEMS = 300;
export const CASA_MAX_ITEMS_CAP = 500;
export const COLLECT_PENDING_FN = "padova-apify-collect-pending";
export const APIFY_RESULT_USD = 0.002;
export const CASA_COST_CAP_USD = 1.00;
export const CASA_INFLIGHT_WINDOW_MS = 6 * 3600 * 1000;
export const CASA_LIVE_CORE_REF = "jpunnzgixcghuydstdlt";

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

export function isLikelyJwt(value: string): boolean {
  return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value);
}

export function extractJobSecretCandidates(headers: Headers): string[] {
  const out: string[] = [];
  const job = (headers.get("x-job-secret") ?? "").trim();
  const internal = (headers.get("x-internal-secret") ?? "").trim();
  if (job) out.push(job);
  if (internal) out.push(internal);
  const auth = headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) {
    const token = m[1].trim();
    if (token && !isLikelyJwt(token)) out.push(token);
  }
  return out;
}

export function isJobSecretAuthorized(headers: Headers, expected: string): boolean {
  if (!expected) return false;
  return extractJobSecretCandidates(headers).some((c) => constantTimeEqual(c, expected));
}

export function jobAuthFailure(secretConfigured: boolean): { status: number; error: string } {
  return secretConfigured
    ? { status: 401, error: "unauthorized" }
    : { status: 500, error: "CENTRAL_CORE_JOB_SECRET missing" };
}

/** Locations only. Drops URLs so callers cannot trip the actor's broken searchUrls branch. */
export function normalizeCasaLocations(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const v of arr) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s) continue;
    if (/^https?:\/\//i.test(s)) continue;
    if (/casa\.it/i.test(s)) continue;
    out.push(s);
  }
  return out.length ? out : [CASA_DEFAULT_LOCATION];
}

export function clampCasaMaxItems(raw: unknown): number {
  const n = Number(raw ?? CASA_DEFAULT_MAX_ITEMS);
  const t = Number.isFinite(n) ? Math.trunc(n) : CASA_DEFAULT_MAX_ITEMS;
  return Math.min(CASA_MAX_ITEMS_CAP, Math.max(1, t));
}

export function buildCasaActorInput(locations: string[], maxResults: number): {
  locations: string[];
  channel: "sale";
  maxResults: number;
} {
  return { locations, channel: CASA_CHANNEL, maxResults };
}

export function estimateCasaUsd(maxResults: number): number {
  return Number((maxResults * APIFY_RESULT_USD).toFixed(2));
}

export interface CasaCollectWebhook {
  eventTypes: string[];
  requestUrl: string;
  payloadTemplate: string;
  headersTemplate: string;
  ignoreSsl: boolean;
}

export function collectPendingUrl(base: string): string {
  const cleaned = (base ?? "").replace(/\/+$/, "");
  return cleaned ? `${cleaned}/functions/v1/${COLLECT_PENDING_FN}` : "";
}

export function buildCollectPendingWebhook(
  requestUrl: string,
  jobSecret: string,
): CasaCollectWebhook | null {
  if (!requestUrl || !jobSecret) return null;
  return {
    eventTypes: [
      "ACTOR.RUN.SUCCEEDED",
      "ACTOR.RUN.FAILED",
      "ACTOR.RUN.ABORTED",
      "ACTOR.RUN.TIMED_OUT",
    ],
    requestUrl,
    ignoreSsl: false,
    payloadTemplate: '{"run_ids":["{{resource.id}}"]}',
    headersTemplate: JSON.stringify({
      "Content-Type": "application/json",
      "x-job-secret": jobSecret,
      "x-internal-secret": jobSecret,
    }),
  };
}

/** UTF-8-safe base64. Apify decodes the `webhooks` query param; raw JSON becomes binary garbage (HTTP 400). */
export function utf8ToBase64(value: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "utf8").toString("base64");
  }
  const bytes = new TextEncoder().encode(value);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function encodeApifyWebhooksParam(webhooks: CasaCollectWebhook[]): string {
  return utf8ToBase64(JSON.stringify(webhooks));
}

export function webhookCreateBody(runId: string, webhook: CasaCollectWebhook): Record<string, unknown> {
  return {
    eventTypes: webhook.eventTypes,
    condition: { actorRunId: runId },
    requestUrl: webhook.requestUrl,
    payloadTemplate: webhook.payloadTemplate,
    headersTemplate: webhook.headersTemplate,
  };
}

export function redactApifyText(text: string): string {
  return text
    .replace(/token=[^&\s"']+/gi, "token=[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/apify_api_[A-Za-z0-9]+/g, "apify_api_[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]");
}

export function formatApifyStartError(status: number, body: string): string {
  const excerpt = redactApifyText(body).replace(/\s+/g, " ").slice(0, 240);
  return excerpt ? `APIFY_START_HTTP_${status}:${excerpt}` : `APIFY_START_HTTP_${status}`;
}

export function classifyCasaNightlyResult(
  httpStatus: number,
  parsed: Record<string, unknown> | null,
): { ok: boolean; started_count: number; reason: string | null } {
  const hasRun = typeof parsed?.run_id === "string" && (parsed.run_id as string).length > 0;
  const skipped = parsed?.skipped === true ||
    (typeof parsed?.skipped === "string" && (parsed.skipped as string).trim() !== "");
  const semanticOk = httpStatus >= 200 && httpStatus < 300 &&
    parsed?.ok !== false && !parsed?.error && !skipped && hasRun;
  let reason: string | null = null;
  if (!semanticOk) {
    if (skipped) reason = String(parsed?.reason ?? parsed?.skipped_reason ?? "skipped");
    else if (parsed?.error) reason = String(parsed.error);
    else if (!hasRun) reason = "no_run_id";
    else reason = `HTTP ${httpStatus}`;
  }
  return { ok: semanticOk, started_count: hasRun ? 1 : 0, reason };
}

export function casaSourceRegistryPatch(
  outcome: { ok: boolean; records?: number; error?: string },
  nowIso: string,
): Record<string, unknown> {
  if (outcome.ok) {
    return {
      last_run_at: nowIso,
      last_success_at: nowIso,
      last_error: null,
      record_count: outcome.records ?? 0,
    };
  }
  return {
    last_run_at: nowIso,
    last_error: `[casa-apify] ${(outcome.error ?? "failed").slice(0, 500)}`,
  };
}

export function summarizeCasaDatasetItems(items: unknown[]): {
  count: number;
  cities: string[];
  sample_ids: string[];
  padova_city_count: number;
  missing_city_count: number;
  sale_count: number;
  first_item_keys: string[];
} {
  const list = Array.isArray(items) ? items : [];
  const cities: string[] = [];
  const sample_ids: string[] = [];
  let padova_city_count = 0;
  let missing_city_count = 0;
  let sale_count = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const it = raw as Record<string, unknown>;
    const city = String(it.city ?? "").trim();
    if (!city) missing_city_count++;
    else {
      cities.push(city);
      if (city.toLowerCase() === "padova") padova_city_count++;
    }
    if (String(it.channel ?? "") === "sale") sale_count++;
    if (it.id != null && sample_ids.length < 5) sample_ids.push(String(it.id));
  }
  const first = list.find((x) => x && typeof x === "object") as Record<string, unknown> | undefined;
  return {
    count: list.length,
    cities: Array.from(new Set(cities)).slice(0, 12),
    sample_ids,
    padova_city_count,
    missing_city_count,
    sale_count,
    first_item_keys: first ? Object.keys(first).sort() : [],
  };
}
