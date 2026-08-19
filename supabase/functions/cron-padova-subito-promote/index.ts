// cron-padova-subito-promote
// Wrapper cron per la promotion staging Subito → padova_collect_v2_items.
// Chiama la SQL function public.process_padova_subito_staging(since_hours, max_rows)
// e, se ha scritto righe, promote_padova_collect_v2_to_listings.
// Logga esito in cron_executions_log.
//
// Auth: CENTRAL_CORE_JOB_SECRET via x-job-secret / x-internal-secret / Bearer.
// Payload: { since_hours?: number, max_rows?: number }

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  bumpCounter,
  createScopeCounters,
  normalizeCounters,
  reconcileScopeCounters,
} from "../_shared/civikoPadovaScopeGuard.ts";
import { writeSubitoSourceRegistry } from "../_shared/apify.ts";
import { isJobSecretAuthorized, jobAuthFailure } from "../_shared/jobAuth.ts";
import { classifyPromoteResult } from "../_shared/subitoMapper.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const started = new Date();
  const secret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!isJobSecretAuthorized(req.headers, secret)) {
    const auth = jobAuthFailure(Boolean(secret));
    await writeSubitoSourceRegistry({ ok: false, error: auth.error });
    return new Response(JSON.stringify({ ok: false, error: auth.error }), {
      status: auth.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!url || !srk) {
    await writeSubitoSourceRegistry({ ok: false, error: "config_missing" });
    return new Response(JSON.stringify({ ok: false, error: "config_missing" }), {
      status: 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: { since_hours?: number; max_rows?: number } = {};
  try { body = await req.json(); } catch { /* empty ok */ }
  const since = Math.max(1, Math.min(Number(body.since_hours ?? 48), 168));
  const max = Math.max(1, Math.min(Number(body.max_rows ?? 1000), 5000));

  const sb = createClient(url, srk, { auth: { persistSession: false } });

  let result: any = null;
  let status: "success" | "failure" = "success";
  let errMsg: string | null = null;
  let listingsPromote: unknown = null;

  try {
    const { data, error } = await sb.rpc("process_padova_subito_staging", {
      p_since_hours: since,
      p_max_rows: max,
    });
    if (error) throw new Error(error.message);
    result = data;
    const classified = classifyPromoteResult(result);
    if (!classified.ok) {
      status = "failure";
      errMsg = classified.reason;
    }
  } catch (e) {
    status = "failure";
    errMsg = String((e as Error)?.message ?? e);
  }

  const counters = createScopeCounters();
  if (result && typeof result === "object") {
    const r = result as Record<string, number>;
    bumpCounter(counters, "scanned", Number(r.staging_rows_found ?? 0));
    bumpCounter(counters, "padova_kept", Number(r.staging_rows_processed ?? 0));
    bumpCounter(counters, "out_of_scope_rejected", Number(r.skipped_out_of_scope ?? 0));
    bumpCounter(counters, "other_rejected", Number(r.skipped_bad_data ?? 0));
    bumpCounter(counters, "writes", Number(r.collect_created ?? 0) + Number(r.collect_updated ?? 0));
  }
  const scope_counters = normalizeCounters(counters);
  const scope_reconciliation = reconcileScopeCounters(scope_counters);
  if (status === "success" && scope_counters.out_of_scope_written > 0) {
    status = "failure";
    errMsg = "OUT_OF_SCOPE_WRITE_DETECTED";
  }

  if (status === "success" && scope_counters.writes > 0) {
    try {
      const sinceIso = new Date(Date.now() - since * 3600 * 1000).toISOString();
      const { data, error } = await sb.rpc("promote_padova_collect_v2_to_listings", {
        p_since: sinceIso,
      });
      if (error) {
        listingsPromote = { ok: false, error: error.message };
      } else {
        listingsPromote = data;
      }
    } catch (e) {
      listingsPromote = { ok: false, error: String((e as Error)?.message ?? e) };
    }
  }

  await writeSubitoSourceRegistry({
    ok: status === "success",
    records: scope_counters.writes,
    error: errMsg ?? undefined,
  });

  const finished = new Date();
  const excerpt = JSON.stringify(
    result
      ? { ...(result as Record<string, unknown>), scope_counters, listings_promote: listingsPromote }
      : { error: errMsg },
  ).slice(0, 900);
  await sb.from("cron_executions_log").insert({
    job_name: "central-core-padova-subito-promote",
    status,
    triggered_at: started.toISOString(),
    completed_at: finished.toISOString(),
    duration_ms: finished.getTime() - started.getTime(),
    http_status: status === "success" ? 200 : 500,
    response_excerpt: excerpt,
    error_message: errMsg,
  });

  return new Response(
    JSON.stringify({
      ok: status === "success",
      result,
      error: errMsg,
      scope_counters,
      scope_reconciliation,
      listings_promote: listingsPromote,
    }, null, 2),
    { status: status === "success" ? 200 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
