// Budget guard fonti lead privati.
// Cap soft mensile: $8 USD. Stato 2026-06-20: dedicato a Subito (Bakeca disattivata).
// Se superato, salta il run successivo e logga. Non blocca l'intero cron, solo Subito.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export const PRIVATE_LEADS_MONTHLY_CAP_USD = 8;


function sb() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7); // "2026-06"
}

export interface PrivateLeadsBudget {
  year_month: string;
  apify_usd: number;
  firecrawl_usd: number;
  total_usd: number;
  cap_usd: number;
  remaining_usd: number;
  reached: boolean;
}

export async function getPrivateLeadsBudget(): Promise<PrivateLeadsBudget> {
  const ym = currentYearMonth();
  const c = sb();
  if (!c) {
    return {
      year_month: ym,
      apify_usd: 0,
      firecrawl_usd: 0,
      total_usd: 0,
      cap_usd: PRIVATE_LEADS_MONTHLY_CAP_USD,
      remaining_usd: PRIVATE_LEADS_MONTHLY_CAP_USD,
      reached: false,
    };
  }
  const { data } = await c
    .from("private_leads_spend_monthly")
    .select("year_month, apify_usd, firecrawl_usd, total_usd")
    .eq("year_month", ym)
    .maybeSingle();
  // deno-lint-ignore no-explicit-any
  const d = data as any;
  const apify_usd = Number(d?.apify_usd ?? 0);
  const firecrawl_usd = Number(d?.firecrawl_usd ?? 0);
  const total_usd = Number(d?.total_usd ?? apify_usd + firecrawl_usd);
  return {
    year_month: ym,
    apify_usd,
    firecrawl_usd,
    total_usd,
    cap_usd: PRIVATE_LEADS_MONTHLY_CAP_USD,
    remaining_usd: Math.max(0, PRIVATE_LEADS_MONTHLY_CAP_USD - total_usd),
    reached: total_usd >= PRIVATE_LEADS_MONTHLY_CAP_USD,
  };
}

export async function recordPrivateLeadsSpend(
  provider: "apify" | "firecrawl",
  estUsd: number,
): Promise<void> {
  if (!estUsd || estUsd <= 0) return;
  const c = sb();
  if (!c) return;
  const ym = currentYearMonth();
  const cur = await getPrivateLeadsBudget();
  const next = {
    year_month: ym,
    apify_usd: Number((cur.apify_usd + (provider === "apify" ? estUsd : 0)).toFixed(4)),
    firecrawl_usd: Number((cur.firecrawl_usd + (provider === "firecrawl" ? estUsd : 0)).toFixed(4)),
    updated_at: new Date().toISOString(),
  };
  await c.from("private_leads_spend_monthly").upsert(next, { onConflict: "year_month" });
}
