// padova-apify-casa-collect
// Collect casa.it listings Padova via actor Apify `benthepythondev~casa-it-scraper`.
// Solo modalità async_start: lancia il run (guardia budget + insert padova_apify_runs),
// attacca un webhook Apify verso padova-apify-collect-pending, poi collect-pending
// completa il download del dataset e l'upsert su padova_collect_v2_items.
//
// Auth: x-job-secret / x-internal-secret / Authorization Bearer (non-JWT)
//       === CENTRAL_CORE_JOB_SECRET.
// Body opzionale: { locations?: string[], max_items?: number }
// NB: il campo searchUrls dell'actor NON va usato (ramo difettoso). Solo locations.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getApifyToken } from "../_shared/apify.ts";
import { canSpendApify, recordApifySpend } from "../_shared/apifyBudget.ts";
import { expireStaleScrapeJobs } from "../_shared/scrapeJobWatchdog.ts";
import {
  ACTOR_CASA,
  CASA_COST_CAP_USD,
  CASA_CRON_JOB,
  CASA_INFLIGHT_WINDOW_MS,
  CASA_PORTAL,
  buildCasaActorInput,
  buildCollectPendingWebhook,
  casaSourceRegistryPatch,
  clampCasaMaxItems,
  collectPendingUrl,
  encodeApifyWebhooksParam,
  estimateCasaUsd,
  formatApifyStartError,
  isJobSecretAuthorized,
  jobAuthFailure,
  normalizeCasaLocations,
  redactApifyText,
  webhookCreateBody,
} from "../_shared/casaCollect.ts";

const APIFY_BASE = "https://api.apify.com/v2";
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function persistFailedLaunch(reason: string, costCapUsd: number): Promise<void> {
  const sb = serviceClient();
  if (!sb) return;
  try {
    await sb.from("padova_apify_runs").insert({
      portal: CASA_PORTAL,
      actor_id: ACTOR_CASA,
      run_id: `casa-failed-${crypto.randomUUID()}`,
      dataset_id: null,
      status: "FAILED",
      cost_cap_usd: costCapUsd,
      error: reason.slice(0, 1000),
      finished_at: new Date().toISOString(),
    });
  } catch { /* best effort */ }
}

async function writeCasaSourceRegistry(outcome: { ok: boolean; records?: number; error?: string }): Promise<void> {
  const sb = serviceClient();
  if (!sb) return;
  const patch = casaSourceRegistryPatch(outcome, new Date().toISOString());
  try {
    await sb.from("civiko_source_registry").update(patch)
      .eq("scheduler_job_name", CASA_CRON_JOB);
  } catch (e) {
    console.warn("[casa-apify] source registry update failed", String((e as Error)?.message ?? e));
  }
}

async function attachRunWebhook(
  token: string,
  runId: string,
  webhook: NonNullable<ReturnType<typeof buildCollectPendingWebhook>>,
): Promise<boolean> {
  try {
    const r = await fetch(`${APIFY_BASE}/webhooks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(webhookCreateBody(runId, webhook)),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.warn("[casa-apify] webhook attach failed", r.status, redactApifyText(text).slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[casa-apify] webhook attach error", String((e as Error)?.message ?? e).slice(0, 160));
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }),
      { status: 405, headers: jsonHeaders });
  }

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!isJobSecretAuthorized(req.headers, jobSecret)) {
    const fail = jobAuthFailure(!!jobSecret);
    return new Response(JSON.stringify({ ok: false, error: fail.error }),
      { status: fail.status, headers: jsonHeaders });
  }

  const token = getApifyToken();
  if (!token) {
    await writeCasaSourceRegistry({ ok: false, error: "APIFY_API_TOKEN_missing" });
    return new Response(
      JSON.stringify({ ok: false, error: "APIFY_API_TOKEN_missing" }),
      { status: 503, headers: jsonHeaders },
    );
  }

  let body: { locations?: unknown; max_items?: unknown } = {};
  try { body = await req.json(); } catch { /* empty */ }

  const maxResults = clampCasaMaxItems(body.max_items);
  const locations = normalizeCasaLocations(body.locations);
  const input = buildCasaActorInput(locations, maxResults);
  const estUsd = estimateCasaUsd(maxResults);
  const costCap = Math.min(CASA_COST_CAP_USD, Math.max(estUsd, 0.01));

  const sb = serviceClient();
  if (!sb) {
    return new Response(JSON.stringify({ ok: false, error: "config_missing" }),
      { status: 500, headers: jsonHeaders });
  }

  // Release skip-locks held by jobs stuck in RUNNING past the watchdog timeout
  // before the 6h dedup check, otherwise a hung run blocks every later collect.
  await expireStaleScrapeJobs(sb);

  const sixHoursAgo = new Date(Date.now() - CASA_INFLIGHT_WINDOW_MS).toISOString();
  const { data: inflight, error: inflightErr } = await sb
    .from("padova_apify_runs")
    .select("run_id, started_at")
    .eq("portal", CASA_PORTAL)
    .eq("status", "RUNNING")
    .gte("started_at", sixHoursAgo)
    .limit(1);
  if (inflightErr) {
    await writeCasaSourceRegistry({ ok: false, error: "APIFY_DEDUP_CHECK_FAILED" });
    return new Response(
      JSON.stringify({ ok: false, code: "APIFY_DEDUP_CHECK_FAILED" }),
      { status: 503, headers: jsonHeaders },
    );
  }
  if (inflight && inflight.length > 0) {
    return new Response(
      JSON.stringify({
        ok: false,
        skipped: true,
        skipped_reason: "casa_run_already_running",
        existing_run_id: inflight[0].run_id,
      }),
      { status: 409, headers: jsonHeaders },
    );
  }

  const allowed = await canSpendApify(estUsd);
  if (!allowed.ok) {
    const reason = allowed.reason ?? "APIFY_DAILY_CAP_REACHED";
    await persistFailedLaunch(reason, costCap);
    await writeCasaSourceRegistry({ ok: false, error: reason });
    console.warn(`[apify] lancio saltato: ${reason} portal=${CASA_PORTAL}`);
    return new Response(
      JSON.stringify({ ok: false, skipped: true, reason }),
      { status: 429, headers: jsonHeaders },
    );
  }

  const webhook = buildCollectPendingWebhook(
    collectPendingUrl(Deno.env.get("SUPABASE_URL") ?? ""),
    jobSecret,
  );
  const qs = new URLSearchParams({ waitForFinish: "0" });
  if (webhook) qs.set("webhooks", encodeApifyWebhooksParam([webhook]));
  // Never log `qs` / webhook JSON: headersTemplate carries the job secret.

  let run_id: string;
  let dataset_id: string;
  try {
    const r = await fetch(
      `${APIFY_BASE}/acts/${encodeURIComponent(ACTOR_CASA)}/runs?${qs.toString()}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(input),
      },
    );
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      const reason = formatApifyStartError(r.status, text);
      await persistFailedLaunch(reason, costCap);
      await writeCasaSourceRegistry({ ok: false, error: reason });
      return new Response(
        JSON.stringify({ ok: false, skipped: true, reason }),
        { status: 502, headers: jsonHeaders },
      );
    }
    const j = await r.json();
    run_id = j?.data?.id;
    dataset_id = j?.data?.defaultDatasetId;
    if (!run_id || !dataset_id) {
      const reason = "APIFY_START_INVALID_RESPONSE";
      await persistFailedLaunch(reason, costCap);
      await writeCasaSourceRegistry({ ok: false, error: reason });
      return new Response(
        JSON.stringify({ ok: false, skipped: true, reason }),
        { status: 502, headers: jsonHeaders },
      );
    }
  } catch (e) {
    const reason = `APIFY_START_ERROR:${String((e as Error)?.message ?? e).slice(0, 120)}`;
    await persistFailedLaunch(reason, costCap);
    await writeCasaSourceRegistry({ ok: false, error: reason });
    return new Response(
      JSON.stringify({ ok: false, skipped: true, reason }),
      { status: 502, headers: jsonHeaders },
    );
  }

  try {
    await recordApifySpend(estUsd, 1, { portal: CASA_PORTAL, actor: ACTOR_CASA } as any);
  } catch { /* best effort */ }

  try {
    await sb.from("padova_apify_runs").insert({
      portal: CASA_PORTAL,
      actor_id: ACTOR_CASA,
      run_id,
      dataset_id,
      status: "RUNNING",
      cost_cap_usd: costCap,
    });
  } catch { /* best effort */ }

  // Start-time webhooks avoid the race where the actor finishes before
  // POST /webhooks. Fall back to an explicit attach if the query param
  // could not be set (e.g. missing secret/url).
  let webhook_attached = qs.has("webhooks");
  if (webhook && !webhook_attached) {
    webhook_attached = await attachRunWebhook(token, run_id, webhook);
  }

  await writeCasaSourceRegistry({ ok: true, records: 1 });

  return new Response(
    JSON.stringify({
      ok: true,
      async_start: true,
      run_id,
      dataset_id,
      locations,
      max_results: maxResults,
      webhook_attached,
      note: "run avviato in async: collect-pending completerà ingest via webhook o cron",
    }, null, 2),
    { status: 202, headers: jsonHeaders },
  );
});
