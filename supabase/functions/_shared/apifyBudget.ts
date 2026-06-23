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
import { isRadarMonthlyHardCapReached, recordProviderUsage } from "./radarBudget.ts";

export const APIFY_DAILY_CAP_USD = Number(Deno.env.get("APIFY_DAILY_CAP_USD") ?? "25");

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
export async function canSpendApify(estUsd: number): Promise<{ ok: boolean; spent: number; cap: number; reason?: string }> {
  if (await isRadarMonthlyHardCapReached()) {
    return { ok: false, spent: 0, cap: 0, reason: "radar_monthly_eur_cap_reached" };
  }
  const monthly = await isMonthlyCapReached();
  if (monthly.reached) {
    return { ok: false, spent: monthly.total, cap: monthly.cap, reason: "monthly_cap_reached" };
  }
  const cap = APIFY_DAILY_CAP_USD;
  const { est_usd } = await getApifySpendToday();
  return { ok: est_usd + estUsd <= cap, spent: est_usd, cap };
}

export async function recordApifySpend(estUsd: number, calls = 1): Promise<void> {
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
}
