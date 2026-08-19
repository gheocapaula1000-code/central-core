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
  | { started: true; run_id: string; dataset_id: string }
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
  // a) Budget guard (daily + monthly).
  const allowed = await canSpendApify(opts.estUsd);
  if (!allowed.ok) {
    return {
      started: false,
      reason: allowed.reason ?? "APIFY_DAILY_CAP_REACHED",
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
    return { started: false, reason: "APIFY_TOKEN_MISSING" };
  }

  let run_id: string;
  let dataset_id: string;
  try {
    const webhooks = buildApifyRunWebhooks({
      requestUrl: collectPendingWebhookUrl(Deno.env.get("SUPABASE_URL") ?? ""),
      jobSecret: Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "",
    });
    const webhookQuery = webhooks
      ? `&webhooks=${encodeURIComponent(encodeApifyWebhooksQuery(webhooks))}`
      : "";
    const r = await fetch(
      `${APIFY_BASE}/acts/${encodeURIComponent(actor)}/runs?token=${encodeURIComponent(token)}&waitForFinish=0${webhookQuery}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input ?? {}),
      },
    );
    if (!r.ok) {
      return { started: false, reason: `APIFY_START_HTTP_${r.status}` };
    }
    const j = await r.json();
    run_id = j?.data?.id;
    dataset_id = j?.data?.defaultDatasetId;
    if (!run_id || !dataset_id) {
      return { started: false, reason: "APIFY_START_INVALID_RESPONSE" };
    }
  } catch (e) {
    return {
      started: false,
      reason: `APIFY_START_ERROR:${String((e as Error)?.message ?? e).slice(0, 120)}`,
    };
  }

  // c) Account for the spend (best-effort).
  try {
    await recordApifySpend(opts.estUsd, 1, { portal: opts.portal, actor } as any);
  } catch { /* best effort */ }

  // d) Register the run row (best-effort).
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (url && key) {
      const sb = createClient(url, key, { auth: { persistSession: false } });
      await sb.from("padova_apify_runs").insert({
        portal: opts.portal,
        actor_id: actor,
        run_id,
        dataset_id,
        status: "RUNNING",
        cost_cap_usd: opts.costCapUsd ?? opts.estUsd,
      });
    }
  } catch { /* best effort */ }

  // e) Success.
  return { started: true, run_id, dataset_id };
}
