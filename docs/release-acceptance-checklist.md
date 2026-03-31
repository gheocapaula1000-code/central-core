# Central Core V3 — Release Acceptance Checklist

> Gate checklist before any release goes live.
> Every BLOCKER item must pass. No exceptions.
> Last updated: 2026-03-31

---

## Severity Levels

| Level | Meaning | Release Impact |
|-------|---------|----------------|
| **BLOCKER** | Release CANNOT ship. Must be fixed. | Hard gate — blocks deploy |
| **CRITICAL** | Serious risk. Must be fixed unless explicitly waived by owner with documented reason. | Soft gate — requires sign-off |
| **IMPORTANT** | Should be addressed. Acceptable to defer to next PATCH with tracking ticket. | Tracked deferral |
| **IMPROVEMENT** | Nice to have. Can defer indefinitely. | Informational |

---

## Pre-Release Gate

### Code Quality

| # | Check | Severity | Criterion |
|---|-------|----------|-----------|
| 1 | `npm run verify` passes | **BLOCKER** | Exit code 0 (lint + build + test) |
| 2 | Zero lint warnings | **BLOCKER** | `npx eslint . --max-warnings 0` exits 0 |
| 3 | TypeScript compiles | **BLOCKER** | `npx tsc --noEmit` exits 0 |
| 4 | All contract tests pass | **BLOCKER** | `npx vitest run` — 0 failures in `*-contract.test.ts` |
| 5 | All hardening tests pass | **BLOCKER** | `npx vitest run` — 0 failures in `hardening-*.test.ts` |
| 6 | Production build succeeds | **BLOCKER** | `npx vite build` exits 0 |
| 7 | No `console.log` of secret values in Edge Functions | **CRITICAL** | `grep -r "console.log.*SECRET\|console.log.*API_KEY" supabase/functions/` returns nothing |
| 8 | `redactSensitive()` used in diagnostic/log outputs | **IMPORTANT** | Manual review |

### Security

| # | Check | Severity | Criterion |
|---|-------|----------|-----------|
| 9 | No secrets in code or responses | **BLOCKER** | `bash scripts/verify-secrets.sh` exits 0 |
| 10 | All POST endpoints require `AI_CORE_SECRET` (or per-app) | **BLOCKER** | Verified via contract tests + code review |
| 11 | All diagnostic endpoints require `DIAGNOSTIC_SECRET` | **BLOCKER** | Verified via contract tests |
| 12 | Health endpoints return only non-sensitive data | **CRITICAL** | No version internals, no secrets, no allowlists |
| 13 | Error responses use safe envelope | **CRITICAL** | No stack traces, no internal paths in error messages |
| 14 | `enforceOriginPolicy` applied in all functions | **BLOCKER** | Verified via edge-function-auth-matrix.md + code review |
| 15 | No admin bypass from client input | **BLOCKER** | `isAdminBypassEmail` always returns false; admin only via verified JWT |

### Artifact Hygiene

| # | Check | Severity | Criterion |
|---|-------|----------|-----------|
| 16 | Package integrity passes | **BLOCKER** | `bash scripts/verify-package.sh` exits 0 |
| 17 | No `.env` in build output | **BLOCKER** | `find dist -name '.env*'` returns nothing |
| 18 | No localhost in build output | **CRITICAL** | `grep -rn 'localhost' dist/` returns nothing (excl. sourcemaps) |
| 19 | No dump/cache/temp files in repo root | **IMPORTANT** | No `*.dump`, `*.bak`, `*.tmp`, `*.log` in tracked files |

### Documentation

| # | Check | Severity | Criterion |
|---|-------|----------|-----------|
| 20 | `docs/changelog.md` updated | **BLOCKER** | Version, date, and changes listed |
| 21 | `docs/contract-registry.md` reflects current routes | **CRITICAL** | No stale routes or removed fields |
| 22 | `docs/edge-function-auth-matrix.md` current | **CRITICAL** | All functions listed with correct protections |
| 23 | `docs/client-compatibility-matrix.md` current | **IMPORTANT** | Updated if client dependencies changed |
| 24 | Version in `_shared/http.ts` matches changelog | **BLOCKER** | `CORE_VERSION` matches latest changelog entry |

### Backward Compatibility

| # | Check | Severity | Criterion |
|---|-------|----------|-----------|
| 25 | No removed fields in existing response shapes | **BLOCKER** | Contract tests pass |
| 26 | No renamed error codes | **BLOCKER** | Error code list in contract-registry unchanged |
| 27 | No changed HTTP status codes | **BLOCKER** | Existing error conditions return same status |
| 28 | No removed endpoints | **BLOCKER** | All routes in contract-registry still active |
| 29 | If MAJOR: deprecation notice sent ≥ 30 days ago | **BLOCKER** | Documented in changelog |

---

## Deploy

| # | Check | Severity |
|---|-------|----------|
| 30 | Deploy via Lovable (automatic Edge Function deployment) | **BLOCKER** |
| 31 | Wait for deployment confirmation | **BLOCKER** |

---

## Post-Deploy Verification

### Health Checks

| # | Check | Severity | Expected |
|---|-------|----------|----------|
| 32 | `GET /functions/v1/health` | **BLOCKER** | `status: "healthy"` |
| 33 | `GET /functions/v1/ai-core-run/health` | **BLOCKER** | `status: "ok"` |
| 34 | `GET /functions/v1/sottra/health` | **BLOCKER** | `status: "healthy"` |
| 35 | `GET /functions/v1/viral-core/health` | **BLOCKER** | `status: "healthy"` |
| 36 | `GET /functions/v1/ecosystem-gateway/health` | **BLOCKER** | `status: "healthy"` |

### Auth Verification

| # | Check | Severity | Expected |
|---|-------|----------|----------|
| 37 | POST without secret | **BLOCKER** | `APP_SECRET_REQUIRED` (401) |
| 38 | POST with wrong secret | **BLOCKER** | `APP_SECRET_REJECTED` (401) |
| 39 | POST with correct secret | **BLOCKER** | Success (200) |

### Diagnostics Verification

| # | Check | Severity | Expected |
|---|-------|----------|----------|
| 40 | `/metrics` without diagnostic secret | **CRITICAL** | 401 |
| 41 | `/__diagnostics/selftest` with correct secret | **CRITICAL** | `overall: "PASS"` |

### PWA Connectivity

| # | Check | Severity | Expected |
|---|-------|----------|----------|
| 42 | Wyloni proxy → Core health | **IMPORTANT** | OK |
| 43 | KeyDraft proxy → Core health | **IMPORTANT** | OK |
| 44 | Sottra proxy → Core health | **IMPORTANT** | OK |
| 45 | PRATICA proxy → Core health | **IMPORTANT** | OK |
| 46 | Regiads proxy → Core health | **IMPROVEMENT** | OK (when active) |

---

## Rollback Criteria

Rollback immediately if ANY of the following occur post-deploy:

| Trigger | Severity |
|---------|----------|
| Any health endpoint returns non-200 | **BLOCKER** |
| Contract test failures reported by PWA teams | **BLOCKER** |
| Auth smoke test fails | **BLOCKER** |
| Error rate spikes above baseline in first 15 minutes | **CRITICAL** |
| Multiple PWAs report simultaneous failures | **BLOCKER** |

---

## Release Verdict

**PASS** — All BLOCKER items green, all CRITICAL items green or explicitly waived.

**FAIL** — Any BLOCKER item red, or any CRITICAL item red without documented waiver.

---

## Sign-Off

| Role | Name | Date | Status |
|------|------|------|--------|
| Core team lead | | | ☐ Approved |
| Security review | | | ☐ Approved |
