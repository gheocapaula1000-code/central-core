// Cap mensile aggregato (Apify + Firecrawl + AI), kill switch trasversale.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getOperationalMode } from "./operationalMode.ts";

function sb() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function getMonthlyTotalUsd(): Promise<{
  total: number;
  apify: number;
  firecrawl: number;
  ai: number;
}> {
  const c = sb();
  if (!c) return { total: 0, apify: 0, firecrawl: 0, ai: 0 };
  const { data } = await c.from("total_spend_current_month").select("*").maybeSingle();
  // deno-lint-ignore no-explicit-any
  const d = data as any;
  const apify = Number(d?.apify_usd ?? 0);
  const firecrawl = Number(d?.firecrawl_usd ?? 0);
  const ai = Number(d?.ai_usd ?? 0);
  return { total: apify + firecrawl + ai, apify, firecrawl, ai };
}

export async function isMonthlyCapReached(): Promise<{ reached: boolean; total: number; cap: number }> {
  const mode = await getOperationalMode();
  const cap = mode.monthly_cap_usd;
  const { total } = await getMonthlyTotalUsd();
  return { reached: total >= cap, total, cap };
}

export async function isMonthlyWarnReached(): Promise<boolean> {
  const mode = await getOperationalMode();
  const { total } = await getMonthlyTotalUsd();
  return total >= mode.monthly_cap_usd * 0.85;
}
