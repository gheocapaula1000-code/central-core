// ═══════════════════════════════════════════════════════════════
// Civiko One — contratto canonico /create-checkout-direct
// Modulo puro (nessun import Deno/rete): usato dalla edge function
// e dai test statici.
// ═══════════════════════════════════════════════════════════════

export type CivikoBillingInterval = "month" | "year";

export interface CivikoCheckoutContract {
  plan: "agenzia";
  billingInterval: CivikoBillingInterval;
  priceEnvVar: "STRIPE_PRICE_CIVIKO_MONTHLY" | "STRIPE_PRICE_CIVIKO_YEARLY";
}

export interface CivikoCheckoutContractError {
  code: "INVALID_BODY";
  message: string;
}

export type CivikoCheckoutContractResult =
  | { ok: true; value: CivikoCheckoutContract }
  | { ok: false; error: CivikoCheckoutContractError };

const ALLOWED_HOSTS = new Set(["civikoone.com", "www.civikoone.com"]);
const ALLOWED_SUFFIXES = [".lovable.app", ".lovableproject.com"];

/** Campi economici/client Stripe mai accettati dal chiamante. */
export const FORBIDDEN_CLIENT_FIELDS = [
  "price_id",
  "price",
  "amount",
  "unit_amount",
  "currency",
  "customer",
  "customer_id",
  "stripe_customer_id",
  "subscription",
  "subscription_id",
  "stripe_subscription_id",
  "coupon",
  "trial_period_days",
] as const;

function normalizeInterval(raw: string): CivikoBillingInterval | null {
  const v = raw.trim().toLowerCase();
  if (v === "month" || v === "monthly") return "month";
  if (v === "year" || v === "yearly" || v === "annual" || v === "annually") return "year";
  return null;
}

/**
 * Risolve il contratto canonico:
 *  - plan="agenzia" con billing_interval/interval = month|year
 *  - legacy plan="monthly"|"yearly" → normalizzati a month|year
 * Tutto il resto è respinto fail-closed.
 */
export function resolveCivikoCheckoutContract(
  body: Record<string, unknown>,
): CivikoCheckoutContractResult {
  const plan = String(body.plan ?? "").trim().toLowerCase();

  const rawBilling = body.billing_interval == null ? "" : String(body.billing_interval).trim().toLowerCase();
  const rawInterval = body.interval == null ? "" : String(body.interval).trim().toLowerCase();

  if (rawBilling && rawInterval && rawBilling !== rawInterval) {
    return {
      ok: false,
      error: { code: "INVALID_BODY", message: "billing_interval e interval non coincidono." },
    };
  }

  let interval: CivikoBillingInterval | null = null;

  if (plan === "agenzia") {
    const raw = rawBilling || rawInterval;
    if (!raw) {
      return {
        ok: false,
        error: { code: "INVALID_BODY", message: "billing_interval è obbligatorio: 'month' o 'year'." },
      };
    }
    if (raw !== "month" && raw !== "year") {
      return {
        ok: false,
        error: { code: "INVALID_BODY", message: "billing_interval deve essere 'month' o 'year'." },
      };
    }
    interval = raw;
  } else if (plan === "monthly" || plan === "yearly") {
    // Compatibilità legacy.
    const legacy = plan === "monthly" ? "month" : "year";
    if (rawBilling || rawInterval) {
      const provided = normalizeInterval(rawBilling || rawInterval);
      if (!provided) {
        return {
          ok: false,
          error: { code: "INVALID_BODY", message: "billing_interval deve essere 'month' o 'year'." },
        };
      }
      if (provided !== legacy) {
        return {
          ok: false,
          error: { code: "INVALID_BODY", message: "billing_interval non coerente con il piano richiesto." },
        };
      }
    }
    interval = legacy;
  } else {
    return {
      ok: false,
      error: { code: "INVALID_BODY", message: "plan non consentito: usare 'agenzia'." },
    };
  }

  return {
    ok: true,
    value: {
      plan: "agenzia",
      billingInterval: interval,
      priceEnvVar: interval === "month" ? "STRIPE_PRICE_CIVIKO_MONTHLY" : "STRIPE_PRICE_CIVIKO_YEARLY",
    },
  };
}

/** URL di ritorno consentiti: solo HTTPS su domini Civiko/Lovable. */
export function isAllowedCivikoReturnUrl(raw: string): boolean {
  const value = (raw ?? "").trim();
  if (!value) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (ALLOWED_HOSTS.has(host)) return true;
  return ALLOWED_SUFFIXES.some((s) => host.endsWith(s));
}
