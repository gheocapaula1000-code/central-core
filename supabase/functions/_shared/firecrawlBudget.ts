// Budget Firecrawl — cap giornaliero in "crediti" (~ pagine), letto da operational_mode.
//
// Uso:
//   const b = await canSpendFirecrawl(estPages);
//   if (!b.ok) return; // skip + log
//   ...do work...
//   await recordFirecrawlSpend(actualPagesScraped);

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getOperationalMode } from "./operationalMode.ts";
import { isRadarMonthlyHardCapReached, recordProviderUsage } from "./radarBudget.ts";

export const FIRECRAWL_USD_PER_PAGE = 0.001;

function sb() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getFirecrawlSpendToday(): Promise<{ calls: number; pages: number; est_usd: number }> {
  const c = sb();
  if (!c) return { calls: 0, pages: 0, est_usd: 0 };
  const { data } = await c
    .from("firecrawl_spend_daily")
    .select("calls, pages, est_usd")
    .eq("day_utc", today())
    .maybeSingle();
  // deno-lint-ignore no-explicit-any
  const d = data as any;
  return {
    calls: Number(d?.calls ?? 0),
    pages: Number(d?.pages ?? 0),
    est_usd: Number(d?.est_usd ?? 0),
  };
}

export async function canSpendFirecrawl(estPages: number): Promise<{ ok: boolean; spent: number; cap: number; reason?: string }> {
  if (await isRadarMonthlyHardCapReached()) {
    return { ok: false, spent: 0, cap: 0, reason: "radar_monthly_eur_cap_reached" };
  }
  const mode = await getOperationalMode();
  const cap = mode.firecrawl_daily_cap_credits;
  const { pages } = await getFirecrawlSpendToday();
  return { ok: pages + estPages <= cap, spent: pages, cap };
}

export async function recordFirecrawlSpend(pages: number, calls = 1): Promise<void> {
  const c = sb();
  if (!c) return;
  const day = today();
  const cur = await getFirecrawlSpendToday();
  const addUsd = pages * FIRECRAWL_USD_PER_PAGE;
  await c.from("firecrawl_spend_daily").upsert(
    {
      day_utc: day,
      calls: cur.calls + calls,
      pages: cur.pages + pages,
      est_usd: Number((cur.est_usd + addUsd).toFixed(4)),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "day_utc" },
  );
}
