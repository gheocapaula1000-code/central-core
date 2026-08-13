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

// ═══════════════════════════════════════════════════════════════
// Checkpoint 9C — prezzo mensile autoritativo per fascia territoriale.
//
// Al lancio esiste SOLO il pagamento mensile. Il prezzo è derivato
// server-side dalla zona commerciale riservata all'agenzia
// (trial o occupata). Il client non è mai autoritativo su tier,
// importo, valuta o Price ID.
//
// Aggiornamento commerciale (ago 2026): standard 1.490 € · premium 1.990 €
// ═══════════════════════════════════════════════════════════════

import {
  CIVIKO_COMMERCIAL_ZONES,
  isCivikoCommercialZoneSlug,
  type CivikoCommercialZoneSlug,
} from "./civikoCommercialZoneContract.ts";

export type CivikoZoneTier = "premium" | "standard" | "entry";

/** Canone mensile autoritativo in EUR per fascia. */
export const CIVIKO_TIER_MONTHLY_EUR: Readonly<Record<CivikoZoneTier, number>> = {
  premium: 1990,
  standard: 1490,
  entry: 990,
};

/** Variabile ambiente del Price Stripe mensile per fascia. */
export const CIVIKO_TIER_PRICE_ENV: Readonly<Record<CivikoZoneTier, string>> = {
  premium: "STRIPE_PRICE_CIVIKO_PREMIUM_MONTHLY",
  standard: "STRIPE_PRICE_CIVIKO_STANDARD_MONTHLY",
  entry: "STRIPE_PRICE_CIVIKO_ENTRY_MONTHLY",
};

/** Al lancio è ammesso soltanto il mensile. */
export function isCivikoLaunchInterval(interval: string): boolean {
  return interval === "month";
}

export function isCivikoZoneTier(value: unknown): value is CivikoZoneTier {
  return value === "premium" || value === "standard" || value === "entry";
}

export interface CivikoZoneRowForPricing {
  slug?: unknown;
  tier?: unknown;
  canone_mese_eur?: unknown;
  trial_agency_id?: unknown;
  occupied_agency_id?: unknown;
}

export interface CivikoZonePricing {
  zoneSlug: CivikoCommercialZoneSlug;
  zoneTier: CivikoZoneTier;
  canoneMeseEur: number;
  priceEnvVar: string;
}

export type CivikoZonePricingErrorCode =
  | "NO_ZONE_ASSIGNED"
  | "MULTIPLE_ZONES_ASSIGNED"
  | "ZONE_NOT_OFFICIAL"
  | "ZONE_PRICING_INVALID";

export type CivikoZonePricingResult =
  | { ok: true; value: CivikoZonePricing }
  | { ok: false; error: { code: CivikoZonePricingErrorCode; message: string } };

const OFFICIAL_SLUG_SET: ReadonlySet<string> = new Set(
  CIVIKO_COMMERCIAL_ZONES.map((z) => z.slug),
);

/**
 * Deriva la fascia e il prezzo mensile dalla zona riservata all'agenzia.
 * Checkpoint 11B-A: sono ammesse tutte e 8 le zone ufficiali.
 * Fail-closed: zero zone, più di una zona, slug non ufficiale o
 * tier/canone incoerenti bloccano il checkout.
 */
export function resolveCivikoZonePricing(
  rows: readonly CivikoZoneRowForPricing[] | null | undefined,
  workspaceId: string,
): CivikoZonePricingResult {
  const wid = (workspaceId ?? "").trim();
  if (!wid) {
    return { ok: false, error: { code: "NO_ZONE_ASSIGNED", message: "Nessuna zona attiva per questa agenzia." } };
  }

  const owned = (rows ?? []).filter((r) =>
    (typeof r.trial_agency_id === "string" && r.trial_agency_id === wid) ||
    (typeof r.occupied_agency_id === "string" && r.occupied_agency_id === wid)
  );

  const uniqueSlugs = [...new Set(owned.map((r) => String(r.slug ?? "")))].filter((s) => s.length > 0);

  if (uniqueSlugs.length === 0) {
    return { ok: false, error: { code: "NO_ZONE_ASSIGNED", message: "Nessuna zona attiva per questa agenzia." } };
  }
  if (uniqueSlugs.length > 1) {
    return { ok: false, error: { code: "MULTIPLE_ZONES_ASSIGNED", message: "Più di una zona attiva per questa agenzia." } };
  }

  const slug = uniqueSlugs[0];
  if (!OFFICIAL_SLUG_SET.has(slug) || !isCivikoCommercialZoneSlug(slug)) {
    return { ok: false, error: { code: "ZONE_NOT_OFFICIAL", message: "Zona non riconosciuta." } };
  }

  const row = owned.find((r) => String(r.slug ?? "") === slug)!;
  const tier = typeof row.tier === "string" ? row.tier.trim().toLowerCase() : "";
  if (!isCivikoZoneTier(tier)) {
    return { ok: false, error: { code: "ZONE_PRICING_INVALID", message: "Configurazione di prezzo non valida." } };
  }

  const canoneRaw = row.canone_mese_eur;
  const canone = typeof canoneRaw === "number" ? canoneRaw : Number(canoneRaw);
  if (!Number.isFinite(canone) || canone !== CIVIKO_TIER_MONTHLY_EUR[tier]) {
    return { ok: false, error: { code: "ZONE_PRICING_INVALID", message: "Configurazione di prezzo non valida." } };
  }

  return {
    ok: true,
    value: {
      zoneSlug: slug,
      zoneTier: tier,
      canoneMeseEur: canone,
      priceEnvVar: CIVIKO_TIER_PRICE_ENV[tier],
    },
  };
}
