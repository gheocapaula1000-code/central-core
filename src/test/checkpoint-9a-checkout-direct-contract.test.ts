import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  resolveCivikoCheckoutContract,
  isAllowedCivikoReturnUrl,
  FORBIDDEN_CLIENT_FIELDS,
} from "../../supabase/functions/_shared/civikoCheckoutContract";

const SRC = readFileSync("supabase/functions/civiko-billing/index.ts", "utf8");

const base = {
  app: "civiko",
  workspace_id: "11111111-1111-4111-8111-111111111111",
  supabase_user_id: "22222222-2222-4222-8222-222222222222",
  email: "a@b.it",
  success_url: "https://civikoone.com/ok",
  cancel_url: "https://civikoone.com/ko",
};

describe("checkpoint 9A — contratto canonico create-checkout-direct", () => {
  it("accetta il canonico mensile", () => {
    const r = resolveCivikoCheckoutContract({ ...base, plan: "agenzia", billing_interval: "month", interval: "month" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.plan).toBe("agenzia");
      expect(r.value.billingInterval).toBe("month");
      expect(r.value.priceEnvVar).toBe("STRIPE_PRICE_CIVIKO_MONTHLY");
    }
  });

  it("accetta il canonico annuale", () => {
    const r = resolveCivikoCheckoutContract({ ...base, plan: "agenzia", billing_interval: "year" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.priceEnvVar).toBe("STRIPE_PRICE_CIVIKO_YEARLY");
  });

  it("accetta interval come alias quando billing_interval manca", () => {
    const r = resolveCivikoCheckoutContract({ ...base, plan: "agenzia", interval: "year" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.billingInterval).toBe("year");
  });

  it("respinge interval e billing_interval discordanti", () => {
    const r = resolveCivikoCheckoutContract({ ...base, plan: "agenzia", billing_interval: "month", interval: "year" });
    expect(r.ok).toBe(false);
  });

  it("respinge plan agenzia senza intervallo", () => {
    expect(resolveCivikoCheckoutContract({ ...base, plan: "agenzia" }).ok).toBe(false);
  });

  it("respinge intervalli invalidi", () => {
    for (const v of ["monthly", "annual", "week", "MONTHS", ""]) {
      expect(resolveCivikoCheckoutContract({ ...base, plan: "agenzia", billing_interval: v }).ok).toBe(false);
    }
  });

  it("normalizza gli alias legacy monthly/yearly", () => {
    const m = resolveCivikoCheckoutContract({ ...base, plan: "monthly" });
    const y = resolveCivikoCheckoutContract({ ...base, plan: "yearly" });
    expect(m.ok && m.value.billingInterval).toBe("month");
    expect(y.ok && y.value.billingInterval).toBe("year");
    expect(m.ok && m.value.plan).toBe("agenzia");
  });

  it("respinge legacy con intervallo incoerente", () => {
    expect(resolveCivikoCheckoutContract({ ...base, plan: "monthly", billing_interval: "year" }).ok).toBe(false);
  });

  it("respinge piani non consentiti fail-closed", () => {
    for (const p of ["pro", "civiko_pro", "", "AGENZIA_PLUS", "free"]) {
      expect(resolveCivikoCheckoutContract({ ...base, plan: p, billing_interval: "month" }).ok).toBe(false);
    }
  });

  it("ignora campi economici/client Stripe passati dal chiamante", () => {
    const noisy: Record<string, unknown> = { ...base, plan: "agenzia", billing_interval: "month" };
    for (const f of FORBIDDEN_CLIENT_FIELDS) noisy[f] = "attacker_value";
    const r = resolveCivikoCheckoutContract(noisy);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.priceEnvVar).toBe("STRIPE_PRICE_CIVIKO_MONTHLY");
    for (const f of FORBIDDEN_CLIENT_FIELDS) {
      expect(SRC.includes(`body.${f}`)).toBe(false);
    }
  });
});

describe("checkpoint 9A — validazione URL di ritorno", () => {
  it("accetta domini Civiko e Lovable in HTTPS", () => {
    expect(isAllowedCivikoReturnUrl("https://civikoone.com/ok")).toBe(true);
    expect(isAllowedCivikoReturnUrl("https://www.civikoone.com/ok")).toBe(true);
    expect(isAllowedCivikoReturnUrl("https://x.lovable.app/ok")).toBe(true);
    expect(isAllowedCivikoReturnUrl("https://y.lovableproject.com/ok")).toBe(true);
  });

  it("respinge HTTP e domini estranei", () => {
    for (const u of [
      "http://civikoone.com/ok",
      "https://evil.com/ok",
      "https://civikoone.com.evil.com/ok",
      "javascript:alert(1)",
      "",
    ]) {
      expect(isAllowedCivikoReturnUrl(u)).toBe(false);
    }
  });
});

describe("checkpoint 9A — integrazione nella edge function", () => {
  it("usa il resolver e la validazione URL", () => {
    expect(SRC).toContain("resolveCivikoCheckoutContract(body)");
    expect(SRC).toContain("isAllowedCivikoReturnUrl(successUrl)");
    expect(SRC).toContain("isAllowedCivikoReturnUrl(cancelUrl)");
  });

  it("seleziona il price solo da variabili ambiente", () => {
    expect(SRC).toContain("Deno.env.get(contract.value.priceEnvVar)");
    expect(SRC).toContain("STRIPE_PRICE_CIVIKO_MONTHLY");
    expect(SRC).toContain("STRIPE_PRICE_CIVIKO_YEARLY");
  });

  it("scrive i metadata canonici su customer, session e subscription", () => {
    expect(SRC).toContain('"metadata[billing_interval]": billingInterval');
    expect(SRC).toContain('"subscription_data[metadata][billing_interval]": billingInterval');
    expect(SRC).toContain('"subscription_data[metadata][plan]": plan');
    expect(SRC).toContain('"metadata[app]": "civiko"');
  });

  it("non effettua chiamate Stripe prima della validazione del contratto", () => {
    const fn = SRC.slice(SRC.indexOf("async function handleCreateCheckoutDirect"));
    const contractIdx = fn.indexOf("resolveCivikoCheckoutContract(body)");
    const stripeIdx = fn.indexOf("stripeForm(");
    const searchIdx = fn.indexOf("api.stripe.com");
    expect(contractIdx).toBeGreaterThan(-1);
    expect(contractIdx).toBeLessThan(stripeIdx);
    expect(contractIdx).toBeLessThan(searchIdx);
    const urlIdx = fn.indexOf("isAllowedCivikoReturnUrl(successUrl)");
    expect(urlIdx).toBeLessThan(searchIdx);
  });
});
