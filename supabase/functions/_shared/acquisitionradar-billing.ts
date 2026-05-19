// ═══════════════════════════════════════════════════════════════
// AcquisitionRadar — Stripe billing config (centralized)
//
// Single source of truth for:
//   • Stripe secret key + mode detection (test / live / unconfigured)
//   • price_id → plan mapping (test fallbacks, live via env vars)
//   • Default return URLs for AcquisitionRadar PWA
//
// Go-live procedure: set the AR_STRIPE_PRICE_* env vars to live price
// IDs and swap STRIPE_SECRET_KEY to a sk_live_* value. No code change.
// ═══════════════════════════════════════════════════════════════

export type StripeMode = "test" | "live" | "unconfigured";

export interface StripeConfig {
  secretKey: string | null;
  webhookSecret: string | null;
  mode: StripeMode;
  configured: boolean;
}

export function getStripeConfig(): StripeConfig {
  const secretKey = Deno.env.get("STRIPE_SECRET_KEY") ?? null;
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? null;
  let mode: StripeMode = "unconfigured";
  if (secretKey?.startsWith("sk_live_")) mode = "live";
  else if (secretKey?.startsWith("sk_test_") || secretKey?.startsWith("rk_test_")) mode = "test";
  return { secretKey, webhookSecret, mode, configured: !!secretKey };
}

// ── AcquisitionRadar plans ──────────────────────────────────────
// price_id → plan name. Test IDs are hardcoded as fallback so that
// the existing test mode keeps working until live IDs are wired in
// via AR_STRIPE_PRICE_*_LIVE env vars.

export type ArPlan = "agente" | "agenzia" | "studio";

interface PlanEntry {
  plan: ArPlan;
  monthlyTestId: string;
  annualTestId: string;
  monthlyEnvKey: string; // env var holding the LIVE monthly price_id
  annualEnvKey: string;  // env var holding the LIVE annual price_id
}

const AR_PLANS: PlanEntry[] = [
  {
    plan: "agente",
    monthlyTestId: "price_1TYSCWGWMFww3yH4OJQnZLvD",
    annualTestId:  "price_1TYSCWGWMFww3yH4Q5r622nu",
    monthlyEnvKey: "AR_STRIPE_PRICE_AGENTE_MONTHLY",
    annualEnvKey:  "AR_STRIPE_PRICE_AGENTE_ANNUAL",
  },
  {
    plan: "agenzia",
    monthlyTestId: "price_1TYSEKGWMFww3yH4LjVMx2FI",
    annualTestId:  "price_1TYSEKGWMFww3yH4WlaLOCjL",
    monthlyEnvKey: "AR_STRIPE_PRICE_AGENZIA_MONTHLY",
    annualEnvKey:  "AR_STRIPE_PRICE_AGENZIA_ANNUAL",
  },
  {
    plan: "studio",
    monthlyTestId: "price_1TYSFqGWMFww3yH4nYOrpPfV",
    annualTestId:  "price_1TYSFqGWMFww3yH4W1rg9sGH",
    monthlyEnvKey: "AR_STRIPE_PRICE_STUDIO_MONTHLY",
    annualEnvKey:  "AR_STRIPE_PRICE_STUDIO_ANNUAL",
  },
];

/**
 * Returns map price_id → plan name, including both the test fallbacks
 * and any live IDs configured via env vars. Same price_id resolves
 * to the same plan regardless of mode, so the mapping stays stable
 * during the test → live transition.
 */
export function getPriceToPlanMap(): Record<string, ArPlan> {
  const map: Record<string, ArPlan> = {};
  for (const p of AR_PLANS) {
    map[p.monthlyTestId] = p.plan;
    map[p.annualTestId] = p.plan;
    const liveMonthly = Deno.env.get(p.monthlyEnvKey);
    const liveAnnual = Deno.env.get(p.annualEnvKey);
    if (liveMonthly) map[liveMonthly] = p.plan;
    if (liveAnnual) map[liveAnnual] = p.plan;
  }
  return map;
}

export function planFromPriceId(priceId: string): ArPlan | "" {
  return getPriceToPlanMap()[priceId] ?? "";
}

// ── Default URLs (AcquisitionRadar PWA) ─────────────────────────
export const AR_DEFAULT_ACCOUNT_URL  = "https://acquisitionradar.app/account";
export const AR_DEFAULT_CHECKOUT_OK  = "https://acquisitionradar.app/account?checkout=success";
export const AR_DEFAULT_CHECKOUT_KO  = "https://acquisitionradar.app/account?checkout=cancel";
