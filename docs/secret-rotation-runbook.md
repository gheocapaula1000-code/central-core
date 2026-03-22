# Central Core V3 — Secret Rotation Runbook

> Step-by-step procedure for rotating `AI_CORE_SECRET` across the ecosystem.
> Last updated: 2026-03-20

---

## Overview

`AI_CORE_SECRET` is shared between Central Core and all PWA clients (Wyloni, Sottra, KeyDraft, PRATICA, Regiads). Rotation requires coordinated updates to avoid authentication failures.

**Estimated downtime:** Zero if executed correctly (sequential update).
**Recommended cadence:** Quarterly or on compromise.

---

## Pre-Rotation Checklist

- [ ] Confirm all PWA teams are aware of the rotation window
- [ ] Generate new secret (min 32 chars, alphanumeric + symbols)
- [ ] Verify current health status on all clients before starting
- [ ] Have rollback plan ready (old secret value saved securely)

---

## Step-by-Step Procedure

### Step 1 — Generate New Secret

```bash
# Generate a secure random secret (64 chars)
openssl rand -base64 48 | tr -d '\n'
```

Store the new value securely. Do NOT share via chat, email, or code.

### Step 2 — Update Central Core

1. Open Central Core project in Lovable
2. Update `AI_CORE_SECRET` in the project vault
3. Wait for edge functions to redeploy (~30s)

### Step 3 — Verify Core Health

```bash
curl -s https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/health | jq .
```

Expected: `{ "ok": true, ... }`

### Step 4 — Update Each Client (one by one)

Update `AI_CORE_SECRET` (or equivalent secret name) in each PWA project vault:

| # | Client | Secret Name | Vault Location |
|---|--------|-------------|----------------|
| 1 | Wyloni | `AI_CORE_SECRET` | Lovable Cloud vault |
| 2 | KeyDraft | `AI_CORE_SECRET` | Lovable Cloud vault |
| 3 | Sottra | `AI_CORE_SECRET` | Lovable Cloud vault |
| 4 | PRATICA | `AI_CORE_SECRET` | Lovable Cloud vault |
| 5 | Regiads | `INTERNAL_CORE_API_KEY` | Lovable Cloud vault |

**After each client update**, verify:

```bash
# Smoke test from client's core-proxy
curl -s -X POST "$CLIENT_URL/functions/v1/core-proxy" \
  -H "Content-Type: application/json" \
  -d '{"path": "/health"}' | jq .data.status
```

Expected: `"ok"` or health response.

### Step 5 — Confirm Old Secret is Rejected

After ALL clients are updated:

```bash
# This should return 401
curl -s -X POST "https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/ai-core-run" \
  -H "Content-Type: application/json" \
  -H "x-internal-secret: OLD_SECRET_VALUE" \
  -d '{}' | jq .error.code
```

Expected: `"APP_SECRET_REQUIRED"` or `"APP_SECRET_REJECTED"`

### Step 6 — Post-Rotation Verification

Run full verification on each client:

| Check | Command | Expected |
|-------|---------|----------|
| Core health | `GET /health` | `ok: true` |
| Proxy forward | `POST /core-proxy {"path":"/health"}` | `ok: true` |
| Auth works | `POST /core-proxy {"path":"/ai-core-run", ...}` | `ok: true` |
| Old secret rejected | Direct call with old secret | `401` |

---

## Rollback Procedure

If a client fails after rotation:

1. **Immediately** restore the old `AI_CORE_SECRET` value in the failing client
2. Do NOT revert Central Core — other clients already use the new secret
3. Investigate the failure, then retry the client update

If multiple clients fail:

1. Revert Central Core to the old secret value
2. Revert all clients to the old secret value
3. Investigate root cause before retrying

---

## Emergency: Suspected Secret Compromise

1. Generate new secret immediately
2. Update Central Core first
3. Update all clients as fast as possible (parallel if needed)
4. Verify all health endpoints
5. Review access logs for unauthorized calls
6. Document the incident per `docs/incident-response.md`

---

## Client-Specific Notes

### Wyloni
- Secret name: `AI_CORE_SECRET` (also checks `AI_CORE_SECRETS` as fallback)
- Headers injected: `x-internal-secret`, `x-app-secret`, `x-core-secret`, `Authorization: Bearer`

### Regiads
- Secret name: `INTERNAL_CORE_API_KEY`
- Headers injected: `Authorization: Bearer`, `X-Request-Source: regiads-proxy`
- ⚠️ Does NOT inject `x-internal-secret` — relies on Bearer auth
- **Note:** Regiads uses Bearer auth via `INTERNAL_CORE_API_KEY` instead of `x-internal-secret`. This is intentional — see `docs/proxy-contract.md` for the supported auth header variants.

### Sottra / KeyDraft / PRATICA
- Follow standard pattern from `docs/proxy-contract.md`
- Secret name: `AI_CORE_SECRET`
