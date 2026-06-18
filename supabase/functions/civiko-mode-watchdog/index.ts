// Watchdog modalita' operativa — chiamato ogni 15 min da pg_cron.
// Unico compito: se test_intensive e' scaduto, flippa a saving.
// Idempotente. Nessun side-effect oltre la singola UPDATE + alert.

import { checkAndExpireTestMode, getOperationalMode } from "../_shared/operationalMode.ts";

Deno.serve(async (_req) => {
  try {
    const before = await getOperationalMode();
    const res = await checkAndExpireTestMode();
    const body = {
      ok: true,
      checked_at: new Date().toISOString(),
      mode_before: before.mode,
      mode_after: res.mode,
      expired: res.expired,
      test_ends_at: before.test_ends_at,
    };
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[mode-watchdog] error:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      headers: { "Content-Type": "application/json" },
      status: 500,
    });
  }
});
