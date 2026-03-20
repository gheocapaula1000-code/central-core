# Central Core V3 — Release Pipeline & Operations

> Last updated: 2026-03-20

---

## Pre-Deploy Verification

Every change must pass the verification pipeline before merge/deploy:

```bash
npm run verify
```

This runs (in order):
1. `npm run lint` — ESLint checks
2. `npm run build` — TypeScript + Vite build
3. `npm test` — Full Vitest test suite

### Minimum Pass Criteria

| Check | Required |
|-------|----------|
| Lint | 0 errors (warnings tolerated) |
| Build | Exit code 0 |
| Tests | All pass, 0 failures |
| Contract tests | All pass (prevents PWA regressions) |

---

## Edge Function Deployment

Edge Functions deploy **automatically** when code is pushed. No manual deploy step.

### Deployment Order

1. `_shared/http.ts` changes affect ALL functions — extra caution required
2. Individual function changes only affect that function
3. `config.toml` changes take effect on next deploy

---

## Smoke Tests (Post-Deploy)

After each deploy, verify core functionality:

### Automated (via selftest)

```bash
# Requires DIAGNOSTIC_SECRET
curl -s -H "x-diagnostic-secret: $DIAGNOSTIC_SECRET" \
  "$CORE_URL/functions/v1/ai-core-run/__diagnostics/selftest"
```

Expected: `{ "ok": true, "data": { "overall": "PASS" } }`

### Manual Quick Check

```bash
# 1. Health check (all functions)
curl -s "$CORE_URL/functions/v1/health" | jq .data.status
# Expected: "healthy"

curl -s "$CORE_URL/functions/v1/ai-core-run/health" | jq .data.status
# Expected: "ok"

curl -s "$CORE_URL/functions/v1/sottra/health" | jq .data.status
# Expected: "healthy"

curl -s "$CORE_URL/functions/v1/viral-core/health" | jq .data.status
# Expected: "healthy"

curl -s "$CORE_URL/functions/v1/ecosystem-gateway/health" | jq .data.status
# Expected: "healthy"

# 2. Manifest check (verify version)
curl -s "$CORE_URL/functions/v1/ai-core-run/manifest" | jq .data.version
# Expected: "3.3.1"

# 3. Auth check (should fail without secret)
curl -s -X POST "$CORE_URL/functions/v1/ai-core-run" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"test"}' | jq .error.code
# Expected: "APP_SECRET_REQUIRED"
```

---

## Rollback Procedure

1. **Identify the issue** via health endpoints or error logs
2. **Revert** to the last known-good commit in the Lovable editor
3. Edge Functions redeploy automatically on revert
4. **Verify** rollback with smoke tests above
5. **Communicate** to PWA teams if the issue affected stable routes

### What Cannot Be Rolled Back

- Database migrations (schema changes are forward-only)
- Secret rotations (must be re-synced manually)

---

## Contract Test Coverage

Contract tests prevent silent regressions against PWA clients:

| Test File | Covers |
|-----------|--------|
| `wyloni-contract.test.ts` | Wyloni → ai-core-run paths, tasks, envelope |
| `keydraft-contract.test.ts` | KeyDraft → ai-core-run paths, envelope |
| `pratica-contract.test.ts` | PRATICA → ai-core-run paths, tasks |
| `sottra-contract.test.ts` | Sottra scan/forecast paths, envelope |
| `ecosystem-gateway-contract.test.ts` | Gateway routes, envelope, fail-safe |
| `viral-core-contract.test.ts` | Viral Core routes, envelope, policy |
| `compatibility-contract.test.ts` | Cross-cutting compatibility |

---

## Monitoring

### Health Endpoints (no auth)

| URL | Function |
|-----|----------|
| `GET /functions/v1/health` | Global health |
| `GET /functions/v1/ai-core-run/health` | AI router |
| `GET /functions/v1/sottra/health` | Building scanner |
| `GET /functions/v1/viral-core/health` | Content engine |
| `GET /functions/v1/ecosystem-gateway/health` | Orchestrator |

### Diagnostic Endpoints (requires DIAGNOSTIC_SECRET)

| URL | Function |
|-----|----------|
| `GET /functions/v1/ai-core-run/metrics` | Provider call metrics |
| `GET /functions/v1/ai-core-run/diagnostics` | Live provider ping |
| `GET /functions/v1/ai-core-run/__diagnostics/selftest` | Full selftest |
