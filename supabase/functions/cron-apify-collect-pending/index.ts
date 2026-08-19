// cron-apify-collect-pending
// Wrapper cron. A ogni tick drena padova-apify-collect-pending finché i run
// pending sono terminali o scade il budget (sotto il timeout pg_net 120s).
// In parallelo chiama padova-apify-multi-status (solo controllo, mai lanciare).
// Timeout distinti e riepilogo senza payload grezzi / secret.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import {
  COLLECT_CRON_TIMEOUT_MS,
  COLLECT_DRAIN_PAUSE_MS,
  collectTickNeedsContinue,
  drainLoopShouldContinue,
} from "../_shared/apifyDrain.ts";

const STATUS_TIMEOUT_MS = 25_000;

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
      "x-internal-secret": secret,
      "apikey": anon,
      "Authorization": `Bearer ${anon}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let snippet = "";
  try {
    const text = await r.text();
    snippet = text.slice(0, 500);
  } catch { /* ignore */ }
  return { status: r.status, ok: r.ok, snippet };
}

function parseCollectSnippet(snippet: string): {
  pendingCount: number;
  ok: boolean;
} {
  try {
    const parsed = JSON.parse(snippet);
    if (!parsed || typeof parsed !== "object") return { pendingCount: 0, ok: false };
    return {
      pendingCount: Number((parsed as Record<string, unknown>).pending_count ?? 0),
      ok: (parsed as Record<string, unknown>).ok === true,
    };
  } catch {
    return { pendingCount: 0, ok: false };
  }
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

  let collectBody: Record<string, unknown> = {
    stale_minutes: 2,
    max_runs: 20,
    max_items_per_run: 10000,
    drain_wait_seconds: 40,
  };
  try {
    const raw = await req.json();
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      collectBody = { ...collectBody, ...(raw as Record<string, unknown>) };
    }
  } catch { /* body opzionale */ }

  const started = Date.now();
  const statusPromise = callFn(base, "padova-apify-multi-status", secret, anon, {}, STATUS_TIMEOUT_MS);

  let collectRes: { status: number; ok: boolean; snippet: string } | null = null;
  let collectError: string | null = null;
  let ticks = 0;
  try {
    do {
      const remaining = started + COLLECT_CRON_TIMEOUT_MS - Date.now();
      if (remaining < 8_000) break;
      collectRes = await callFn(
        base,
        "padova-apify-collect-pending",
        secret,
        anon,
        collectBody,
        Math.min(remaining, 55_000),
      );
      ticks += 1;
      const parsed = parseCollectSnippet(collectRes.snippet);
      const needsContinue = collectTickNeedsContinue({
        pendingCount: parsed.pendingCount,
        httpStatus: collectRes.status,
        ok: collectRes.ok && parsed.ok,
      });
      if (!drainLoopShouldContinue({
        startedAtMs: started,
        nowMs: Date.now(),
        wallBudgetMs: COLLECT_CRON_TIMEOUT_MS,
        needsContinue,
      })) break;
      await new Promise((resolve) => setTimeout(resolve, COLLECT_DRAIN_PAUSE_MS));
    } while (true);
  } catch (error) {
    collectError = String((error as Error)?.message ?? error).slice(0, 300);
  }

  const statusRes = await Promise.allSettled([statusPromise]).then((rows) => rows[0]);

  const collectOk = Boolean(collectRes?.ok) && collectRes?.status === 200 && !collectError;
  const summary = {
    ok: collectOk,
    duration_ms: Date.now() - started,
    drain_ticks: ticks,
    collect_pending: collectRes
      ? { ok: collectRes.ok, status: collectRes.status }
      : { ok: false, error: collectError ?? "collect_pending_not_called" },
    multi_status: statusRes.status === "fulfilled"
      ? { ok: statusRes.value.ok, status: statusRes.value.status }
      : { ok: false, error: String((statusRes.reason as Error)?.message ?? statusRes.reason).slice(0, 300) },
  };

  const httpStatus = collectOk ? 200 : (collectRes?.status === 202 ? 202 : 502);
  return new Response(JSON.stringify(summary), {
    status: httpStatus,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
