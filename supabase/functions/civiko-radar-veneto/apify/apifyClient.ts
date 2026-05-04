// Apify HTTP client — no token logging, no token in responses.
// Uses APIFY_API_TOKEN server-side only.

const APIFY_BASE = "https://api.apify.com/v2";
const DEFAULT_TIMEOUT_MS = 60_000;

function getToken(): string {
  return Deno.env.get("APIFY_API_TOKEN") ?? "";
}

export function isApifyConfigured(): boolean {
  return getToken().length > 0;
}

async function apifyFetch(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const token = getToken();
  if (!token) throw new Error("APIFY_NOT_CONFIGURED");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `${APIFY_BASE}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (res.status === 429) {
      // Light backoff, single retry
      await new Promise((r) => setTimeout(r, 1500));
      return await fetch(url, { ...init, signal: ctrl.signal, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
    }
    return res;
  } finally {
    clearTimeout(t);
  }
}

/** Test connection by calling /users/me. Never returns the token. */
export async function testApifyConnection(): Promise<{ ok: boolean; userOrAccountAvailable: boolean; status?: number }> {
  if (!isApifyConfigured()) return { ok: false, userOrAccountAvailable: false };
  try {
    const res = await apifyFetch("/users/me", { method: "GET" }, 10_000);
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, userOrAccountAvailable: false, status: res.status };
    }
    const data = await res.json().catch(() => ({}));
    const hasAccount = Boolean(data?.data?.id || data?.data?.username);
    return { ok: true, userOrAccountAvailable: hasAccount, status: res.status };
  } catch {
    return { ok: false, userOrAccountAvailable: false };
  }
}

export interface ApifyRunStarted {
  id: string;
  status: string;
  defaultDatasetId?: string;
}

export async function startActorRun(actorId: string, input: Record<string, unknown>, timeoutMs = 30_000): Promise<ApifyRunStarted> {
  const res = await apifyFetch(`/acts/${encodeURIComponent(actorId)}/runs`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  }, timeoutMs);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`apify_start_failed_${res.status}:${txt.slice(0, 120)}`);
  }
  const data = await res.json();
  return {
    id: data?.data?.id,
    status: data?.data?.status,
    defaultDatasetId: data?.data?.defaultDatasetId,
  };
}

export async function getRunStatus(runId: string): Promise<{ status: string; defaultDatasetId?: string }> {
  const res = await apifyFetch(`/actor-runs/${encodeURIComponent(runId)}`, { method: "GET" }, 15_000);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`apify_run_status_${res.status}`);
  }
  const data = await res.json();
  return { status: data?.data?.status, defaultDatasetId: data?.data?.defaultDatasetId };
}

export async function getDatasetItems(datasetId: string, limit = 1000): Promise<unknown[]> {
  const res = await apifyFetch(`/datasets/${encodeURIComponent(datasetId)}/items?clean=true&limit=${limit}`, { method: "GET" }, 30_000);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`apify_dataset_${res.status}`);
  }
  const items = await res.json();
  return Array.isArray(items) ? items : [];
}

/** Run actor synchronously and return dataset items. */
export async function runActorSync(actorId: string, input: Record<string, unknown>, timeoutMs = 120_000): Promise<unknown[]> {
  const res = await apifyFetch(`/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  }, timeoutMs);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`apify_sync_${res.status}:${txt.slice(0, 120)}`);
  }
  const items = await res.json();
  return Array.isArray(items) ? items : [];
}
