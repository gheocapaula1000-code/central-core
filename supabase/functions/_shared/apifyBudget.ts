// Apify daily spend cap — shared across edge functions.
//
// Hard cap: APIFY_DAILY_CAP_USD (default $25). Before any Apify run, call
// canSpendApify(estUsd). After the run, call recordApifySpend(estUsd).
// Persisted in public.apify_spend_daily (one row per UTC day).
//
// Inoltre rispetta il cap MENSILE aggregato gestito da operational_mode
// (vedi monthlyBudget.ts) come kill-switch trasversale.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isMonthlyCapReached } from "./monthlyBudget.ts";
import { isRadarMonthlyHardCapReached, recordProviderUsage, type RadarRunMeta } from "./radarBudget.ts";

// Parsing robusto del tetto giornaliero: se l'env è assente/vuota/non numerica/<=0
// usiamo il DEFAULT 10 USD invece di bloccare a budget intatto.
const APIFY_DAILY_CAP_DEFAULT_USD = 10;
const APIFY_DAILY_CAP_RAW = Deno.env.get("APIFY_DAILY_CAP_USD");
const APIFY_DAILY_CAP_PARSED = parseFloat(APIFY_DAILY_CAP_RAW ?? "");
export const APIFY_DAILY_CAP_USD = Number.isFinite(APIFY_DAILY_CAP_PARSED) && APIFY_DAILY_CAP_PARSED > 0
  ? APIFY_DAILY_CAP_PARSED
  : APIFY_DAILY_CAP_DEFAULT_USD;
console.log(
  `[apifyBudget] APIFY_DAILY_CAP_USD raw=${JSON.stringify(APIFY_DAILY_CAP_RAW)} effective=${APIFY_DAILY_CAP_USD}`,
);

function sb() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getApifySpendToday(): Promise<{ calls: number; est_usd: number }> {
  const c = sb();
  if (!c) return { calls: 0, est_usd: 0 };
  const { data } = await c
    .from("apify_spend_daily")
    .select("calls, est_usd")
    .eq("day_utc", today())
    .maybeSingle();
  return {
    calls: Number((data as any)?.calls ?? 0),
    est_usd: Number((data as any)?.est_usd ?? 0),
  };
}

/** Returns true if we have budget for est_usd more spend today AND monthly cap not reached. */
export async function canSpendApify(estUsd: number): Promise<{ ok: boolean; spent: number; cap: number; calls: number; reason?: string }> {
  if (await isRadarMonthlyHardCapReached()) {
    return { ok: false, spent: 0, cap: 0, calls: 0, reason: "radar_monthly_eur_cap_reached" };
  }
  const monthly = await isMonthlyCapReached();
  if (monthly.reached) {
    return { ok: false, spent: monthly.total, cap: monthly.cap, calls: 0, reason: "monthly_cap_reached" };
  }
  const cap = APIFY_DAILY_CAP_USD;
  const { est_usd, calls } = await getApifySpendToday();
  // Confronto in USD: spesa stimata oggi + spesa stimata del run corrente vs tetto.
  return { ok: est_usd + estUsd <= cap, spent: est_usd, cap, calls };
}

export async function recordApifySpend(estUsd: number, calls = 1, meta?: RadarRunMeta): Promise<void> {
  const c = sb();
  if (!c) return;
  const day = today();
  const cur = await getApifySpendToday();
  await c.from("apify_spend_daily").upsert({
    day_utc: day,
    calls: cur.calls + calls,
    est_usd: Number((cur.est_usd + estUsd).toFixed(3)),
    updated_at: new Date().toISOString(),
  }, { onConflict: "day_utc" });
  // Mirror sul ledger EUR per il radar budget manager
  try {
    await recordProviderUsage({
      provider: "apify",
      api_name: "actor_run",
      operation: "scrape",
      calls_count: calls,
      estimated_cost_usd: estUsd,
      cost_basis: "estimate",
    }, meta ?? {});
  } catch { /* best effort */ }
}
