# Central Core V3 — Secrets & Rotation

> Inventory and rotation procedures for all secrets in the ecosystem.
> Last updated: 2026-03-20

---

## Secret Inventory

### Core Secrets (required)

| Secret | Purpose | Shared With | Rotation Impact |
|--------|---------|-------------|-----------------|
| `AI_CORE_SECRET_WYLONI` | Auth for Wyloni calls | Wyloni only | Wyloni-only update |
| `AI_CORE_SECRET_KEYDRAFT` | Auth for KeyDraft calls | KeyDraft only | KeyDraft-only update |
| `AI_CORE_SECRET_SOTTRA` | Auth for Sottra calls | Sottra only | Sottra-only update |
| `AI_CORE_SECRET_REGIADS` | Auth for Regiads calls | Regiads only | Regiads-only update |
| `AI_CORE_SECRET_PRATICA` | Auth for PRATICA calls | PRATICA only | PRATICA-only update |
| `AI_CORE_SECRET` | **Legacy** shared fallback (transitional) | All PWAs (if per-app not set) | All PWAs must update simultaneously |
| `DIAGNOSTIC_SECRET` | Auth for /metrics, /diagnostics, /selftest | Core admin only | Core-only update |
| `DIAGNOSTIC_SELFTEST_SECRET` | Legacy alias for diagnostic auth | Core admin only | Core-only update |

### Provider API Keys

| Secret | Purpose | Shared With | Rotation Impact |
|--------|---------|-------------|-----------------|
| `OPENAI_API_KEY` | OpenAI provider calls | Core only | Core-only, no PWA impact |
| `ANTHROPIC_API_KEY` | Anthropic fallback provider | Core only | Core-only, no PWA impact |
| `PERPLEXITY_API_KEY` | Perplexity web search tasks | Core only | Core-only, no PWA impact |
| `FIRECRAWL_API_KEY` | Web scraping via Firecrawl | Core only | Core-only, no PWA impact |
| `GOOGLE_MAPS_API_KEY` | Geocoding in Sottra | Core only | Core-only, no PWA impact |

### Infrastructure Secrets (managed by platform)

| Secret | Purpose | Notes |
|--------|---------|-------|
| `SUPABASE_URL` | Database/function base URL | Auto-managed |
| `SUPABASE_ANON_KEY` | Public anon key | Auto-managed |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin access | Never exposed client-side |
| `SUPABASE_DB_URL` | Direct DB connection | Never exposed |

### Configuration Secrets

| Secret | Purpose | Format |
|--------|---------|--------|
| `CORE_ALLOWED_ORIGINS` | CORS allowlist | Comma-separated URLs or `*` |
| `AI_CORE_ADMIN_EMAILS` | Admin access list | Comma-separated emails |
| `OPENAI_MODEL` | Model override | Model name (default: gpt-5.4) |
| `MARKET_DATA_ENABLED` | Market data toggle | `true`/`false` |
| `GEO_PROVIDER_ORDER` | Geocoding priority | Comma-separated provider names |
| `STREET_EVIDENCE_ENABLED` | Street evidence toggle | `true`/`false` |

---

## Rotation Procedures

### Per-App Secrets (Recommended — reduced blast radius)

Each PWA has its own secret (`AI_CORE_SECRET_WYLONI`, etc.). Rotation affects only the single PWA.

1. **Generate** new secret value (min 32 chars, alphanumeric + symbols)
2. **Update Central Core** — Set new value for `AI_CORE_SECRET_<APP>` in Lovable Cloud vault
3. **Update the specific PWA** — Set new value in the PWA's Lovable Cloud vault
4. **Verify** — Run auth smoke test from the updated PWA:
   ```bash
   curl -s -X POST "$PWA_URL/functions/v1/core-proxy/ai-core-run/health" | jq .data.status
   ```
5. **Confirm** old secret no longer works

**Recommended cadence:** Quarterly

### AI_CORE_SECRET (Legacy — coordinated rotation)

**This is the legacy shared secret. Migrate to per-app secrets to avoid coordinated rotation.**

1. **Generate** new secret value (min 32 chars, alphanumeric + symbols)
2. **Communicate** rotation window to all PWA teams
3. **Update Core** — Set new value in Lovable Cloud vault
4. **Update all PWAs simultaneously:**
   - Wyloni
   - KeyDraft
   - Sottra
   - PRATICA
   - Regiads (when active)
5. **Verify** — Run auth smoke test from each PWA
6. **Confirm** old secret no longer works (immediate, no grace period)

**Recommended cadence:** Quarterly

### DIAGNOSTIC_SECRET (Core-only)

1. Generate new value
2. Update in Core Lovable Cloud vault
3. Update admin dashboard configuration if stored
4. Verify: `curl -H "x-diagnostic-secret: $NEW_SECRET" .../ai-core-run/metrics`

**Recommended cadence:** Quarterly

### Provider API Keys (Core-only)

1. Generate new key from provider dashboard (OpenAI, Anthropic, etc.)
2. Update in Core Lovable Cloud vault
3. Verify via diagnostics endpoint
4. No PWA notification needed

**Recommended cadence:** Annually or on compromise

---

## Security Rules

1. **Never** store secret values in code, git, or client-side storage
2. **Never** log secret values — use `redactSensitive()` for any logged string
3. **Never** include secrets in error messages or API responses
4. **Never** expose `CORE_ALLOWED_ORIGINS` or `AI_CORE_ADMIN_EMAILS` in public responses
5. **Always** use constant-time comparison (`constantTimeEqual`) for secret validation
6. **Always** use `.env.example` with placeholder names, never real values
7. Secrets are stored **exclusively** in Lovable Cloud vault or Supabase secrets
