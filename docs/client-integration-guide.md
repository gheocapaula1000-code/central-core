# Central Core V3 — Client Integration Guide

> How PWA clients (Wyloni, KeyDraft, Sottra, etc.) should call Central Core.
> Last updated: 2026-03-20

---

## Architecture Overview

```
PWA Client (Wyloni / KeyDraft / Sottra)
  → core-proxy (local Edge Function in each PWA)
    → Central Core V3 (this repo)
      → ai-core-run    (AI orchestration)
      → sottra          (building scanner)
      → viral-core      (content generation, via proxy only)
      → ecosystem-gateway (optional orchestrator)
      → health          (health check)
```

Each PWA has its own `core-proxy` Edge Function that:
1. Receives requests from the PWA frontend
2. Injects `AI_CORE_SECRET` as `x-internal-secret`
3. Forwards to Central Core
4. Returns the response to the frontend

---

## Base URL

```
https://<CENTRAL_CORE_SUPABASE_URL>/functions/v1/<function-name>
```

The Central Core base URL is configured as `CENTRAL_CORE_BASE_URL` in each PWA's secrets.

---

## Authentication

### Per-App Secrets (recommended)

Each PWA should use its own dedicated secret for reduced blast radius:

| PWA | Secret Name | Vault Location |
|-----|-------------|----------------|
| Wyloni | `AI_CORE_SECRET_WYLONI` | PWA vault |
| KeyDraft | `AI_CORE_SECRET_KEYDRAFT` | PWA vault |
| Sottra | `AI_CORE_SECRET_SOTTRA` | PWA vault |
| Regiads | `AI_CORE_SECRET_REGIADS` / `INTERNAL_CORE_API_KEY` | PWA vault |
| PRATICA | `AI_CORE_SECRET_PRATICA` | PWA vault |

The legacy shared `AI_CORE_SECRET` is still accepted as a **transitional fallback** but will be deprecated. Migrate to per-app secrets as soon as possible.

### Required Headers

All POST routes require authentication via one of these headers (checked in order):

| Priority | Header | Notes |
|----------|--------|-------|
| 1 | `x-internal-secret: <SECRET>` | **Preferred** — used by core-proxy |
| 2 | `x-app-secret: <SECRET>` | Legacy alias |
| 3 | `x-core-secret: <SECRET>` | Legacy alias |
| 4 | `Authorization: Bearer <SECRET>` | Bearer prefix stripped |

### Required: `x-source-app`

The `x-source-app` header is **required** for per-app secret resolution and will become **mandatory** in a future release. Set it to your app identifier (e.g., `wyloni`, `keydraft`, `sottra`, `regiads`, `pratica`).

### No Auth Required

GET routes (`/health`, `/manifest`, `/capabilities`) are public — no secret needed.

---

## Standard Request Format

```http
POST /functions/v1/ai-core-run HTTP/1.1
Host: <central-core-supabase-url>
Content-Type: application/json
x-internal-secret: <AI_CORE_SECRET>
apikey: <SUPABASE_ANON_KEY>
x-source-app: wyloni

{
  "domain": "wyloni_bandi",
  "task": "search_grants",
  "prompt": "...",
  "input": {}
}
```

### Required Headers

| Header | Required | Purpose |
|--------|----------|---------|
| `Content-Type: application/json` | Yes | Always JSON |
| `x-internal-secret` | Yes (POST) | Authentication (per-app or legacy secret) |
| `apikey` | Yes | Supabase gateway routing |
| `x-source-app` | **Required** | Identifies calling PWA for per-app secret resolution |

---

## Standard Response Envelope

### Success (HTTP 200)

```json
{
  "ok": true,
  "data": { ... },
  "warnings": [],
  "debug_id": "a1b2c3d4e5f6"
}
```

### Error (HTTP 4xx/5xx)

```json
{
  "ok": false,
  "data": null,
  "warnings": [],
  "debug_id": "a1b2c3d4e5f6",
  "error": {
    "code": "UPPERCASE_SNAKE_CASE",
    "message": "Human-readable description"
  }
}
```

### Identity Headers (every response)

| Header | Example | Purpose |
|--------|---------|---------|
| `X-Core-Version` | `3.3.5` | Core version |
| `X-Core-Function` | `ai-core-run` | Which function responded |
| `X-Core-Route` | `health` | Which route handled the request |
| `X-Core-Contract` | `central-core-v3` | Contract identifier |
| `x-debug-id` | `a1b2c3d4e5f6` | Debug reference for logs |

---

## Error Codes Reference

| Code | HTTP | When |
|------|------|------|
| `APP_SECRET_REQUIRED` | 401 | Missing auth header |
| `APP_SECRET_REJECTED` | 401 | Invalid secret value |
| `ORIGIN_NOT_ALLOWED` | 403 | Browser origin not in allowlist |
| `MISSING_PROMPT` | 400 | No prompt in body |
| `INVALID_JSON` | 400 | Malformed JSON body |
| `PAYLOAD_TOO_LARGE` | 413 | Body > 500KB |
| `INVALID_DOMAIN` | 400 | Domain doesn't match `[a-z0-9_]+` |
| `INVALID_TASK` | 400 | Task doesn't match `[a-z0-9_]+` |
| `METHOD_NOT_ALLOWED` | 405 | Wrong HTTP method |
| `ROUTE_NOT_FOUND` | 404 | No handler for path |
| `RATE_LIMITED` | 429 | Too many requests |
| `PROVIDER_ERROR` | 502 | Upstream AI provider failure |
| `CONFIG_ERROR` | 500 | Server misconfiguration |
| `INTERNAL_ERROR` | 500 | Unhandled error (debug_id for reference) |

---

## Timeout & Retry Expectations

### Recommended Proxy Timeouts

| Function | Route | Suggested Timeout |
|----------|-------|------------------|
| `ai-core-run` | Generic POST | 45s |
| `ai-core-run` | `/documents/analyze` | 60s |
| `ai-core-run` | `/web/scrape` | 30s |
| `sottra` | Any scan/forecast | 30s |
| `viral-core` | `/generate-bundle` | 60s |
| `viral-core` | `/generate-single` | 45s |
| `viral-core` | `/policy-check` | 20s |
| `viral-core` | `/build-media-brief` | 20s |
| `ecosystem-gateway` | Any POST | 30s |

### Retry Policy

- **DO** retry on 5xx errors with exponential backoff (1s, 2s, 4s)
- **DO** retry on network timeouts (once)
- **DO NOT** retry on 4xx errors (client-side issue)
- **DO NOT** retry on 429 — respect `Retry-After` header

---

## Core-Proxy Setup (for new PWA clients)

### 1. ALLOWED_PATHS

In your PWA's `core-proxy/index.ts`, add the Central Core paths you need:

```typescript
const ALLOWED_PATHS = [
  "/ai-core-run",      // AI orchestration
  "/sottra",           // Building scanner
  "/viral-core",       // Content generation (if needed)
  // "/ecosystem-gateway" // Optional orchestrator
];
```

### 2. Path Forwarding

Paths are forwarded as-is (no remapping):

```
Client: POST /core-proxy/viral-core/generate-bundle
Proxy:  POST ${CENTRAL_CORE_BASE_URL}/functions/v1/viral-core/generate-bundle
```

Exception: legacy Wyloni paths may remap `/ai/run` → `/ai-core-run`.

### 3. Required Secrets

| Secret | Purpose |
|--------|---------|
| `CENTRAL_CORE_BASE_URL` | Central Core Supabase URL |
| `AI_CORE_SECRET_<APP>` | **Per-app secret** (e.g., `AI_CORE_SECRET_WYLONI`) |
| `AI_CORE_SECRET` | Legacy shared secret (**transitional** — migrate to per-app) |

---

## Version Upgrade Process

1. Check `GET /health` or `GET /manifest` for current version
2. Review [CHANGELOG](./changelog.md) for breaking changes
3. If MAJOR bump: update client code per migration notes, test in staging
4. If MINOR/PATCH bump: no client changes needed, deploy and verify

---

## CORS & Origin Policy

Central Core validates `Origin` headers for browser requests:

- **Allowed:** `*.lovable.app`, `*.lovableproject.com`, `*.lovable.dev`, `localhost`, configured origins via `CORE_ALLOWED_ORIGINS`
- **Trusted domains:** `keydraft.app`, `wyloni.app`, `sottra.app`
- **Server-to-server** (no Origin header): always allowed
- **Blocked origin:** returns 403 `ORIGIN_NOT_ALLOWED`

To add a new origin, update `CORE_ALLOWED_ORIGINS` in Central Core secrets (comma-separated).
