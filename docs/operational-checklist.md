# Central Core V3 — Operational Checklist

> Cross-PWA operational standards for deploy, verification, and upgrade coordination.
> Last updated: 2026-03-20

---

## Pre-Deploy (Core side)

- [ ] All tests pass: `npm run verify` (lint + build + test)
- [ ] Contract tests pass (no PWA regressions)
- [ ] No new secrets required without documentation
- [ ] Changelog updated (`docs/changelog.md`)
- [ ] If MINOR/MAJOR bump: version updated in `_shared/http.ts`
- [ ] If breaking change: 30-day deprecation notice added

---

## Post-Deploy Smoke Tests (Core side)

### Automated

```bash
curl -s -H "x-diagnostic-secret: $DIAGNOSTIC_SECRET" \
  "$CORE_URL/functions/v1/ai-core-run/__diagnostics/selftest"
# Expected: { "ok": true, "data": { "overall": "PASS" } }
```

### Health checks (all functions)

| Function | URL | Expected |
|----------|-----|----------|
| health | `GET /functions/v1/health` | `status: "healthy"` |
| ai-core-run | `GET /functions/v1/ai-core-run/health` | `status: "ok"` |
| sottra | `GET /functions/v1/sottra/health` | `status: "healthy"` |
| viral-core | `GET /functions/v1/viral-core/health` | `status: "healthy"` |
| ecosystem-gateway | `GET /functions/v1/ecosystem-gateway/health` | `status: "healthy"` |

### Version verification

```bash
curl -s "$CORE_URL/functions/v1/ai-core-run/manifest" | jq .data.version
# Must match expected version (e.g. "3.3.5")
```

### Auth verification

```bash
# Should fail without secret
curl -s -X POST "$CORE_URL/functions/v1/ai-core-run" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"test"}' | jq .error.code
# Expected: "APP_SECRET_REQUIRED"
```

---

## PWA Client Verification (after Core deploy)

Each PWA team should run these checks after a Core deploy:

### Quick smoke

```bash
# Via core-proxy (from PWA's Supabase)
curl -s "$PWA_URL/functions/v1/core-proxy/ai-core-run/health" | jq .data.status
# Expected: "ok"

# Version check
curl -s "$PWA_URL/functions/v1/core-proxy/ai-core-run/manifest" | jq .data.version
# Should match expected Core version
```

### Functional check

Run the PWA's existing integration/e2e tests. At minimum:
- [ ] Primary AI task succeeds (e.g., `search_grants` for Wyloni)
- [ ] Document analysis works (if used)
- [ ] Envelope shape is correct (`ok`, `data`, `warnings`, `debug_id`)
- [ ] Identity headers present (`X-Core-Version`)

---

## Coordinated Upgrade Process

### PATCH release (e.g. 3.3.4 → 3.3.5)

1. Core deploys automatically
2. No PWA changes needed
3. PWAs verify via health/manifest endpoints
4. Done

### MINOR release (e.g. 3.3.x → 3.4.0)

1. Core publishes changelog with new features/routes
2. PWAs update `ALLOWED_PATHS` if they want new routes
3. PWAs update timeout config if new routes have different expectations
4. PWAs verify existing flows still work
5. PWAs adopt new features at their own pace

### MAJOR release (e.g. 3.x → 4.0.0)

1. Core publishes changelog with breaking changes + migration guide
2. **30-day deprecation window** — old routes still work with warnings
3. PWAs update during the window:
   - Update request shapes
   - Update response parsing
   - Update proxy path allowlist
4. Core removes deprecated routes after window
5. All PWAs verify

---

## Incident Response

### Core is down

1. PWA proxies return `502 CORE_UNREACHABLE` — this is expected
2. Core team checks Edge Function logs
3. Rollback to last known-good commit if needed
4. Notify PWA teams via shared channel

### Secret rotation

1. Generate new `AI_CORE_SECRET` value
2. Update in Core Supabase secrets
3. Update in ALL PWA Supabase secrets **simultaneously**
4. Verify with auth smoke test
5. Old secret stops working immediately — coordinate timing

### PWA reports unexpected errors

1. Check `debug_id` in the error response
2. Search Core Edge Function logs for that `debug_id`
3. Check `X-Core-Version` header — is the PWA hitting the expected version?
4. Check `X-Core-Function` — is routing correct?

---

## Compatibility Matrix

| PWA | Functions Used | Min Core Version | Last Verified |
|-----|---------------|-----------------|---------------|
| Wyloni | ai-core-run, viral-core | 3.3.1 | 2026-03-20 |
| KeyDraft | ai-core-run | 3.0.0 | 2026-03-20 |
| Sottra | sottra | 3.3.1 | 2026-03-20 |
| PRATICA | ai-core-run | 3.0.0 | 2026-03-20 |

Update this table when adding new PWA integrations or verifying after upgrades.

---

## Monitoring Cadence

| Check | Frequency | Who |
|-------|-----------|-----|
| Health endpoints | Every deploy + daily | Core team |
| Contract tests | Every PR | Automated (CI) |
| Cross-PWA smoke | After MINOR/MAJOR | Each PWA team |
| Secret rotation | Quarterly (recommended) | Core team + all PWAs |
| Dependency audit | Monthly | Core team |
