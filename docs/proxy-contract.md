# Central Core V3 — Core-Proxy Contract Standard

> Canonical reference for building a `core-proxy` Edge Function in any PWA client.
> Last updated: 2026-03-20

---

## Architecture

```
PWA Frontend (browser)
  → core-proxy (local Edge Function in the PWA's Supabase project)
    → Central Core V3 (remote Edge Functions)
```

The proxy exists to:
1. Keep `AI_CORE_SECRET` server-side (never in browser code)
2. Inject the shared secret as `x-internal-secret`
3. Enforce a path allowlist (only forward known routes)
4. Apply per-route timeouts
5. Forward the response envelope unchanged to the frontend

---

## Required Secrets (in each PWA project)

| Secret | Purpose |
|--------|---------|
| `CENTRAL_CORE_BASE_URL` | Central Core Supabase URL (e.g. `https://xxx.supabase.co`) |
| `AI_CORE_SECRET` | Shared auth secret — must match Core's value |

---

## ALLOWED_PATHS

The proxy must maintain an explicit allowlist. Only prefixes in this list are forwarded.

### Standard allowlist

```typescript
const ALLOWED_PATHS = [
  "/ai-core-run",       // AI orchestration (all PWAs)
  "/sottra",            // Building scanner (Sottra, KeyDraft)
  "/viral-core",        // Content engine (Wyloni)
  // "/ecosystem-gateway" // Optional orchestrator
];
```

Each PWA should include only the paths it actually uses.

### Path forwarding rule

Paths are forwarded **as-is** (no remapping):

```
Client:  POST /core-proxy/viral-core/generate-bundle
Proxy:   POST ${CENTRAL_CORE_BASE_URL}/functions/v1/viral-core/generate-bundle
```

**Exception:** Legacy Wyloni paths may remap `/ai/run` → `/ai-core-run` for backward compatibility. New integrations must NOT introduce remaps.

### Validation

```typescript
function isPathAllowed(path: string): boolean {
  return ALLOWED_PATHS.some(prefix => path === prefix || path.startsWith(prefix + "/"));
}
```

Rejected paths return:
```json
{ "ok": false, "error": { "code": "INVALID_PATH", "message": "Path not in allowlist" } }
```

---

## Required Headers (proxy → Core)

| Header | Value | Required |
|--------|-------|----------|
| `x-internal-secret` | `AI_CORE_SECRET` env var | Yes (POST) |
| `Content-Type` | `application/json` | Yes |
| `apikey` | Central Core's Supabase anon key | Yes |
| `x-source-app` | PWA identifier (e.g. `wyloni`, `keydraft`) | Recommended |

### Header injection pattern

```typescript
const headers: Record<string, string> = {
  "Content-Type": "application/json",
  "x-internal-secret": Deno.env.get("AI_CORE_SECRET") ?? "",
  "apikey": CENTRAL_CORE_ANON_KEY,
  "x-source-app": SOURCE_APP,
};
```

Do NOT forward browser `Authorization` or `Cookie` headers to the Core.

---

## Timeouts (per route)

| Function | Route | Timeout |
|----------|-------|---------|
| `ai-core-run` | Generic POST | 45s |
| `ai-core-run` | `/documents/analyze` | 60s |
| `ai-core-run` | `/web/scrape` | 30s |
| `ai-core-run` | `/tariffs/compare` | 30s |
| `sottra` | Any scan/forecast | 30s |
| `viral-core` | `/generate-bundle` | 60s |
| `viral-core` | `/generate-single` | 45s |
| `viral-core` | `/policy-check` | 20s |
| `viral-core` | `/build-media-brief` | 20s |
| `ecosystem-gateway` | Any POST | 30s |

### Implementation pattern

```typescript
function timeoutForPath(path: string): number {
  if (path.startsWith("/viral-core/")) {
    if (path.includes("generate-bundle")) return 60_000;
    if (path.includes("generate-single")) return 45_000;
    return 20_000;
  }
  if (path.includes("/documents/analyze")) return 60_000;
  if (path.includes("/web/scrape")) return 30_000;
  if (path.startsWith("/sottra/")) return 30_000;
  if (path.startsWith("/ecosystem-gateway/")) return 30_000;
  return 45_000; // default
}
```

---

## Error Handling

### Core errors (forwarded as-is)

The proxy should forward the Core's JSON response unchanged, preserving:
- HTTP status code
- Response body (envelope with `ok`, `data`, `error`, `warnings`, `debug_id`)
- Identity headers (`X-Core-Version`, `X-Core-Function`, etc.)

### Proxy-level errors

For errors that occur in the proxy itself (before reaching Core):

| Scenario | HTTP | Code | Message |
|----------|------|------|---------|
| Path not in allowlist | 400 | `INVALID_PATH` | Path not in allowlist |
| Missing body | 400 | `MISSING_BODY` | Request body required |
| Core unreachable | 502 | `CORE_UNREACHABLE` | Central Core did not respond |
| Core timeout | 504 | `CORE_TIMEOUT` | Central Core timed out |
| Proxy config error | 500 | `PROXY_CONFIG_ERROR` | Missing CENTRAL_CORE_BASE_URL |

Proxy errors should use the same envelope format:
```json
{
  "ok": false,
  "data": null,
  "error": { "code": "CORE_TIMEOUT", "message": "Central Core timed out" }
}
```

---

## Retry Policy (client → proxy)

- **DO** retry on 5xx with exponential backoff (1s, 2s, 4s — max 3 attempts)
- **DO** retry on network timeout (once)
- **DO NOT** retry on 4xx (client-side issue)
- **DO NOT** retry on 429 — respect `Retry-After` header if present

The proxy itself should NOT retry — let the client decide.

---

## CORS

The proxy handles CORS for the browser. Central Core handles CORS for direct/server-to-server calls.

```typescript
const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // or restrict to your PWA domain
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};
```

---

## GET Routes (pass-through)

Health and manifest routes are public on Core. The proxy may:
- Forward them (useful for diagnostics from the browser)
- Or block them (if the PWA doesn't need browser-side health checks)

Recommendation: allow GET pass-through for `/health` and `/manifest` of each function the PWA uses.

---

## Reference Implementation Skeleton

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORE_BASE = Deno.env.get("CENTRAL_CORE_BASE_URL") ?? "";
const SECRET = Deno.env.get("AI_CORE_SECRET") ?? "";
const SOURCE_APP = "your-app-name";

const ALLOWED_PATHS = ["/ai-core-run", "/sottra"];

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const proxyPrefix = "/core-proxy";
  const path = url.pathname.replace(proxyPrefix, "");

  // Validate path
  if (!ALLOWED_PATHS.some(p => path === p || path.startsWith(p + "/"))) {
    return json(400, { ok: false, data: null, error: { code: "INVALID_PATH", message: "Path not in allowlist" } });
  }

  // Build target URL
  const target = `${CORE_BASE}/functions/v1${path}`;

  // Forward request
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutForPath(path));

  try {
    const res = await fetch(target, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": SECRET,
        "x-source-app": SOURCE_APP,
      },
      body: req.method === "POST" ? await req.text() : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    return new Response(await res.text(), {
      status: res.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    clearTimeout(timeout);
    const code = err.name === "AbortError" ? "CORE_TIMEOUT" : "CORE_UNREACHABLE";
    return json(code === "CORE_TIMEOUT" ? 504 : 502, {
      ok: false, data: null, error: { code, message: `Central Core: ${code}` },
    });
  }
});
```

---

## Checklist for New PWA Integration

- [ ] Create `supabase/functions/core-proxy/index.ts`
- [ ] Configure `CENTRAL_CORE_BASE_URL` and `AI_CORE_SECRET` in Supabase secrets
- [ ] Set `ALLOWED_PATHS` to only the functions you need
- [ ] Implement `timeoutForPath` with appropriate values
- [ ] Forward `x-internal-secret` and `x-source-app` headers
- [ ] Return Core's response envelope unchanged
- [ ] Handle proxy-level errors with standard envelope
- [ ] Add `verify_jwt = false` in `config.toml` for core-proxy
- [ ] Test: allowed paths forward correctly
- [ ] Test: disallowed paths return `INVALID_PATH`
- [ ] Test: timeouts are applied correctly
- [ ] Test: no path remapping (unless legacy)
