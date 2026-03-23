# Central Core V3 — Diagnostics Usage Guide

> Last updated: 2026-03-22

---

## Overview

Central Core V3 exposes three tiers of observability endpoints:

| Tier | Auth Required | Purpose |
|------|---------------|---------|
| Health | None | Uptime monitoring, load balancer probes |
| Metrics/Diagnostics | `DIAGNOSTIC_SECRET` | Provider stats, live pings |
| Selftest | `DIAGNOSTIC_SECRET` | Full integrity validation |

---

## Health Endpoints (Public, No Auth)

All core functions expose a `GET /health` route:

```
GET /functions/v1/health              → { status: "healthy" }
GET /functions/v1/ai-core-run/health  → { status: "ok" }
GET /functions/v1/sottra/health       → { status: "healthy" }
GET /functions/v1/viral-core/health   → { status: "healthy" }
GET /functions/v1/ecosystem-gateway/health → { status: "healthy" }
GET /functions/v1/listing-bridge/health    → { status: "healthy" }
```

**Note**: `ai-core-run` returns `status: "ok"` (not `"healthy"`) for backward compatibility with existing PWA clients.

All health responses include identity headers:
- `X-Core-Version` — current semver
- `X-Core-Function` — function name
- `X-Core-Route` — route identifier
- `X-Core-Contract` — `central-core-v3`

---

## Diagnostic Endpoints (Requires DIAGNOSTIC_SECRET)

### Metrics

```bash
curl -H "x-diagnostic-secret: $DIAGNOSTIC_SECRET" \
  "$CORE_URL/functions/v1/ai-core-run/metrics"
```

Returns provider call counts, latencies, and error rates.

### Diagnostics (Live Ping)

```bash
curl -H "x-diagnostic-secret: $DIAGNOSTIC_SECRET" \
  "$CORE_URL/functions/v1/ai-core-run/diagnostics"
```

Performs live connectivity checks against configured providers.

### Selftest

```bash
curl -H "x-diagnostic-secret: $DIAGNOSTIC_SECRET" \
  "$CORE_URL/functions/v1/ai-core-run/__diagnostics/selftest"
```

Full integrity check: envelope validation, rate-limit isolation, logging sanity. Returns `{ overall: "PASS" }` or detailed failures.

---

## Manifest Endpoints (Public)

Every function exposes `GET /manifest` for service discovery:

```bash
curl "$CORE_URL/functions/v1/ai-core-run/manifest"
```

Returns: contract, version, routes, serviceKind, callingMode, expectedBasePath.

---

## Failure Modes

| Symptom | Likely Cause | Check |
|---------|-------------|-------|
| Health returns non-200 | Function crashed or env misconfigured | Check edge function logs |
| `CONFIG_ERROR` 500 | Required secret not set | Verify `AI_CORE_SECRET` / `DIAGNOSTIC_SECRET` |
| `PROVIDER_ERROR` 502 | All AI providers down or misconfigured | Check provider API keys, run diagnostics |
| `ORIGIN_NOT_ALLOWED` 403 | Client origin not in allowlist | Verify `CORE_ALLOWED_ORIGINS` |
| Partial gateway results | Individual module timeout | Check warnings array in response |
| `DIAGNOSTIC_SECRET_REQUIRED` 401 | Missing diagnostic auth header | Include `x-diagnostic-secret` header |

---

## Environment Variables (Expected)

| Variable | Required | Purpose |
|----------|----------|---------|
| `AI_CORE_SECRET_WYLONI` | Yes* | Per-app auth for Wyloni |
| `AI_CORE_SECRET_KEYDRAFT` | Yes* | Per-app auth for KeyDraft |
| `AI_CORE_SECRET_SOTTRA` | Yes* | Per-app auth for Sottra |
| `AI_CORE_SECRET_REGIADS` | Yes* | Per-app auth for Regiads |
| `AI_CORE_SECRET_PRATICA` | Yes* | Per-app auth for PRATICA |
| `AI_CORE_SECRET` | Transitional | Legacy shared fallback (deprecated) |
| `DIAGNOSTIC_SECRET` | Yes | Auth for diagnostic endpoints |
| `OPENAI_API_KEY` | Yes | Primary AI provider |
| `ANTHROPIC_API_KEY` | Yes | Fallback AI provider |
| `PERPLEXITY_API_KEY` | Yes | Web search provider |
| `CORE_ALLOWED_ORIGINS` | No | Additional allowed origins (comma-separated) |
| `CORE_ADMIN_BOOTSTRAP_EMAILS` | No | Server-side admin/owner allowlist (JWT-verified) |
| `MARKET_DATA_ENABLED` | No | Enable/disable market data in Sottra |

*Per-app secrets are required. If not set, falls back to legacy `AI_CORE_SECRET` with deprecation warning.

**Note**: All secrets are managed via the platform vault. Never hardcode values.
**Admin access**: Admin privileges are derived exclusively from verified JWT + `CORE_ADMIN_BOOTSTRAP_EMAILS`. No client-side input can grant admin status.
