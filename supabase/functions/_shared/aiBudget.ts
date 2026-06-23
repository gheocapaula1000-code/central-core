// Budget AI — cap giornaliero in USD aggregato su tutti i provider, letto da operational_mode.
//
// Uso:
//   const b = await canSpendAi(estTokens, "openai");
//   if (!b.ok) return { error: "AI_DAILY_CAP_REACHED" };
//   ...call provider...
//   await recordAiSpend("openai", inputTokens, outputTokens);

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getOperationalMode } from "./operationalMode.ts";
import { isRadarMonthlyHardCapReached, recordProviderUsage } from "./radarBudget.ts";

// Costo blended (input+output) per 1M token. Volutamente prudente.
export const AI_COST_PER_1M: Record<string, number> = {
  openai: 5.0,
  anthropic: 3.0,
  perplexity: 1.0,
  lovable: 2.0,
};

function sb() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getAiSpendToday(): Promise<number> {
  const c = sb();
  if (!c) return 0;
  const { data } = await c.from("ai_spend_daily").select("est_usd").eq("day_utc", today());
  if (!data) return 0;
  // deno-lint-ignore no-explicit-any
  return (data as any[]).reduce((sum, r) => sum + Number(r?.est_usd ?? 0), 0);
}

export async function canSpendAi(
  estTokens: number,
  provider: string,
): Promise<{ ok: boolean; spent: number; cap: number; reason?: string }> {
  if (await isRadarMonthlyHardCapReached()) {
    return { ok: false, spent: 0, cap: 0, reason: "radar_monthly_eur_cap_reached" };
  }
  const mode = await getOperationalMode();
  const cap = mode.ai_daily_cap_usd;
  const spent = await getAiSpendToday();
  const cost = (estTokens / 1_000_000) * (AI_COST_PER_1M[provider] ?? 5);
  return { ok: spent + cost <= cap, spent, cap };
}

export async function recordAiSpend(
  provider: string,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  const c = sb();
  if (!c) return;
  const day = today();
  const tot = (inputTokens ?? 0) + (outputTokens ?? 0);
  const usd = (tot / 1_000_000) * (AI_COST_PER_1M[provider] ?? 5);
  const { data: cur } = await c
    .from("ai_spend_daily")
    .select("calls, input_tokens, output_tokens, est_usd")
    .eq("day_utc", day)
    .eq("provider", provider)
    .maybeSingle();
  // deno-lint-ignore no-explicit-any
  const d = cur as any;
  await c.from("ai_spend_daily").upsert(
    {
      day_utc: day,
      provider,
      calls: Number(d?.calls ?? 0) + 1,
      input_tokens: Number(d?.input_tokens ?? 0) + (inputTokens ?? 0),
      output_tokens: Number(d?.output_tokens ?? 0) + (outputTokens ?? 0),
      est_usd: Number((Number(d?.est_usd ?? 0) + usd).toFixed(4)),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "day_utc,provider" },
  );
}
