/**
 * Shared fetch helper for admin console.
 * Injects x-core-secret from sessionStorage.
 * Centralizes error handling for all sensitive endpoint calls.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

export function getCoreSecret(): string | null {
  try {
    return sessionStorage.getItem("core_admin_secret");
  } catch {
    return null;
  }
}

export function setCoreSecret(secret: string): void {
  sessionStorage.setItem("core_admin_secret", secret);
}

export function clearCoreSecret(): void {
  sessionStorage.removeItem("core_admin_secret");
}

export function isCoreUnlocked(): boolean {
  return !!getCoreSecret();
}

export async function coreAdminFetch<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const secret = getCoreSecret();
  if (!secret) {
    throw new Error("Console non sbloccata — inserisci il secret amministrativo");
  }

  const headers: Record<string, string> = {
    "x-core-secret": secret,
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
