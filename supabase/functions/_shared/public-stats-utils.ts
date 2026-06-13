// Shared utilities for public-padova-* preview endpoints.
// - CORS limited to civikoone.com + localhost
// - Basic in-memory IP rate limiting (60 req/min/IP)
// - Security headers + caching

const ALLOWED_ORIGIN_EXACT = new Set([
  "https://civikoone.com",
  "https://www.civikoone.com",
]);

export function pickAllowedOrigin(req: Request): string {
  const origin = req.headers.get("origin") ?? "";
  if (!origin) return "https://civikoone.com";
  if (ALLOWED_ORIGIN_EXACT.has(origin)) return origin;
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return origin;
    if (u.hostname.endsWith(".lovable.app") || u.hostname.endsWith(".lovableproject.com")) return origin;
  } catch { /* ignore */ }
  return "https://civikoone.com";
}

export function publicHeaders(req: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": pickAllowedOrigin(req),
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=60",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}

interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;

export function checkRateLimit(req: Request, key: string): { ok: boolean; retryAfter: number } {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const bk = `${key}:${ip}`;
  const now = Date.now();
  const b = buckets.get(bk);
  if (!b || b.resetAt <= now) {
    buckets.set(bk, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true, retryAfter: 0 };
  }
  if (b.count >= MAX_PER_WINDOW) {
    return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  }
  b.count += 1;
  return { ok: true, retryAfter: 0 };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets.entries()) if (v.resetAt <= now) buckets.delete(k);
}, 60_000);

export function rateLimited(req: Request, retryAfter: number): Response {
  const headers = { ...publicHeaders(req), "Retry-After": String(retryAfter) };
  return new Response(
    JSON.stringify({ ok: false, error: { code: "RATE_LIMITED", message: "Troppo richieste, riprova tra un minuto" } }),
    { status: 429, headers },
  );
}

export async function fetchAll<T>(query: () => any, pageSize = 1000): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await query().range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}
