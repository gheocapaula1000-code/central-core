// Verification harness — calls the deployed padova-readiness with the real
// DIAGNOSTIC_SECRET from env. Run via: supabase test (deno test --allow-env --allow-net).
Deno.test("padova-readiness envelope", async () => {
  const url = "https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/padova-readiness";
  const sec = Deno.env.get("DIAGNOSTIC_SECRET") ?? "";
  if (!sec) { console.log("SKIP: no DIAGNOSTIC_SECRET in env"); return; }
  const r = await fetch(url, { headers: { "x-diagnostic-secret": sec } });
  const j = await r.json();
  console.log("HTTP", r.status);
  console.log(JSON.stringify({
    ok: j.ok,
    status: j.data?.status,
    reason: j.data?.reason,
    updated_at: j.data?.updated_at,
    signals: j.data?.signals,
    stripe_mode: j.data?.providers?.stripe_mode,
    stripe_key_masked: j.data?.providers?.stripe_key_masked,
    stripe_webhook_configured: j.data?.providers?.stripe_webhook_configured,
  }, null, 2));
});
