// Temporary runner: invokes padova-bootstrap-cycle in background, returns immediately.
// Final upstream JSON is logged via console.log so it shows up in edge_function_logs.
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const diagSecret = Deno.env.get("DIAGNOSTIC_SECRET") ?? "";
  const url = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "") +
    "/functions/v1/padova-bootstrap-cycle";

  const task = (async () => {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-diagnostic-secret": diagSecret,
          "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
        },
        body: JSON.stringify({ city: "Padova", full: true }),
        signal: AbortSignal.timeout(290000),
      });
      const text = await res.text();
      console.log(`[BOOTSTRAP_RESULT] status=${res.status} duration_ms=${Date.now() - started}`);
      // Chunk-log to avoid line truncation
      const chunkSize = 1500;
      for (let i = 0; i < text.length; i += chunkSize) {
        console.log(`[BOOTSTRAP_BODY ${i}] ${text.slice(i, i + chunkSize)}`);
      }
      console.log(`[BOOTSTRAP_END]`);
    } catch (e) {
      console.error(`[BOOTSTRAP_ERROR] ${e instanceof Error ? e.message : String(e)} after ${Date.now() - started}ms`);
    }
  })();

  // @ts-ignore EdgeRuntime is available in Deno Deploy
  const ert = (globalThis as any).EdgeRuntime;
  if (ert?.waitUntil) ert.waitUntil(task); else task.catch(() => {});

  return new Response(JSON.stringify({
    accepted: true,
    note: "Bootstrap started in background. Tail logs of civiko-bootstrap-runner for [BOOTSTRAP_RESULT]/[BOOTSTRAP_BODY] lines.",
    target_url: url,
    diagnostic_secret_present: diagSecret.length > 0,
    started_at: new Date().toISOString(),
  }, null, 2), {
    status: 202,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
