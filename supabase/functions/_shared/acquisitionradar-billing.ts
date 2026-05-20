// ═══════════════════════════════════════════════════════════════
// AcquisitionRadar — Stripe billing config (centralized)
//
// MVP Padova Comune: piano UNICO "agenzia" (premium)
//   • mensile  1490 EUR  → AR_STRIPE_PRICE_AGENZIA_MONTHLY
//   • annuale 14900 EUR  → AR_STRIPE_PRICE_AGENZIA_ANNUAL
//
// Per ogni interval esistono DUE env var:
//   • *_MONTHLY / *_ANNUAL          → price ID LIVE  (sk_live_*)
//   • *_MONTHLY_TEST / *_ANNUAL_TEST → price ID TEST (sk_test_*)
//
// I price_id NON sono mai hardcoded: solo via env. Nessun fallback ai
// vecchi listini 499/4990. Rotazione = aggiornare i secret, non il codice.
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

// ── AR plan (MVP: single plan "agenzia") ────────────────────────
export type ArPlan = "agenzia";
export type ArInterval = "monthly" | "annual";

interface AllowedPriceEntry {
  plan: ArPlan;
  interval: ArInterval;
  envKeyLive: string;
  envKeyTest: string;
}

const AR_PRICE_REGISTRY: AllowedPriceEntry[] = [
  { plan: "agenzia", interval: "monthly", envKeyLive: "AR_STRIPE_PRICE_AGENZIA_MONTHLY", envKeyTest: "AR_STRIPE_PRICE_AGENZIA_MONTHLY_TEST" },
  { plan: "agenzia", interval: "annual",  envKeyLive: "AR_STRIPE_PRICE_AGENZIA_ANNUAL",  envKeyTest: "AR_STRIPE_PRICE_AGENZIA_ANNUAL_TEST"  },
];

export interface ResolvedPrice {
  priceId: string;
  plan: ArPlan;
  interval: ArInterval;
  envKey: string;
}

/** Costruisce la mappa price_id → entry, leggendo TUTTE le env var configurate. */
function buildAllowedMap(): Map<string, ResolvedPrice> {
  const map = new Map<string, ResolvedPrice>();
  for (const e of AR_PRICE_REGISTRY) {
    for (const envKey of [e.envKeyLive, e.envKeyTest]) {
      const id = Deno.env.get(envKey);
      if (id && id.trim().length > 0) {
        map.set(id.trim(), { priceId: id.trim(), plan: e.plan, interval: e.interval, envKey });
      }
    }
  }
  return map;
}

/** True se il price_id è esplicitamente allowlistato via env per Acquisition Radar. */
export function resolveArPrice(priceId: string): ResolvedPrice | null {
  if (!priceId) return null;
  return buildAllowedMap().get(priceId.trim()) ?? null;
}

/** Compatibilità: plan name dal price_id (vuoto se non allowlistato). */
export function planFromPriceId(priceId: string): ArPlan | "" {
  return resolveArPrice(priceId)?.plan ?? "";
}

/** Restituisce i price_id configurati e quali env mancano (utile per diagnostica). */
export function arPriceConfigStatus(): {
  configured: Array<{ envKey: string; priceId: string; plan: ArPlan; interval: ArInterval }>;
  missing: string[];
} {
  const configured: Array<{ envKey: string; priceId: string; plan: ArPlan; interval: ArInterval }> = [];
  const missing: string[] = [];
  for (const e of AR_PRICE_REGISTRY) {
    const live = Deno.env.get(e.envKeyLive);
    if (live) configured.push({ envKey: e.envKeyLive, priceId: live, plan: e.plan, interval: e.interval });
    else missing.push(e.envKeyLive);
  }
  return { configured, missing };
}

// ── URL allowlist (AcquisitionRadar PWA) ────────────────────────
export const AR_ALLOWED_HOSTS = new Set<string>([
  "acquisitionradar.it",
  "www.acquisitionradar.it",
  "acquisitionradar.app",
  "www.acquisitionradar.app",
]);

export const AR_DEFAULT_ACCOUNT_URL  = "https://acquisitionradar.it/account";
export const AR_DEFAULT_CHECKOUT_OK  = "https://acquisitionradar.it/checkout/successo";
export const AR_DEFAULT_CHECKOUT_KO  = "https://acquisitionradar.it/pricing";

/** Valida che l'URL sia https e appartenga a un host AR consentito. */
export function isAllowedArUrl(raw: string | undefined | null): boolean {
  if (!raw || typeof raw !== "string") return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    return AR_ALLOWED_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}
