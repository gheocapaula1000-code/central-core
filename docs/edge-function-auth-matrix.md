# Central Core V3 — Edge Function Auth Matrix

> Canonical security posture for each Edge Function.
> Every function with `verify_jwt = false` in `config.toml` MUST be listed here with its actual protection model.
> Last updated: 2026-03-31

---

## Legend

| Protection | Description |
|------------|-------------|
| **origin-policy** | `enforceOriginPolicy()` — rejects disallowed browser origins |
| **app-secret** | `requireSecret()` — per-app or legacy `AI_CORE_SECRET` via constant-time comparison |
| **diag-secret** | `requireDiagnosticSecret()` — `DIAGNOSTIC_SECRET` via constant-time comparison |
| **rate-limit** | In-memory caller-aware rate limiting |
| **input-val** | Body schema/field validation before processing |
| **envelope** | Standard `{ ok, data, warnings, debug_id, error }` response |
| **identity** | `X-Core-Version`, `X-Core-Function`, `X-Core-Route`, `X-Core-Contract` headers |
| **service-role** | Uses `SUPABASE_SERVICE_ROLE_KEY` internally (never exposed) |
| **safe-logging** | No secrets/tokens in logs; uses `redactSensitive()` where applicable |

---

## Function Matrix

| Function | `verify_jwt` | GET (public) | POST (protected) | Protections | Allowed Callers | Notes |
|----------|-------------|--------------|-------------------|-------------|-----------------|-------|
| **health** | `false` | `/`, `/manifest` | — | origin-policy, envelope, identity | Anyone | Minimal probe, no sensitive data |
| **ai-core-run** | `false` | `/health`, `/__health`, `/manifest`, `/metrics`¹, `/diagnostics`¹, `/__diagnostics/selftest`¹ | All POST routes | origin-policy, app-secret, rate-limit, input-val, envelope, identity, safe-logging | PWA proxies (Wyloni, KeyDraft, PRATICA) | ¹ Diagnostic routes require `diag-secret` |
| **sottra** | `false` | `/health`, `/manifest` | All `scan/*`, `forecast/*` routes | origin-policy, app-secret, input-val, envelope, identity | PWA proxies (Sottra, KeyDraft via gateway) | 16 POST routes |
| **ecosystem-gateway** | `false` | `/health`, `/__health`, `/manifest`, `/capabilities` | `/listing-enrichment`, `/service-pack`, `/unified-report` | origin-policy, app-secret, input-val, envelope, identity | PWA proxies, internal Core calls | Fail-safe partial results |
| **viral-core** | `false` | `/health`, `/__health`, `/manifest`, `/capabilities` | `/generate-bundle`, `/generate-single`, `/policy-check`, `/build-media-brief` | origin-policy, app-secret, input-val, envelope, identity | PWA proxies (Wyloni, Regiads) | OpenAI dependency |
| **listing-bridge** | `false` | `/health`, `/manifest`, `/status/:trace_id`² | `/ingest`, `/retry/:trace_id` | origin-policy, app-secret, input-val, envelope, identity, service-role | KeyDraft proxy, internal | ² GET /status requires app-secret |
| **omi-import** | `false` | — | `POST /` | origin-policy, app-secret, input-val, envelope, service-role | Admin/operator only | Data import, no PWA traffic |
| **omi-import-storage** | `false` | — | `POST /` | origin-policy, app-secret, input-val, envelope, service-role | Admin/operator only | Storage-based import |
| **istat-ispra-import** | `false` | — | `POST /` | origin-policy, app-secret, input-val, envelope, service-role | Admin/operator only | Statistical data import |
| **omi-geometry-import** | `false` | — | `POST /` | origin-policy, app-secret, input-val, envelope, service-role | Admin/operator only | Geometry import (GeoJSON/KML/KMZ) |
| **civiko-scheduler** | `false` | — | `POST /run-scheduled` | job-secret, envelope | Admin/manual only | Not a pg_cron target. Class A only. Refuses Class C. |
| **istat-sdmx-fetch** | `false` | — | `POST /` | origin-policy, job-secret **or** app-secret, envelope, service-role | `official-istat-sdmx` cron / admin | Writes `istat_comuni` |
| **padova-civici-ingest** | `false` | — | `POST /?action=ingest` | job-secret, envelope, service-role | `official-civici-*` cron / admin | Writes `padova_civici` |
| **cron-apify-immobiliare-nightly** | `false` | — | `POST /` | job-secret | `portal-immobiliare-padova` | Writes `padova_listings` |
| **cron-apify-idealista-nightly** | `false` | — | `POST /` | job-secret | `portal-idealista-padova` | Writes `padova_listings` |
| **cron-apify-subito-nightly** | `false` | — | `POST /` | job-secret | `portal-subito-padova` | Writes `padova_listings` |
| **cron-apify-casa-nightly** | `false` | — | `POST /` | job-secret | `portal-casa-padova` | Empty/skipped = 502, not fake success |
| **cron-apify-collect-pending** | `false` | — | `POST /` | job-secret | `portal-collect-pending` | Promotes Apify runs → `padova_listings` |

---

## Required Secret Dependencies

| Function | Required Secrets | Optional Secrets |
|----------|-----------------|-----------------|
| **health** | — | — |
| **ai-core-run** | `AI_CORE_SECRET` (or per-app) | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, `FIRECRAWL_API_KEY`, `DIAGNOSTIC_SECRET` |
| **sottra** | `AI_CORE_SECRET` (or per-app) | `GOOGLE_MAPS_API_KEY`, `MARKET_PROVIDER_*`, `STREET_EVIDENCE_ENABLED` |
| **ecosystem-gateway** | `AI_CORE_SECRET` (or per-app) | — |
| **viral-core** | `AI_CORE_SECRET` (or per-app) | `OPENAI_API_KEY` |
| **listing-bridge** | `AI_CORE_SECRET` (or per-app), `SUPABASE_SERVICE_ROLE_KEY` | — |
| **omi-import** | `AI_CORE_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` | — |
| **omi-import-storage** | `AI_CORE_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` | — |
| **istat-ispra-import** | `AI_CORE_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` | — |
| **omi-geometry-import** | `AI_CORE_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` | — |
| **civiko-scheduler** | `CENTRAL_CORE_JOB_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` | `AI_CORE_SECRET_CIVIKO` |
| **istat-sdmx-fetch** | `CENTRAL_CORE_JOB_SECRET` **or** `AI_CORE_SECRET_CIVIKO`, `SUPABASE_SERVICE_ROLE_KEY` | — |
| **padova-civici-ingest** | `CENTRAL_CORE_JOB_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` | — |

---

## Fail-Closed Behavior

All functions follow fail-closed:

- **Missing secret env var** → HTTP 500 `CONFIG_ERROR` (not silent pass-through)
- **Invalid/missing auth header** → HTTP 401 `APP_SECRET_REQUIRED` / `APP_SECRET_REJECTED`
- **Disallowed origin** → HTTP 403 `ORIGIN_NOT_ALLOWED`
- **Missing required body fields** → HTTP 400 with specific error code
- **Unmatched route** → HTTP 404 `ROUTE_NOT_FOUND`
- **Wrong HTTP method** → HTTP 405 `METHOD_NOT_ALLOWED`
- **Unhandled exception** → HTTP 500 `INTERNAL_ERROR` with debug_id (no stack trace)

---

## Audit Notes

- All functions use `verify_jwt = false` because auth is handled in-code via `requireSecret()` with constant-time comparison.
- `enforceOriginPolicy()` is applied before auth in all functions to reject disallowed browser origins early.
- No function accepts admin identity from client headers/body — admin checks use verified JWT only (`extractVerifiedEmail`).
- `omi-import`, `omi-import-storage`, `istat-ispra-import`, and `omi-geometry-import` are admin/operator tools, not exposed to PWA end-users.
