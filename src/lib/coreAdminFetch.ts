/**
 * Shared fetch helper for admin console.
 * Simple wrapper — no secret injection (origin policy protects backend).
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

export async function coreAdminFetch<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    "Content-Type": "application/json",
  };

  const res = await fetch(`${SUPABASE_URL}/functions/v1/${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  return json.data as T;
}
