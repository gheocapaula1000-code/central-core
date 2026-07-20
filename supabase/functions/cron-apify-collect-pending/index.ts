// cron-apify-collect-pending
// Wrapper cron. A ogni tick chiama in parallelo:
//   - padova-apify-collect-pending (avvia/pollinga Actor pending)
//   - padova-apify-multi-status    (SOLO controllo run esistenti, mai lanciare)
// Le due chiamate sono isolate con Promise.allSettled: il fallimento di una
// non blocca l'altra. Timeout distinti e riepilogo senza payload grezzi.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const COLLECT_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 120_000;

async function callFn(
  base: string,
  name: string,
  secret: string,
  anon: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; ok: boolean; snippet: string }> {
  const r = await fetch(`${base}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-job-secret": secret,
      "apikey": anon,
      "Authorization": `Bearer ${anon}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let snippet = "";
  try {
    const text = await r.text();
    // riepilogo senza dati grezzi: massimo 500 chars
    snippet = text.slice(0, 500);
  } catch { /* ignore */ }
  return { status: r.status, ok: r.ok, snippet };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const secret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const base = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!secret || !base) {
    return new Response(JSON.stringify({ ok: false, error: "config_missing" }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  let collectBody: Record<string, unknown> = { stale_minutes: 5, max_runs: 20 };
  try {
    const raw = await req.json();
    if (raw && typeof raw === "object") collectBody = raw as Record<string, unknown>;
  } catch { /* body opzionale */ }

  const started = Date.now();
  const [collectRes, statusRes] = await Promise.allSettled([
    callFn(base, "padova-apify-collect-pending", secret, anon, collectBody, COLLECT_TIMEOUT_MS),
    // multi-status: nessun payload necessario, solo controllo run esistenti
    callFn(base, "padova-apify-multi-status", secret, anon, {}, STATUS_TIMEOUT_MS),
  ]);

  const summary = {
    ok: true,
    duration_ms: Date.now() - started,
    collect_pending: collectRes.status === "fulfilled"
      ? { ok: collectRes.value.ok, status: collectRes.value.status }
      : { ok: false, error: String((collectRes.reason as Error)?.message ?? collectRes.reason).slice(0, 300) },
    multi_status: statusRes.status === "fulfilled"
      ? { ok: statusRes.value.ok, status: statusRes.value.status }
      : { ok: false, error: String((statusRes.reason as Error)?.message ?? statusRes.reason).slice(0, 300) },
  };

  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
