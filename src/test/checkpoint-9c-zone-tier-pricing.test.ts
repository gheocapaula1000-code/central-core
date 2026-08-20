import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  resolveCivikoZonePricing,
  isCivikoLaunchInterval,
  CIVIKO_TIER_MONTHLY_EUR,
  CIVIKO_TIER_PRICE_ENV,
} from "../../supabase/functions/_shared/civikoCheckoutContract";

const SRC = readFileSync("supabase/functions/civiko-billing/index.ts", "utf8");
const errCode = (r: { ok: boolean } & Record<string, unknown>) =>
  (r as { error?: { code?: string } }).error?.code ?? null;

const ROUTE_SRC = SRC.slice(SRC.indexOf("async function handleCreateCheckoutDirect"));

const WID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const zone = (slug: string, tier: string, canone: number, owner: "trial" | "occ" = "trial", who = WID) => ({
  slug,
  tier,
  canone_mese_eur: canone,
  trial_agency_id: owner === "trial" ? who : null,
  occupied_agency_id: owner === "occ" ? who : null,
});

describe("9C — matrice prezzi per fascia", () => {
  it("fissa i canoni autoritativi", () => {
    expect(CIVIKO_TIER_MONTHLY_EUR).toEqual({ premium: 1990, standard: 1490, entry: 990 });
  });

  it("usa tre variabili Stripe dedicate", () => {
    expect(CIVIKO_TIER_PRICE_ENV.premium).toBe("STRIPE_PRICE_CIVIKO_PREMIUM_MONTHLY");
    expect(CIVIKO_TIER_PRICE_ENV.standard).toBe("STRIPE_PRICE_CIVIKO_STANDARD_MONTHLY");
    expect(CIVIKO_TIER_PRICE_ENV.entry).toBe("STRIPE_PRICE_CIVIKO_ENTRY_MONTHLY");
  });

  it("accetta solo il mensile al lancio", () => {
    expect(isCivikoLaunchInterval("month")).toBe(true);
    expect(isCivikoLaunchInterval("year")).toBe(false);
  });
});

describe("9C — derivazione server-side del prezzo", () => {
  it("centro-storico premium 1990 → variabile premium", () => {
    const r = resolveCivikoZonePricing([zone("centro-storico", "premium", 1990)], WID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.zoneSlug).toBe("centro-storico");
      expect(r.value.zoneTier).toBe("premium");
      expect(r.value.canoneMeseEur).toBe(1990);
      expect(r.value.priceEnvVar).toBe("STRIPE_PRICE_CIVIKO_PREMIUM_MONTHLY");
    }
  });

  it("zona occupata standard → variabile standard (fuori pilot)", () => {
    const r = resolveCivikoZonePricing([zone("nord-arcella", "standard", 1490, "occ")], WID);
    expect(r.ok && r.value.priceEnvVar).toBe("STRIPE_PRICE_CIVIKO_STANDARD_MONTHLY");
  });

  it("zona entry → variabile entry (fuori pilot)", () => {
    const r = resolveCivikoZonePricing([zone("est-brenta", "entry", 990)], WID);
    expect(r.ok && r.value.priceEnvVar).toBe("STRIPE_PRICE_CIVIKO_ENTRY_MONTHLY");
  });

  it("nessuna zona → respinto", () => {
    expect(resolveCivikoZonePricing([], WID).ok).toBe(false);
    expect(resolveCivikoZonePricing([zone("centro-storico", "premium", 1990, "trial", OTHER)], WID).ok).toBe(false);
  });

  it("doppia zona → respinto", () => {
    const r = resolveCivikoZonePricing(
      [zone("centro-storico", "premium", 1990), zone("nord-arcella", "standard", 1490, "occ")],
      WID,
    );
    expect(r.ok).toBe(false);
    expect(errCode(r)).toBe("MULTIPLE_ZONES_ASSIGNED");
  });

  it("slug estraneo al contratto → respinto", () => {
    const r = resolveCivikoZonePricing([zone("zona-fantasma", "premium", 1990)], WID);
    expect(r.ok).toBe(false);
    expect(errCode(r)).toBe("ZONE_NOT_OFFICIAL");
  });

  it("zona ufficiale non pilot → accettata (8 zone aperte, 11B-A)", () => {
    const r = resolveCivikoZonePricing([zone("nord-arcella", "standard", 1490)], WID);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.zoneSlug).toBe("nord-arcella");
  });

  it("tier/canone incoerenti → respinti", () => {
    for (const bad of [
      zone("centro-storico", "premium", 1490),
      zone("centro-storico", "standard", 1990),
      zone("centro-storico", "gold", 1990),
      zone("centro-storico", "premium", NaN as unknown as number),
    ]) {
      const r = resolveCivikoZonePricing([bad], WID);
      expect(r.ok).toBe(false);
      expect(errCode(r)).toBe("ZONE_PRICING_INVALID");
    }
  });
});

describe("9C — integrazione nella route create-checkout-direct", () => {
  it("blocca l'annuale prima di qualunque chiamata Stripe", () => {
    expect(SRC).toContain("if (!isCivikoLaunchInterval(billingInterval))");
    const gate = ROUTE_SRC.indexOf("isCivikoLaunchInterval(billingInterval)");
    const firstStripeCall = ROUTE_SRC.indexOf("api.stripe.com/v1/customers/search");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(firstStripeCall);
  });

  it("risolve la zona e il prezzo prima di qualunque chiamata Stripe", () => {
    const pricing = ROUTE_SRC.indexOf("resolveCivikoZonePricing(zoneRows ?? [], workspaceId)");
    const priceEnv = ROUTE_SRC.indexOf("Deno.env.get(pricing.value.priceEnvVar)");
    const firstStripeCall = ROUTE_SRC.indexOf("api.stripe.com/v1/customers/search");
    expect(pricing).toBeGreaterThan(0);
    expect(priceEnv).toBeGreaterThan(pricing);
    expect(priceEnv).toBeLessThan(firstStripeCall);
  });

  it("non usa più la vecchia variabile mensile/annuale nella route", () => {
    expect(SRC).not.toContain("contract.value.priceEnvVar");
    expect(SRC).not.toContain("STRIPE_PRICE_CIVIKO_MONTHLY");
    expect(SRC).not.toContain("STRIPE_PRICE_CIVIKO_YEARLY");
  });

  it("fail-closed se la variabile Stripe della fascia manca", () => {
    expect(SRC).toContain('"PRICE_NOT_CONFIGURED"');
  });

  it("non legge mai campi economici o client Stripe dal body", () => {
    for (const f of ["body.tier", "body.price_id", "body.amount", "body.currency", "body.customer", "body.subscription"]) {
      expect(SRC).not.toContain(f);
    }
  });

  it("scrive i metadata canonici con zona e fascia", () => {
    for (const m of [
      '"metadata[zone_slug]": zoneSlug',
      '"metadata[zone_tier]": zoneTier',
      '"subscription_data[metadata][zone_slug]": zoneSlug',
      '"subscription_data[metadata][zone_tier]": zoneTier',
      '"metadata[app]": "civiko"',
    ]) {
      expect(SRC).toContain(m);
    }
  });
});
