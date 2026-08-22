# Central Core V3 — API Changelog

> Tracks all API-facing changes. Internal refactors without API impact are not listed.
> Format: [version] — date — summary

---

## [3.4.4] — 2026-08-22

### Sottra photoWow / scan/pricing — Padova 7-zone OMI report
- Polygon match on Core `omi_zone_geometry` now joins official `omi_zone` / `omi_valori` by unique comune+zona. Live Padova geometry uses synthetic keys (`G224-B1`) that do not exist in `omi_valori` (`PD00000015`); that miss previously discarded the real B1/C3 hit and published city-wide 650–4700.
- Padova reports use Paula's **7 display zones**: Centro (B1+B2), Stazione / Portello (C1+C2), Arcella (C3+D7), Est (D8+D4+E1), Ovest (C5+C6+D1+D2), Sud (D3+E3), Nord (D5+D6+R1). Display is `Centro (OMI B1)` plus that microzona's official NORMALE min/max — never an average of B1+B2, never city 650–4700.
- Official letters outside the cut (C4, E2, R2, R3) get no invented friendly name.
- `tutteZone` lists only the official members of the chosen area; sibling prices are not filled in.
- `comune_aggregate` remains fail-closed only when the point cannot be placed: no guessed area name, no city-wide min/max, no 18-zone list.
- Conservation-state pick prefers official `NORMALE` when several rows exist for the same zone.

### No Breaking Changes
- Civiko One, UERADAR, TrovaBandi untouched
- Energy / catasto / ANNCSU / listings still unavailable on photoWow
- No write to empty org project `egjvullvkwpzyyworeml`

---

## [3.4.3] — 2026-08-22

### Sottra photoWow — official OMI path
- Added `POST /sottra/scan/photo-wow` (aliases: `/photo-wow`, `/photoWow`) — photo+GPS report from Sottra engines (OMI / ISTAT / OSM). Fail-closed. Energy, catasto, listings stay unavailable/estimated, never official. No invented scores, sold comps, or exclusive pitch.
- Core `core-proxy` now forwards the live Sottra PWA alias `/civiko-property-from-photo` plus `/sottra/scan/identify`, `/sottra/scan/pricing`, `/sottra/health` to the Sottra function with `x-source-app: sottra`. Civiko One keeps calling `civiko-property-from-photo` **directly**.
- OMI: polygon match when Core has geometry; otherwise real `omi_zone` + `omi_valori` at comune level (`comune_aggregate`, labeled elaborated). Does not invent a microzona. Core `omi_zone_geometry` is a small sample, not the national ~27k set — no unsafe data copy.
- Internal Civiko→Sottra fan-out now sends `x-source-app: sottra` and maps `omiMatchMethod` / `sourcePeriod` / `sourceType`.
- CORS: `sottra.lovable.app` and other `*.lovable.app` previews remain allowed via the existing suffix rule.

### No Breaking Changes
- Civiko One `civiko-property-from-photo` contract and `requireCivikoCostSecret` unchanged
- Existing Sottra scan/forecast routes unchanged aside from pricing comune fallback

---

## [3.4.2] — 2026-03-31

### Hardened
- **omi-import**: added missing `enforceOriginPolicy` (was the only function without origin check)
- **Release acceptance checklist**: rewritten with BLOCKER/CRITICAL/IMPORTANT/IMPROVEMENT severity levels and explicit PASS/FAIL verdict
- **verify-package.sh**: now checks for junk files (*.dump, *.bak, *.tmp, etc.) and requires `edge-function-auth-matrix.md`
- **Edge function auth matrix**: new `docs/edge-function-auth-matrix.md` documenting security posture, required secrets, and allowed callers for all 10 functions

### Documentation
- Updated `docs/contract-registry.md` version refs from 3.3.5 to 3.4.2, added auth matrix cross-reference
- Updated `CORE_VERSION` in `_shared/http.ts` to 3.4.2

### Tests
- Added `src/test/hardening-release-grade.test.ts`: origin policy consistency across all functions, constant-time comparison verification, envelope contract stability, artifact hygiene, config.toml consistency, version alignment, secret safety

### No Breaking Changes
- All existing contracts, envelopes, paths, and error codes unchanged
- `omi-import` origin policy is additive security (operator calls already pass origin check)

---

## [3.4.1] — 2026-03-26

### Hardened
- `public/_headers`: added HSTS (2-year, includeSubDomains, preload), COOP, CORP, COEP, default `no-store` cache, immutable cache for `/assets/*`, expanded Permissions-Policy
- `index.html`: added `<noscript>` fallback, removed `author` meta (not needed for admin shell), deduplicated meta tags
- `src/main.tsx`: safe boot with chunk-mismatch detection, static recovery fallback with reload button, structured error logging
- CSP coherence enforced between `index.html` meta and `public/_headers`
- Tests added: HSTS, COOP/CORP, cache rules, boot safety, CSP coherence, noscript

### Documentation
- Updated `docs/secrets-and-rotation.md` with security headers reference
- Updated `docs/changelog.md`

---

## [3.4.0] — 2026-03-23

### Changed
- **Access model**: three-tier server-side governance replaces single admin allowlist
  - Tier 1 (Owner/Admin): `CORE_ADMIN_BOOTSTRAP_EMAILS` — only `gheocapaula1000@gmail.com`
  - Tier 2 (Cross-app bypass): `CORE_USER_BYPASS_EMAILS` — non-paying users, no admin
  - Tier 3 (Wyloni-only bypass): `CORE_WYLONI_BYPASS_EMAILS` — scoped to `x-source-app=wyloni`, no admin
- `massimilianogalli75@gmail.com` removed from admin allowlist (was never intended as owner)
- `checkBootstrapAdmin` now returns `{ isAdmin, isBypass, email }` (additive field, non-breaking)
- New export: `isServiceBypassUser(verifiedEmail, sourceApp)` in `_shared/http.ts`
- `CORE_USER_BYPASS_EMAILS` and `CORE_WYLONI_BYPASS_EMAILS` added to `redactSensitive` list

### Security
- Only `gheocapaula1000@gmail.com` can be owner/admin — no other account can be promoted
- Bypass users get rate-limit/quota bypass but zero admin capabilities
- Wyloni-only bypass requires verified `x-source-app=wyloni` (already auth'd via secret)
- No client-side input can elevate privileges

### No Breaking Changes
- All existing contracts, envelopes, paths, and error codes unchanged
- Legacy bypass no-ops preserved for import compatibility
- Rate limit bypass is additive — non-admin/non-bypass callers unaffected
- All PWA integrations (Wyloni, KeyDraft, Sottra, PRATICA, Regiads) fully compatible

---

## [3.3.6] — 2026-03-23

### Added
- **Bootstrap admin model**: server-side admin/owner identity via `CORE_ADMIN_BOOTSTRAP_EMAILS` secret
- `isBootstrapAdmin(verifiedEmail)` — checks verified email against server-side allowlist
- `extractVerifiedEmail(req)` — extracts email from verified Supabase JWT (never from client headers)
- `checkBootstrapAdmin(req)` — combined JWT extraction + admin check helper
- Rate limit bypass for verified bootstrap admins in `ai-core-run`
- `CORE_ADMIN_BOOTSTRAP_EMAILS` added to `redactSensitive` protection list

### Security
- Admin identity derived exclusively from verified JWT + server-side secret allowlist
- No client header, body, query string, localStorage, or unverified input can grant admin privileges
- Legacy `isAdminBypassEmail` and `checkAdminBypass` remain permanent no-ops

### No Breaking Changes
- All existing contracts, envelopes, paths, and error codes unchanged

---

## [3.3.5] — 2026-03-21

### Added
- **listing-bridge** Edge Function: isolated bridge module for KeyDraft→Sottra data transport
- Canonical schema v1.0 with versioning, validation, normalization, and transformation
- Job state machine: received → validated → transformed → delivered → imported | failed
- Idempotency via `trace_id` unique constraint and `listing_id + run_id` deduplication
- Retry endpoint with configurable max retries (3)
- `listing_bridge_jobs` table with RLS (service_role only)
- Contract test suite: `listing-bridge-contract.test.ts` (36 assertions)
- Documentation: `docs/listing-bridge.md`
- Listing-bridge paths added to OpenAPI summary
- Listing-bridge error codes added to contract registry

### Changed
- **listing-bridge**: Delivery target corrected from `sottra/scan/identify` to `sottra/scan/import` (semantically correct receiver)
- **listing-bridge**: Transform now carries ALL useful fields: `confidence_flags`, `freeform_notes`, `origin_map`, `source_environment`, `exported_at`, `listing_status`
- **listing-bridge**: Delivery includes `x-bridge-trace-id` header for end-to-end tracing
- **Versioning**: Aligned `package.json`, all docs, OpenAPI spec, contract registry, and operational docs to v3.3.5

### Notes
- KeyDraft and Sottra remain fully independent — no direct coupling
- Bridge is isolated: separate function, table, tests, and docs
- No existing contract, envelope, path, or error code was changed
- All shared infrastructure patterns (origin policy, identity headers, auth, envelope) reused consistently

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
