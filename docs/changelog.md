# Central Core V3 — API Changelog

> Tracks all API-facing changes. Internal refactors without API impact are not listed.
> Format: [version] — date — summary

---

## [3.3.4] — 2026-03-21

### Added
- **Admin bypass utility** in `_shared/http.ts`: `normalizeEmail`, `isAdminBypassEmail`, `checkAdminBypass`
- Exact-match allowlist for 2 infrastructure admin accounts — no wildcard, no domain match
- `checkAdminBypass` reads `x-user-email` header and body fields, returns masked email for safe logging
- 12 new contract tests in `hardening-admin-bypass.test.ts` covering exact match, false positives, edge cases

### Notes
- Current auth model is secret-based (`requireSecret`). The bypass utility is available for any future subscription/entitlement gate.
- No existing contract, envelope, path, or error code was changed.

---

## [3.3.3] — 2026-03-20

### Hardened
- **ai-core-run**: Added `enforceOriginPolicy` at top level — now consistent with all other protected functions
- **ai-core-run**: All responses (POST success, POST errors, rate-limit 429, diagnostics) now include identity headers via `withIdentity`
- **ai-core-run**: Removed redundant per-section `enforceOriginPolicy` calls (metrics, diagnostics, selftest) — origin policy is now enforced once at the top
- All 5 functions now use identical `withIdentity(res, route)` pattern for every response path

### Added
- Infrastructure consistency tests: origin policy ordering (G), intentional asymmetries documentation (H)
- 14 new structural assertions documenting the `withIdentity` wrapping invariant and intentional differences

### No Breaking Changes
- `ai-core-run` health status remains `"ok"` (backward compat with Wyloni, KeyDraft, PRATICA)
- All existing paths, envelope shapes, and error codes unchanged
- `ai-core-run` body limit remains 100KB (others 500KB) — intentional, documented

---

## [3.3.2] — 2026-03-20

### Hardened
- **sottra**: Added `enforceOriginPolicy` — consistent with ecosystem-gateway, viral-core, ai-core-run
- **sottra**: Error responses (auth, method, JSON, 404, 500) now include identity headers via `withIdentity`
- **ai-core-run**: Auth rejection and catch-all error responses now include identity headers
- All functions now uniformly wrap error responses with `X-Core-Version`, `X-Core-Function`, `X-Core-Route`, `X-Core-Contract`

### Added
- Infrastructure consistency test suite (`hardening-infra-consistency.test.ts`)
- Cross-function validation: identity headers, error codes, origin policy, health status, manifest contract, body limits

### No Breaking Changes
- `ai-core-run` health status remains `"ok"` (not `"healthy"`) for backward compat with Wyloni, KeyDraft, PRATICA
- All existing paths, envelope shapes, and error codes unchanged

---

## [3.3.1] — 2026-03-17

### Added
- **viral-core** Edge Function: `/generate-bundle`, `/generate-single`, `/policy-check`, `/build-media-brief`
- **ecosystem-gateway** Edge Function: `/listing-enrichment`, `/service-pack`, `/unified-report`
- Identity headers (`X-Core-Version`, `X-Core-Function`, `X-Core-Route`, `X-Core-Contract`) on all responses including errors
- `GET /manifest` endpoint on all functions
- `GET /capabilities` endpoint on ecosystem-gateway and viral-core
- `enforceOriginPolicy` — validates browser Origin headers
- `DIAGNOSTIC_SECRET` for protected diagnostics endpoints
- `scan/market` — commercial market data with provider adapter
- `forecast/sviluppo-area` — area development with school context
- `forecast/convergenza-territoriale` — ICTV territorial convergence
- Backward-compat aliases in `comparablesSummary` (count, q1/q3, marketDepth, marketFreshnessLabel)
- `marketSignalsList` flat array format

### Changed
- Auth now accepts `x-internal-secret`, `x-app-secret`, `x-core-secret`, `Authorization Bearer` (in priority order)
- Rate limiter: caller-aware, tiered (trusted 300/min, public 30/min, diagnostics 10/min)
- Error responses now include identity headers consistently

### Security
- No stack traces in error payloads
- Origin allowlist enforcement on all functions
- Constant-time secret comparison

---

## [3.0.0] — 2026-01-15

### Added
- Initial Central Core V3 release
- `ai-core-run`: OpenAI → Anthropic fallback, Perplexity for web search
- `sottra`: Building scanner (scan + forecast endpoints)
- `health`: Standalone health check
- Standard envelope format (`ok`, `data`, `warnings`, `debug_id`, `error`)
- Pipeline architecture: `wyloni_bandi`, `keydraft_realestate`, `pratica_legal`
