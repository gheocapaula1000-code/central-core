// Endpoint stato budget + modalita' operativa, per dashboard admin.
// Pubblico in lettura (nessun dato sensibile): mostra solo aggregati EUR e modalita'.

import { getOperationalMode } from "../_shared/operationalMode.ts";
import { getMonthlyTotalUsd } from "../_shared/monthlyBudget.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const USD_EUR = 0.92;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    const mode = await getOperationalMode();
    const { total, apify, firecrawl, ai } = await getMonthlyTotalUsd();

    const days_remaining = mode.test_ends_at
      ? Math.max(0, Math.ceil((new Date(mode.test_ends_at).getTime() - Date.now()) / 86_400_000))
      : null;

    const cap = mode.monthly_cap_usd;
    const status = total >= cap ? "blocked" : total >= cap * 0.85 ? "warning" : "ok";

    const body = {
      mode: mode.mode,
      test_started_at: mode.test_started_at,
      test_ends_at: mode.test_ends_at,
      days_remaining,
      heavy_cron_every_n_days: mode.heavy_cron_every_n_days,
      caps: {
        monthly_usd: cap,
        monthly_eur: Number((cap * USD_EUR).toFixed(2)),
        firecrawl_daily_credits: mode.firecrawl_daily_cap_credits,
        ai_daily_usd: mode.ai_daily_cap_usd,
      },
      spend_current_month: {
        apify_usd: Number(apify.toFixed(2)),
        apify_eur: Number((apify * USD_EUR).toFixed(2)),
        firecrawl_usd: Number(firecrawl.toFixed(2)),
        firecrawl_eur: Number((firecrawl * USD_EUR).toFixed(2)),
        ai_usd: Number(ai.toFixed(2)),
        ai_eur: Number((ai * USD_EUR).toFixed(2)),
        total_usd: Number(total.toFixed(2)),
        total_eur: Number((total * USD_EUR).toFixed(2)),
      },
      status,
    };

    return new Response(JSON.stringify(body), {
      headers: { ...CORS, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      headers: { ...CORS, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
