// Centralized Apify token resolution and shared run launcher.
//
// Canonical env var: APIFY_API_TOKEN
// Legacy fallbacks (deprecated, kept temporarily for backwards compatibility
// during the migration): APIFY_TOKEN, APIFY_API_KEY.
//
// All edge functions MUST resolve the Apify token via getApifyToken() instead
// of reading Deno.env directly, and MUST launch actor runs via startApifyRun()
// so budget guards and padova_apify_runs registration live in one place.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { canSpendApify, recordApifySpend } from "./apifyBudget.ts";
import {
  buildApifyRunWebhooks,
  collectPendingWebhookUrl,
  encodeApifyWebhooksQuery,
} from "./apifyDrain.ts";
import {
  buildCollectPendingWebhook,
  formatApifyStartError,
  normalizeApifyActorId,
  sourceRegistryPatch,
  syntheticFailedRunId,
  COLLECT_PENDING_FN,
  SUBITO_SCHEDULER_JOBS,
} from "./apifyLaunch.ts";
import { jobAuthHeaders } from "./jobAuth.ts";

const CANONICAL = "APIFY_API_TOKEN";
const LEGACY_FALLBACKS = ["APIFY_TOKEN", "APIFY_API_KEY"] as const;

let warnedLegacy = false;

/** Returns the configured Apify API token, or "" if none is configured. */
export function getApifyToken(): string {
  const canonical = Deno.env.get(CANONICAL);
  if (canonical) return canonical;
  for (const name of LEGACY_FALLBACKS) {
    const v = Deno.env.get(name);
    if (v) {
      if (!warnedLegacy) {
        warnedLegacy = true;
        console.warn(
          `[apify] using legacy env var ${name}; please rename to ${CANONICAL}`,
        );
      }
      return v;
    }
  }
  return "";
}

export function isApifyTokenConfigured(): boolean {
  return getApifyToken().length > 0;
}

const APIFY_BASE = "https://api.apify.com/v2";

export type StartApifyRunResult =
  | { started: true; run_id: string; dataset_id: string; webhook_attached: boolean }
  | {
      started: false;
      reason: string;
      current_spend_usd?: number;
      cap_usd?: number;
      calls_today?: number;
      current_month_spend_usd?: number;
      cap_month_usd?: number;
      monthly_cap_env?: string;
    };

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function collectPendingUrl(): string {
  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  return base ? `${base}/functions/v1/${COLLECT_PENDING_FN}` : "";
}

function jobSecret(): string {
  return Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
}

async function persistFailedLaunch(
  portal: string,
  actor: string,
  reason: string,
  costCapUsd: number,
): Promise<void> {
  const sb = serviceClient();
  if (!sb) return;
  try {
    await sb.from("padova_apify_runs").insert({
      portal,
      actor_id: actor,
      run_id: syntheticFailedRunId(),
      dataset_id: null,
      status: "FAILED",
      cost_cap_usd: costCapUsd,
      error: reason.slice(0, 1000),
      finished_at: new Date().toISOString(),
    });
  } catch { /* best effort */ }
}

export async function writePortalSourceRegistry(
  outcome: { ok: boolean; records?: number; error?: string },
  opts: { prefix: string; schedulerJobs: readonly string[] },
): Promise<void> {
  const sb = serviceClient();
  if (!sb) return;
  const patch = sourceRegistryPatch(outcome, new Date().toISOString(), opts.prefix);
  try {
    await sb.from("civiko_source_registry").update(patch)
      .in("scheduler_job_name", [...opts.schedulerJobs]);
  } catch (e) {
    console.warn("[apify] source registry update failed", String((e as Error)?.message ?? e));
  }
}

export async function writeSubitoSourceRegistry(
  outcome: { ok: boolean; records?: number; error?: string },
): Promise<void> {
  await writePortalSourceRegistry(outcome, {
    prefix: "[subito-apify]",
    schedulerJobs: SUBITO_SCHEDULER_JOBS,
  });
}

export function handoffCollectPending(runIds: string[]): void {
  const ids = runIds.map((id) => String(id ?? "").trim()).filter(Boolean);
  const secret = jobSecret();
  const url = collectPendingUrl();
  if (!ids.length || !secret || !url) return;
  fetch(url, {
    method: "POST",
    headers: jobAuthHeaders(secret),
    body: JSON.stringify({ run_ids: ids, stale_minutes: 0, max_runs: ids.length }),
  }).catch((e) => console.warn("[apify] collect-pending handoff", String(e)));
}

export interface StartApifyRunOpts {
  portal: string;
  estUsd: number;
  costCapUsd?: number;
}

/**
 * Unified Apify actor launcher with daily/monthly budget guard and
 * padova_apify_runs registration. All edge functions should route
 * their run launches through here to avoid double-accounting and
 * duplicated boilerplate.
 */
export async function startApifyRun(
  actor: string,
  input: unknown,
  opts: StartApifyRunOpts,
): Promise<StartApifyRunResult> {
  const actorId = normalizeApifyActorId(actor);
  const costCap = opts.costCapUsd ?? opts.estUsd;

  // a) Budget guard (daily + monthly).
  const allowed = await canSpendApify(opts.estUsd);
  if (!allowed.ok) {
    const reason = allowed.reason ?? "APIFY_DAILY_CAP_REACHED";
    await persistFailedLaunch(opts.portal, actorId, reason, costCap);
    return {
      started: false,
      reason,
      current_spend_usd: allowed.spent,
      cap_usd: allowed.cap,
      calls_today: allowed.calls,
      current_month_spend_usd: allowed.current_month_spend_usd,
      cap_month_usd: allowed.cap_month_usd,
      monthly_cap_env: allowed.monthly_cap_env,
    };
  }

  // b) Fire the run against Apify.
  const token = getApifyToken();
  if (!token) {
    await persistFailedLaunch(opts.portal, actorId, "APIFY_TOKEN_MISSING", costCap);
    return { started: false, reason: "APIFY_TOKEN_MISSING" };
  }
  if (!actorId) {
    await persistFailedLaunch(opts.portal, actor, "APIFY_ACTOR_ID_MISSING", costCap);
    return { started: false, reason: "APIFY_ACTOR_ID_MISSING" };
  }

  const requestUrl = collectPendingWebhookUrl(Deno.env.get("SUPABASE_URL") ?? "") ||
    collectPendingUrl();
  const secret = jobSecret();
  // Drain webhook from #39 (eventTypes + headersTemplate) plus Subito payloadTemplate
  // so collect-pending receives `{ run_ids: [resource.id] }` on terminal events.
  const drainHooks = buildApifyRunWebhooks({ requestUrl, jobSecret: secret });
  const subitoHook = buildCollectPendingWebhook(requestUrl, secret);
  const webhooks = drainHooks?.map((hook) => ({
    ...hook,
    ...(subitoHook
      ? {
        payloadTemplate: subitoHook.payloadTemplate,
        headersTemplate: subitoHook.headersTemplate,
      }
      : {}),
  })) ?? null;
  const webhookQuery = webhooks
    ? `&webhooks=${encodeURIComponent(encodeApifyWebhooksQuery(webhooks))}`
    : "";

  let run_id: string;
  let dataset_id: string;
  try {
    const r = await fetch(
      `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/runs?waitForFinish=0${webhookQuery}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(input ?? {}),
      },
    );
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      const reason = formatApifyStartError(r.status, text);
      await persistFailedLaunch(opts.portal, actorId, reason, costCap);
      return { started: false, reason };
    }
    const j = await r.json();
    run_id = j?.data?.id;
    dataset_id = j?.data?.defaultDatasetId;
    if (!run_id || !dataset_id) {
      const reason = "APIFY_START_INVALID_RESPONSE";
      await persistFailedLaunch(opts.portal, actorId, reason, costCap);
      return { started: false, reason };
    }
  } catch (e) {
    const reason = `APIFY_START_ERROR:${String((e as Error)?.message ?? e).slice(0, 120)}`;
    await persistFailedLaunch(opts.portal, actorId, reason, costCap);
    return { started: false, reason };
  }

  // c) Account for the spend (best-effort).
  try {
    await recordApifySpend(opts.estUsd, 1, { portal: opts.portal, actor: actorId } as any);
  } catch { /* best effort */ }

  // d) Register the run row. collect-pending cannot ingest a run that was never persisted.
  try {
    const sb = serviceClient();
    if (sb) {
      const { error } = await sb.from("padova_apify_runs").insert({
        portal: opts.portal,
        actor_id: actorId,
        run_id,
        dataset_id,
        status: "RUNNING",
        cost_cap_usd: costCap,
      });
      if (error) {
        console.error("[apify] padova_apify_runs insert failed", error.message);
      }
    } else {
      console.error("[apify] padova_apify_runs insert skipped: missing SUPABASE_URL or SERVICE_ROLE");
    }
  } catch (e) {
    console.error("[apify] padova_apify_runs insert exception", String((e as Error)?.message ?? e));
  }

  // e) Success.
  return { started: true, run_id, dataset_id, webhook_attached: Boolean(webhooks) };
}
