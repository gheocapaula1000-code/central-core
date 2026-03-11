

## Rate Limit Hardening — Corrected Plan

### Current State
Lines 12-37 of `index.ts`: rate limiter uses only `sourceApp` as bucket key. All users of the same app share one 30 req/min bucket. Rate limit is applied **after** `requireSecret` (line 250), meaning all rate-limited requests are already trusted via secret. The 429 response has no `Retry-After` header.

### Key Insight
Since `requireSecret` gates all POST traffic before the rate limiter runs (line 250-251), every request reaching the limiter is already server-to-server trusted. However, the architecture should still distinguish callers within trusted traffic (per your rules) and be ready for any future public-facing paths.

### Changes — Single File: `supabase/functions/ai-core-run/index.ts`

**A. Replace rate limiter (lines 12-37) with caller-aware logic**

New constants:
```
RATE_WINDOW_MS   = 60_000
RATE_MAX_TRUSTED = 300
RATE_MAX_PUBLIC  = 30
```

New `buildCallerKey(req, body, trusted)`:
- **Public (not trusted):**
  1. `sourceApp:` + authenticated user ID only if verified via JWT (not applicable today — no JWT path, but future-proof)
  2. `sourceApp:` + first sanitized IP from `x-forwarded-for` or `cf-connecting-ip`
  3. `sourceApp:` + normalized origin
  4. `sourceApp:anonymous`
- **Trusted (secret validated):**
  1. `sourceApp:trusted:` + `body.user_id` or `x-user-id` header
  2. `sourceApp:trusted:` + origin
  3. `sourceApp:trusted:anonymous`

IP parsing: extract only first comma-separated value from `x-forwarded-for`, trim whitespace, validate it looks like an IP (no injection).

New `checkRateLimit(callerKey, maxRate)` returns `{ allowed: boolean; retryAfterSec: number }`.

**B. Wire into main handler (lines 279-284)**

After auth check passes → `trusted = true`. Build `callerKey` from parsed body + headers. Apply `checkRateLimit(callerKey, RATE_MAX_TRUSTED)`.

For any future untrusted path: use `RATE_MAX_PUBLIC` and the public key-building logic (no `body.user_id`).

**C. 429 response with Retry-After**

When rate limited, add `Retry-After` header (seconds remaining until bucket reset) to the fail response. Requires a small change to return remaining time from `checkRateLimit`.

**D. Logging**

One line on 429 only:
```
[rate] caller=${callerKey} trusted=${trusted} route=${pathname} => 429
```

### What does NOT change
- Envelope format (`ok`/`fail` structure, `debug_id`)
- All routing, health, metrics, diagnostics endpoints
- Provider adapters, pipeline configs
- Business output of any task
- `_shared/http.ts`

### Files touched
- `supabase/functions/ai-core-run/index.ts` — only file modified
- Redeploy `ai-core-run`

