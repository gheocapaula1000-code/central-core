# Central Core V3 — Release Acceptance Checklist

> Gate checklist before any release goes live.
> Every item must pass. No exceptions for MAJOR/MINOR releases.
> Last updated: 2026-03-22

---

## Pre-Release Gate

### Code Quality
- [ ] `npm run verify` passes (lint + build + test)
- [ ] Zero lint warnings (`--max-warnings 0`)
- [ ] All contract tests pass (compatibility-contract, per-client contracts)
- [ ] All hardening tests pass (admin-fetch, origin-policy, registry, admin-gate)
- [ ] No `console.log` of secret values in Edge Functions
- [ ] `redactSensitive()` used in all diagnostic/log outputs that could contain user data

### Documentation
- [ ] `docs/changelog.md` updated with version, date, and changes
- [ ] `docs/contract-registry.md` reflects any new routes or fields
- [ ] `docs/client-compatibility-matrix.md` updated if client dependencies changed
- [ ] `docs/openapi-summary.yaml` updated if API surface changed
- [ ] Version in `_shared/http.ts` matches changelog

### Security
- [ ] No secrets in code or responses (check with `grep -r "API_KEY\|SECRET" supabase/functions/ --include="*.ts"`)
- [ ] All POST endpoints require `AI_CORE_SECRET`
- [ ] All diagnostic endpoints require `DIAGNOSTIC_SECRET`
- [ ] Health endpoints return only non-sensitive data
- [ ] Error responses use safe envelope (no stack traces, no internal paths)
- [ ] `enforceOriginPolicy` applied where required

### Backward Compatibility
- [ ] No removed fields in existing response shapes
- [ ] No renamed error codes
- [ ] No changed HTTP status codes for existing error conditions
- [ ] No removed endpoints
- [ ] If MAJOR: deprecation notice sent ≥ 30 days ago

---

## Deploy

- [ ] Deploy via Lovable (automatic Edge Function deployment)
- [ ] Wait for deployment confirmation

---

## Post-Deploy Verification

### Health Checks (all 5 functions)
- [ ] `GET /functions/v1/health` → `status: "healthy"`
- [ ] `GET /functions/v1/ai-core-run/health` → `status: "ok"`
- [ ] `GET /functions/v1/sottra/health` → `status: "healthy"`
- [ ] `GET /functions/v1/viral-core/health` → `status: "healthy"`
- [ ] `GET /functions/v1/ecosystem-gateway/health` → `status: "healthy"`

### Version Verification
- [ ] All manifest endpoints return correct version
- [ ] All `X-Core-Version` headers match expected version

### Auth Verification
- [ ] POST without secret returns `APP_SECRET_REQUIRED` (401)
- [ ] POST with wrong secret returns `APP_SECRET_REJECTED` (401)
- [ ] POST with correct secret succeeds

### Diagnostics Verification
- [ ] `/metrics` without diagnostic secret returns 401
- [ ] `/diagnostics` without diagnostic secret returns 401
- [ ] `/__diagnostics/selftest` returns `overall: "PASS"` with correct secret

### PWA Connectivity
- [ ] Wyloni proxy → Core health returns OK
- [ ] KeyDraft proxy → Core health returns OK
- [ ] Sottra proxy → Core health returns OK
- [ ] PRATICA proxy → Core health returns OK
- [ ] Regiads proxy → Core health returns OK (when active)

---

## Rollback Criteria

Rollback immediately if any of the following occur post-deploy:
- Any health endpoint returns non-200
- Contract test failures reported by PWA teams
- Auth smoke test fails
- Error rate spikes above baseline in first 15 minutes
- Multiple PWAs report simultaneous failures

---

## Sign-Off

| Role | Name | Date | Status |
|------|------|------|--------|
| Core team lead | | | ☐ Approved |
| Security review | | | ☐ Approved |
