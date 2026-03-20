# Central Core V3 — Backup & Restore Checklist

> Recovery procedures for Central Core infrastructure.
> Last updated: 2026-03-20

---

## What Needs Backup

| Asset | Location | Backup Method | Frequency |
|-------|----------|---------------|-----------|
| Edge Function code | Git repository | Git history | Every commit |
| Database tables | Lovable Cloud | Platform automatic backups | Daily |
| Secrets | Lovable Cloud vault | Manual documentation (names only, not values) | On change |
| Configuration | `supabase/config.toml` | Git history | Every commit |
| Documentation | `/docs/` | Git history | Every commit |

---

## Code Rollback

### Via Git
```bash
git log --oneline -10          # Find last known-good commit
git revert HEAD                # Revert last commit (preferred)
# OR
git reset --hard <commit>      # Hard reset (destructive, use with caution)
```

### Via Lovable
1. Open project in Lovable
2. Navigate to version history
3. Restore to the desired version
4. Verify deployment completes

---

## Post-Restore Verification

### 1. Health Checks
```bash
CORE_URL="https://jpunnzgixcghuydstdlt.supabase.co"

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
```

### 2. Version Verification
```bash
curl -s "$CORE_URL/functions/v1/ai-core-run/manifest" | jq .data.version
# Must match expected version
```

### 3. Auth Verification
```bash
# Should fail without secret
curl -s -X POST "$CORE_URL/functions/v1/ai-core-run" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"test"}' | jq .error.code
# Expected: "APP_SECRET_REQUIRED"
```

### 4. Secret Verification
- Confirm all secrets are present and correct in Lovable Cloud
- Test diagnostic endpoint with DIAGNOSTIC_SECRET
- Test a protected POST endpoint with AI_CORE_SECRET

### 5. PWA Connectivity
- Each PWA team runs their smoke test suite
- Verify proxy connectivity from each client app

---

## Database Restore

Database backups are managed by the platform. If a restore is needed:

1. Contact platform support for point-in-time recovery
2. After restore, verify table integrity:
   - `omi_valori` — OMI pricing data
   - `omi_zone` — OMI zone data
   - `omi_zone_geometry` — Geographic data
   - `istat_comuni` — ISTAT demographic data
   - `ispra_rischio` — Risk data
   - `classificazione_sismica` — Seismic classification
   - `mim_schools` — School data
3. Run data integrity checks (row counts, sample queries)

---

## Secret Rotation After Restore

If secrets were potentially compromised during an incident:

1. Generate new values for affected secrets
2. Update in Lovable Cloud vault
3. Update in all PWA projects that share the secret
4. Verify with auth smoke tests
5. Document rotation in incident log
