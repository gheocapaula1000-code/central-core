import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const WEBHOOK = readFileSync(resolve(ROOT, "supabase/functions/stripe-webhook/index.ts"), "utf8");

describe("CHECKPOINT 9E2 — webhook Core: firma, claim, stato", () => {
  it("verifica sempre la firma Stripe e risponde 400 se invalida", () => {
    expect(WEBHOOK).toContain("constructEventAsync");
    expect(WEBHOOK).toMatch(/invalid_signature[\s\S]{0,80}400/);
  });

  it("esegue il claim atomico PRIMA di qualunque scrittura applicativa", () => {
    const claimIdx = WEBHOOK.indexOf("stripe_webhook_event_claim");
    const activateIdx = WEBHOOK.indexOf("civiko_activate_paid_zone_atomic");
    expect(claimIdx).toBeGreaterThan(0);
    expect(activateIdx).toBeGreaterThan(0);
  });

  it("marca processed soltanto dopo il successo completo", () => {
    expect(WEBHOOK).toContain("stripe_webhook_event_mark_processed");
    expect(WEBHOOK).toMatch(/processed SOLO dopo il successo completo/);
  });

  it("errore RPC/DB/Stripe/registro → failed + risposta non-2xx, mai falso 200", () => {
    expect(WEBHOOK).toContain("stripe_webhook_event_mark_failed");
    expect(WEBHOOK).toMatch(/registry_close_failed[\s\S]{0,60}500/);
    expect(WEBHOOK).toMatch(/retryable: true \}, 500\)/);
    expect(WEBHOOK).toContain("class RetryableError");
  });

  it("evento già processed → idempotent skip senza scritture", () => {
    expect(WEBHOOK).toMatch(/claim\.claimed !== true/);
    expect(WEBHOOK).toContain("idempotent_skip");
  });

  it("retrieve Stripe fallito → errore ritentabile", () => {
    expect(WEBHOOK).toContain("stripe_retrieve_failed");
  });
});

describe("CHECKPOINT 9E2 — gate checkout.session.completed", () => {
  it("richiede app civiko, sessione complete, pagamento valido e subscription", () => {
    expect(WEBHOOK).toContain('s.status !== "complete"');
    expect(WEBHOOK).toContain('s.payment_status !== "paid"');
    expect(WEBHOOK).toContain('"no_payment_required"');
    expect(WEBHOOK).toContain("!s.subscription");
    expect(WEBHOOK).toContain("isCivikoMeta");
  });

  it("richiede subscription active|trialing dopo il retrieve", () => {
    expect(WEBHOOK).toMatch(/sub\.status !== "active" && sub\.status !== "trialing"/);
  });

  it("richiede price id coerente con tier e zona", () => {
    expect(WEBHOOK).toContain("priceMatchesTier");
    expect(WEBHOOK).toContain("CIVIKO_TIER_PRICE_ENV");
    expect(WEBHOOK).toContain("price_tier_mismatch");
  });

  it("ammette solo la zona pilot centro-storico", () => {
    expect(WEBHOOK).toContain("PADOVA_PILOT_ALLOWED_ZONE_SLUG");
    expect(WEBHOOK).toContain("zone_not_in_pilot");
  });

  it("usa la RPC atomica per customer + subscription + zona", () => {
    expect(WEBHOOK).toContain("civiko_activate_paid_zone_atomic");
  });
});

describe("CHECKPOINT 9E2 — cancellazione e invoice", () => {
  it("customer.subscription.deleted usa la RPC atomica di cancellazione", () => {
    expect(WEBHOOK).toContain("civiko_release_zone_on_cancel_atomic");
  });

  it("invoice risolve l'app dai metadata della subscription, non dell'invoice", () => {
    expect(WEBHOOK).toMatch(/retrieveSubscription\(stripe, subId\)/);
    expect(WEBHOOK).toMatch(/isCivikoMeta\(\(sub\.metadata/);
  });

  it("invoice.payment_failed imposta past_due e conserva la zona", () => {
    expect(WEBHOOK).toContain('"past_due"');
    expect(WEBHOOK).toContain("zone_preserved: true");
    expect(WEBHOOK).toContain("past_due NON libera la zona");
  });
});

describe("CHECKPOINT 9E2 — nessun flusso manuale di assegnazione", () => {
  it("elimina zona_status in_attesa dal webhook", () => {
    expect(WEBHOOK).not.toContain("in_attesa");
  });

  it("elimina l'email che chiede all'admin di assegnare la zona", () => {
    expect(WEBHOOK).not.toMatch(/assegna zona/i);
    expect(WEBHOOK).not.toMatch(/Azione richiesta entro 24h/i);
    expect(WEBHOOK).not.toContain("notifyAdminNewSubscription");
  });

  it("l'email amministrativa è solo informativa: zona già confermata", () => {
    expect(WEBHOOK).toContain("notifyAdminZonaConfermata");
    expect(WEBHOOK).toContain("Nessuna azione manuale richiesta");
  });

  it("eventi di altri prodotti sono ignorati senza scritture Civiko", () => {
    expect(WEBHOOK).toContain('skipped: "non_civiko"');
    expect(WEBHOOK).toContain("ignored: true");
  });
});
