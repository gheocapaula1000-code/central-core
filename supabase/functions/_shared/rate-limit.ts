// ═══════════════════════════════════════════════════════════════
// Simple in-memory rate limiter for Civiko edge functions.
// Per-instance bucket keyed by client identifier (IP / origin).
// Not a substitute for distributed rate limiting — best-effort
// protection against abuse on a single edge instance.
// ═══════════════════════════════════════════════════════════════

interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

export function rateLimit(req: Request, key: string, opts: RateLimitOptions): { ok: boolean; retryAfter: number } {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const origin = req.headers.get("origin") || "no-origin";
  const bucketKey = `${key}:${origin}:${ip}`;

  const now = Date.now();
  const b = buckets.get(bucketKey);
  if (!b || b.resetAt <= now) {
    buckets.set(bucketKey, { count: 1, resetAt: now + opts.windowMs });
    return { ok: true, retryAfter: 0 };
  }
  if (b.count >= opts.max) {
    return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  }
  b.count += 1;
  return { ok: true, retryAfter: 0 };
}

// Periodic cleanup to avoid unbounded growth.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets.entries()) if (v.resetAt <= now) buckets.delete(k);
}, 60_000);
