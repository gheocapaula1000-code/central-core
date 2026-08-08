// ═══════════════════════════════════════════════════════════════
// Civiko One — Shared billing helpers (Stripe + entitlements).
//
// Stripe is OPTIONAL at runtime: if env vars are missing the
// orchestrator must continue to work and return billingReady=false.
// No secrets/price IDs are ever leaked into payloads.
// ═══════════════════════════════════════════════════════════════

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getServiceSupabase } from "./civiko.ts";

export const CIVIKO_APP_ID = "civiko_one";
export const CIVIKO_PLANS = ["civiko_studio", "civiko_pro", "civiko_elite"] as const;
export type CivikoPlanKey = typeof CIVIKO_PLANS[number];

export type UsageType =
  | "scan"
  | "owner_report"
  | "piano_esclusiva"
  | "zona_in_movimento"
  | "hyperlocal_signals"
  | "radar";

export const USAGE_COLUMN: Record<UsageType, string> = {
  scan: "scans_used",
  owner_report: "owner_reports_used",
  piano_esclusiva: "piano_esclusiva_used",
  zona_in_movimento: "zona_in_movimento_used",
  hyperlocal_signals: "hyperlocal_signals_used",
  radar: "radar_used",
};

export const USAGE_LIMIT_COLUMN: Partial<Record<UsageType, string>> = {
  scan: "monthly_scans",
  owner_report: "monthly_owner_reports",
  piano_esclusiva: "monthly_piano_esclusiva",
  radar: "monthly_radar",
};

export interface StripeEnv {
  secretKey: string | null;
  webhookSecret: string | null;
  prices: Record<string, string | null>;
  configured: boolean;
  testMode: boolean;
  liveModeBlocked: boolean;
}

export function isStripeTestSecret(value: string | null | undefined): boolean {
  return typeof value === "string" &&
    (value.startsWith("sk_test_") || value.startsWith("rk_test_"));
}

export function readStripeEnv(): StripeEnv {
  const candidate = Deno.env.get("STRIPE_SECRET_KEY") ?? null;
  const testMode = isStripeTestSecret(candidate);
  const liveModeBlocked = !!candidate && !testMode;
  const secretKey = testMode ? candidate : null;
  const webhookSecret = testMode
    ? (Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? null)
    : null;
  const prices: Record<string, string | null> = {
    civiko_studio_monthly: Deno.env.get("CIVIKO_STRIPE_PRICE_STUDIO_MONTHLY") ?? null,
    civiko_pro_monthly: Deno.env.get("CIVIKO_STRIPE_PRICE_PRO_MONTHLY") ?? null,
    civiko_elite_monthly: Deno.env.get("CIVIKO_STRIPE_PRICE_ELITE_MONTHLY") ?? null,
    civiko_studio_annual: Deno.env.get("CIVIKO_STRIPE_PRICE_STUDIO_ANNUAL") ?? null,
    civiko_pro_annual: Deno.env.get("CIVIKO_STRIPE_PRICE_PRO_ANNUAL") ?? null,
    civiko_elite_annual: Deno.env.get("CIVIKO_STRIPE_PRICE_ELITE_ANNUAL") ?? null,
  };
  return {
    secretKey,
    webhookSecret,
    prices,
    configured: testMode,
    testMode,
    liveModeBlocked,
  };
}

export function planFromPriceId(env: StripeEnv, priceId: string): CivikoPlanKey | null {
  if (!priceId) return null;
  for (const [key, val] of Object.entries(env.prices)) {
    if (val && val === priceId) {
      if (key.startsWith("civiko_studio")) return "civiko_studio";
      if (key.startsWith("civiko_pro")) return "civiko_pro";
      if (key.startsWith("civiko_elite")) return "civiko_elite";
    }
  }
  return null;
}

export function currentPeriodKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface ActiveSubscription {
  planKey: CivikoPlanKey | null;
  status: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export async function getActiveSubscription(
  sb: SupabaseClient,
  agencyId: string,
): Promise<ActiveSubscription | null> {
  const { data } = await sb
    .from("billing_subscriptions")
    .select("plan_key,status,stripe_customer_id,stripe_subscription_id,current_period_end,cancel_at_period_end")
    .eq("agency_id", agencyId)
    .eq("app_id", CIVIKO_APP_ID)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    planKey: (data.plan_key ?? null) as CivikoPlanKey | null,
    status: data.status ?? "unknown",
    stripeCustomerId: data.stripe_customer_id ?? null,
    stripeSubscriptionId: data.stripe_subscription_id ?? null,
    currentPeriodEnd: data.current_period_end ?? null,
    cancelAtPeriodEnd: !!data.cancel_at_period_end,
  };
}

export async function getEntitlements(
  sb: SupabaseClient,
  planKey: CivikoPlanKey,
): Promise<Record<string, unknown> | null> {
  const { data } = await sb
    .from("billing_entitlements")
    .select("*")
    .eq("plan_key", planKey)
    .eq("app_id", CIVIKO_APP_ID)
    .maybeSingle();
  return data ?? null;
}

export async function getCurrentUsage(
  sb: SupabaseClient,
  agencyId: string,
  periodKey = currentPeriodKey(),
): Promise<Record<string, number>> {
  const { data } = await sb
    .from("billing_usage")
    .select("scans_used,owner_reports_used,piano_esclusiva_used,zona_in_movimento_used,hyperlocal_signals_used")
    .eq("agency_id", agencyId)
    .eq("app_id", CIVIKO_APP_ID)
    .eq("period_key", periodKey)
    .maybeSingle();
  return {
    scans_used: data?.scans_used ?? 0,
    owner_reports_used: data?.owner_reports_used ?? 0,
    piano_esclusiva_used: data?.piano_esclusiva_used ?? 0,
    zona_in_movimento_used: data?.zona_in_movimento_used ?? 0,
    hyperlocal_signals_used: data?.hyperlocal_signals_used ?? 0,
  };
}

export interface BillingGate {
  allowed: boolean;
  billingReady: boolean;
  plan: CivikoPlanKey | null;
  status: string | null;
  usage: Record<string, number>;
  limits: Record<string, number | null>;
  upgradeRequired: boolean;
  reason?: string;
}

/**
 * Evaluate whether an agency may consume a usage type.
 * If Stripe is not configured (development), allows everything but
 * marks billingReady=false in the response so the PWA knows.
 */
export async function evaluateBillingGate(
  agencyId: string | null | undefined,
  usageType: UsageType,
): Promise<BillingGate> {
  const env = readStripeEnv();
  const sb = getServiceSupabase();

  if (!env.configured || !sb || !agencyId) {
    return {
      allowed: true,
      billingReady: env.configured,
      plan: null,
      status: null,
      usage: {},
      limits: {},
      upgradeRequired: false,
      reason: !env.configured ? "billing_not_configured" : (!agencyId ? "no_agency_id" : undefined),
    };
  }

  const sub = await getActiveSubscription(sb, agencyId);
  if (!sub || !sub.planKey || !["active", "trialing", "past_due"].includes(sub.status)) {
    const usage = await getCurrentUsage(sb, agencyId);
    const usageCol = USAGE_COLUMN[usageType];
    const used = usage[usageCol] ?? 0;
    const trialLimits = {
      monthly_scans: 3 as number | null,
      monthly_owner_reports: 0 as number | null,
      monthly_piano_esclusiva: 0 as number | null,
    };
    if (usageType === "scan" && used < 3) {
      return {
        allowed: true,
        billingReady: true,
        plan: "free_trial" as unknown as CivikoPlanKey,
        status: "trialing",
        usage,
        limits: trialLimits,
        upgradeRequired: false,
      };
    }
    return {
      allowed: false,
      billingReady: true,
      plan: null,
      status: null,
      usage,
      limits: trialLimits,
      upgradeRequired: true,
      reason: "no_active_subscription",
    };
  }

  const ent = await getEntitlements(sb, sub.planKey);
  const usage = await getCurrentUsage(sb, agencyId);
  const limitCol = USAGE_LIMIT_COLUMN[usageType];
  const usageCol = USAGE_COLUMN[usageType];
  const limit = limitCol ? (ent?.[limitCol] as number | null | undefined) ?? null : null;
  const used = usage[usageCol] ?? 0;

  const limits = {
    monthly_scans: (ent?.monthly_scans ?? null) as number | null,
    monthly_owner_reports: (ent?.monthly_owner_reports ?? null) as number | null,
    monthly_piano_esclusiva: (ent?.monthly_piano_esclusiva ?? null) as number | null,
  };

  if (limit != null && used >= limit) {
    return {
      allowed: false,
      billingReady: true,
      plan: sub.planKey,
      status: sub.status,
      usage,
      limits,
      upgradeRequired: true,
      reason: "limit_reached",
    };
  }

  return {
    allowed: true,
    billingReady: true,
    plan: sub.planKey,
    status: sub.status,
    usage,
    limits,
    upgradeRequired: false,
  };
}

export async function recordUsage(
  agencyId: string,
  usageType: UsageType,
  count = 1,
): Promise<void> {
  const sb = getServiceSupabase();
  if (!sb) return;
  const periodKey = currentPeriodKey();
  const col = USAGE_COLUMN[usageType];

  // Upsert pattern: try insert, fall back to update.
  const { data: existing } = await sb
    .from("billing_usage")
    .select("id," + col)
    .eq("agency_id", agencyId)
    .eq("app_id", CIVIKO_APP_ID)
    .eq("period_key", periodKey)
    .maybeSingle();

  const existingRow = existing as unknown as Record<string, unknown> | null;
  if (existingRow && typeof existingRow.id === "number") {
    const cur = existingRow[col] as number | null | undefined;
    await sb
      .from("billing_usage")
      .update({ [col]: (cur ?? 0) + count })
      .eq("id", existingRow.id as number);
  } else {
    await sb.from("billing_usage").insert({
      agency_id: agencyId,
      app_id: CIVIKO_APP_ID,
      period_key: periodKey,
      [col]: count,
    });
  }
}
