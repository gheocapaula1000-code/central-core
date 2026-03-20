# Central Core V3 — Incident Response

> Runbook for operational incidents involving Central Core and connected PWAs.
> Last updated: 2026-03-20

---

## Severity Levels

| Level | Description | Response Time | Example |
|-------|-------------|---------------|---------|
| **P1** | Core completely down, all PWAs affected | Immediate | Edge Functions unreachable |
| **P2** | Single function down or degraded | < 1 hour | Sottra returns 500, others OK |
| **P3** | Non-critical degradation | < 4 hours | Metrics endpoint slow, single provider timeout |
| **P4** | Cosmetic / logging issue | Next business day | Wrong log level, non-blocking warning |

---

## P1: Core Completely Down

### Symptoms
- All health endpoints return 5xx or timeout
- PWA proxies return `502 CORE_UNREACHABLE`
- Multiple PWA teams report simultaneous failures

### Response
1. **Verify** — Hit `GET /functions/v1/health` directly. If down, confirm platform issue.
2. **Check Edge Function logs** in Lovable Cloud dashboard for deployment errors.
3. **Rollback** — Revert to last known-good commit if recent deploy caused the issue.
4. **Notify** all PWA teams via shared channel with ETA.
5. **Post-mortem** — Document root cause within 24h.

---

## P2: Single Function Down

### Symptoms
- One function (e.g., `sottra`) returns errors; others healthy.
- PWAs using that function report failures.

### Response
1. **Isolate** — Confirm only one function is affected via health endpoints.
2. **Check logs** for that specific Edge Function.
3. **If provider issue** (e.g., OpenAI down): verify fallback chain is working. If all providers fail, the function correctly returns `PROVIDER_ERROR`.
4. **If code issue**: rollback that function's last change.
5. **Notify** affected PWA teams only.

---

## P3: Provider Degradation

### Symptoms
- Increased latency or error rate from one AI provider.
- Fallback chain activating frequently.
- Metrics show elevated `fallback_count`.

### Response
1. **Check diagnostics** — `GET /functions/v1/ai-core-run/diagnostics` (requires diagnostic secret).
2. **Verify fallback** — Confirm secondary provider is handling traffic.
3. **Monitor** — If degradation is temporary (< 30 min), no action needed.
4. **If persistent**: check provider status pages (status.openai.com, status.anthropic.com).
5. **No PWA notification needed** unless latency exceeds timeout thresholds.

---

## Secret Compromise

### Symptoms
- Unauthorized requests detected in logs.
- Unexpected `debug_id` patterns or source apps.

### Response
1. **Rotate immediately** — Generate new `AI_CORE_SECRET`.
2. **Update in Core** — Set new secret in Lovable Cloud.
3. **Update in ALL PWAs** — Simultaneously update in Wyloni, KeyDraft, Sottra, Regiads.
4. **Verify** — Run auth smoke test from each PWA.
5. **Audit** — Review logs for unauthorized access during compromise window.
6. **If DIAGNOSTIC_SECRET compromised**: rotate separately, only Core needs update.

---

## Debugging with debug_id

Every error response includes a `debug_id`. To trace an issue:

1. Get `debug_id` from the error response or PWA client logs.
2. Search Edge Function logs for that `debug_id`.
3. The log will show: function, route, timestamp, and error details.
4. Cross-reference with `X-Core-Version` and `X-Core-Function` headers.

---

## Escalation Path

1. **Core team** — First responder for all Core issues.
2. **PWA team leads** — Notified for P1/P2 affecting their app.
3. **Platform support** — If Edge Function infrastructure is the root cause.

---

## Post-Incident Checklist

- [ ] Root cause identified and documented
- [ ] Fix deployed and verified
- [ ] All health endpoints green
- [ ] Affected PWAs confirmed working
- [ ] Preventive measures identified
- [ ] Changelog updated if code changed
