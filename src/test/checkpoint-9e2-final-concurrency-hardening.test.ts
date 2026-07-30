import { describe, it, expect } from "vitest";
import { CIVIKO_COMMERCIAL_ZONES } from "../../supabase/functions/_shared/civikoCommercialZoneContract";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const WEBHOOK = readFileSync(resolve(ROOT, "supabase/functions/stripe-webhook/index.ts"), "utf8");

/**
 * Simulazione comportamentale del gate `checkout.session.completed`.
 * Riproduce fedelmente l'ordine dei controlli del webhook: gli eventi non Civiko
 * restano "skipped" (200), mentre ogni incoerenza su un checkout Civiko pagato
 * deve diventare un errore ritentabile (failed + 500).
 */
type Session = {
  metadata?: Record<string, string>;
  mode?: string;
  status?: string;
  payment_status?: string;
  subscription?: string | null;
  customer?: string | null;
};
type Sub = { status: string; priceId: string | null } | "retrieve_error";

class RetryableError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const PILOT = "centro-storico";
const OFFICIAL_SLUGS = new Set(CIVIKO_COMMERCIAL_ZONES.map((z) => z.slug) as string[]);
const PRICE_BY_TIER: Record<string, string> = { premium: "price_premium_live" };

function isCivikoMeta(m: Record<string, string> = {}) {
  const app = String(m.app ?? "").toLowerCase();
  const source = String(m.source ?? "").toLowerCase();
  return app === "civiko" || app === "civiko_one" || source === "civiko";
}

function handleCheckout(s: Session, sub: Sub | null): { skipped?: string; activated?: boolean } {
  const meta = s.metadata ?? {};
  if (!isCivikoMeta(meta)) return { skipped: "non_civiko" };
  if (s.mode !== "subscription") return { skipped: "not_subscription_mode" };
  if (s.status !== "complete") return { skipped: "session_not_complete" };
  if (s.payment_status !== "paid" && s.payment_status !== "no_payment_required") {
    return { skipped: "not_paid" };
  }
  if (!s.subscription) throw new RetryableError("no_subscription");
  if (!String(meta.workspace_id ?? "").trim()) throw new RetryableError("no_workspace_id");
  if (!OFFICIAL_SLUGS.has(String(meta.zone_slug ?? "").trim())) throw new RetryableError("zone_not_official");
  if (!s.customer) throw new RetryableError("no_customer");
  if (sub === "retrieve_error" || sub === null) throw new RetryableError("stripe_retrieve_failed");
  if (sub.status !== "active" && sub.status !== "trialing") {
    throw new RetryableError("subscription_not_active");
  }
  const tier = String(meta.zone_tier ?? "").trim().toLowerCase();
  if (!sub.priceId || PRICE_BY_TIER[tier] !== sub.priceId) throw new RetryableError("price_tier_mismatch");
  return { activated: true };
}

/** Simulazione del ciclo webhook: claim → handler → mark_processed/mark_failed. */
function runWebhook(
  registry: Map<string, { status: string; attempts: number }>,
  eventId: string,
  run: () => unknown,
  opts: { markProcessedReturns?: boolean } = {},
) {
  const writes: string[] = [];
  const existing = registry.get(eventId);
  if (existing && existing.status === "processed") {
    return { http: 200, registry: existing.status, idempotent: true, writes };
  }
  const entry = { status: "processing", attempts: (existing?.attempts ?? 0) + 1 };
  registry.set(eventId, entry);
  try {
    const result = run() as Record<string, unknown>;
    if (result?.activated) writes.push("civiko_activation");
    const markOk = opts.markProcessedReturns ?? true;
    if (markOk !== true) {
      registry.set(eventId, { ...entry, status: "failed" });
      return { http: 500, registry: "failed", writes };
    }
    registry.set(eventId, { ...entry, status: "processed" });
    return { http: 200, registry: "processed", writes };
  } catch {
    registry.set(eventId, { ...entry, status: "failed" });
    return { http: 500, registry: "failed", writes };
  }
}

const paidCivikoSession = (over: Partial<Session> = {}): Session => ({
  metadata: {
    app: "civiko",
    workspace_id: "ws-1",
    zone_slug: PILOT,
    zone_tier: "premium",
    ...(over.metadata ?? {}),
  },
  mode: "subscription",
  status: "complete",
  payment_status: "paid",
  subscription: "sub_1",
  customer: "cus_1",
  ...over,
});

describe("9E2-FINAL — contratto HTTP checkout Civiko pagato", () => {
  it("7. price-tier errato → failed + 500, mai processed", () => {
    const reg = new Map<string, { status: string; attempts: number }>();
    const res = runWebhook(reg, "evt_tier", () =>
      handleCheckout(paidCivikoSession(), { status: "active", priceId: "price_sbagliato" }),
    );
    expect(res.http).toBe(500);
    expect(res.registry).toBe("failed");
    expect(res.writes).toEqual([]);
  });

  it("8. workspace/subscription/customer mancanti → failed + 500", () => {
    const cases: Session[] = [
      paidCivikoSession({ metadata: { app: "civiko", zone_slug: PILOT, zone_tier: "premium" } }),
      paidCivikoSession({ subscription: null }),
      paidCivikoSession({ customer: null }),
      paidCivikoSession({ metadata: { app: "civiko", workspace_id: "ws-1", zone_slug: "nord-arcella", zone_tier: "premium" } }),
    ];
    for (const [i, s] of cases.entries()) {
      const reg = new Map<string, { status: string; attempts: number }>();
      const res = runWebhook(reg, `evt_bad_${i}`, () =>
        handleCheckout(s, { status: "active", priceId: PRICE_BY_TIER.premium }),
      );
      expect(res.http).toBe(500);
      expect(res.registry).toBe("failed");
      expect(res.writes).toEqual([]);
    }
  });

  it("subscription non attiva o non recuperabile → failed + 500", () => {
    for (const [i, sub] of ([{ status: "incomplete", priceId: PRICE_BY_TIER.premium }, "retrieve_error"] as Sub[]).entries()) {
      const reg = new Map<string, { status: string; attempts: number }>();
      const res = runWebhook(reg, `evt_sub_${i}`, () => handleCheckout(paidCivikoSession(), sub));
      expect(res.http).toBe(500);
      expect(res.registry).toBe("failed");
    }
  });

  it("checkout Civiko coerente → attivazione + processed", () => {
    const reg = new Map<string, { status: string; attempts: number }>();
    const res = runWebhook(reg, "evt_ok", () =>
      handleCheckout(paidCivikoSession(), { status: "active", priceId: PRICE_BY_TIER.premium }),
    );
    expect(res.http).toBe(200);
    expect(res.registry).toBe("processed");
    expect(res.writes).toEqual(["civiko_activation"]);
  });

  it("9. evento non Civiko → processed senza scritture Civiko", () => {
    const reg = new Map<string, { status: string; attempts: number }>();
    const res = runWebhook(reg, "evt_other", () =>
      handleCheckout({ metadata: { app: "altro" }, mode: "subscription", status: "complete", payment_status: "paid" }, null),
    );
    expect(res.http).toBe(200);
    expect(res.registry).toBe("processed");
    expect(res.writes).toEqual([]);
  });

  it("10. mark_processed che restituisce false → 500", () => {
    const reg = new Map<string, { status: string; attempts: number }>();
    const res = runWebhook(
      reg,
      "evt_mark_false",
      () => handleCheckout(paidCivikoSession(), { status: "active", priceId: PRICE_BY_TIER.premium }),
      { markProcessedReturns: false },
    );
    expect(res.http).toBe(500);
    expect(res.registry).toBe("failed");
  });

  it("11. retry: evento riacquisito e processato una sola volta", () => {
    const reg = new Map<string, { status: string; attempts: number }>();
    const first = runWebhook(reg, "evt_retry", () =>
      handleCheckout(paidCivikoSession(), { status: "active", priceId: "price_sbagliato" }),
    );
    expect(first.http).toBe(500);
    const second = runWebhook(reg, "evt_retry", () =>
      handleCheckout(paidCivikoSession(), { status: "active", priceId: PRICE_BY_TIER.premium }),
    );
    expect(second.http).toBe(200);
    expect(second.writes).toEqual(["civiko_activation"]);
    expect(reg.get("evt_retry")?.attempts).toBe(2);

    const third = runWebhook(reg, "evt_retry", () =>
      handleCheckout(paidCivikoSession(), { status: "active", priceId: PRICE_BY_TIER.premium }),
    );
    expect(third.idempotent).toBe(true);
    expect(third.writes).toEqual([]);
  });
});

/**
 * Modello della RPC di cancellazione: ordine lock deterministico
 * (zona → agenzia) e guardia "superseded".
 */
type Zone = { slug: string; status: string; occupied_agency_id: string | null; occupied_since: string | null };
type Subscription = { id: string; agency: string; zone: string | null; status: string };

function releaseZone(zones: Zone[], subs: Subscription[], subId: string) {
  const locks: string[] = [];
  const sub = subs.find((s) => s.id === subId);
  if (!sub) return { ok: true, code: "SUBSCRIPTION_UNKNOWN", released: false, locks };
  locks.push(`zone:${sub.zone ?? "centro-storico"}`);
  locks.push(`agency:${sub.agency}`);
  sub.status = "canceled";
  if (!sub.zone) return { ok: true, released: false, superseded: false, locks };
  const superseded = subs.some(
    (s) => s.id !== sub.id && s.agency === sub.agency && s.zone === sub.zone && ["active", "trialing"].includes(s.status),
  );
  if (superseded) return { ok: true, released: false, superseded: true, locks };
  const zone = zones.find((z) => z.slug === sub.zone);
  if (zone && zone.occupied_agency_id === sub.agency) {
    zone.status = "disponibile";
    zone.occupied_agency_id = null;
    zone.occupied_since = null;
    return { ok: true, released: true, superseded: false, locks };
  }
  return { ok: true, released: false, superseded: false, locks };
}

function activateZone(zones: Zone[], agency: string) {
  const locks = [`zone:${PILOT}`, `agency:${agency}`];
  const zone = zones.find((z) => z.slug === PILOT)!;
  zone.status = "occupata";
  zone.occupied_agency_id = agency;
  zone.occupied_since ??= "2026-07-30T00:00:00Z";
  return { ok: true, locks };
}

const occupiedZone = (agency: string): Zone[] => [
  { slug: PILOT, status: "occupata", occupied_agency_id: agency, occupied_since: "2026-07-01T00:00:00Z" },
];

describe("9E2-FINAL — cancellazione zona: lock e superseded", () => {
  it("1. attivazione e cancellazione concorrenti usano lo stesso ordine di lock: nessun deadlock", () => {
    const zonesA = occupiedZone("ag-1");
    const act = activateZone(zonesA, "ag-1");
    const rel = releaseZone(occupiedZone("ag-1"), [{ id: "s1", agency: "ag-1", zone: PILOT, status: "active" }], "s1");
    expect(act.locks).toEqual([`zone:${PILOT}`, "agency:ag-1"]);
    expect(rel.locks).toEqual([`zone:${PILOT}`, "agency:ag-1"]);
    expect(rel.locks[0].startsWith("zone:")).toBe(true);
  });

  it("2. vecchia subscription cancellata dopo nuova attiva: zona NON liberata", () => {
    const zones = occupiedZone("ag-1");
    const subs: Subscription[] = [
      { id: "s_old", agency: "ag-1", zone: PILOT, status: "active" },
      { id: "s_new", agency: "ag-1", zone: PILOT, status: "active" },
    ];
    const res = releaseZone(zones, subs, "s_old");
    expect(res).toMatchObject({ ok: true, released: false, superseded: true });
    expect(zones[0].status).toBe("occupata");
    expect(zones[0].occupied_agency_id).toBe("ag-1");
    expect(zones[0].occupied_since).toBe("2026-07-01T00:00:00Z");
    expect(subs.find((s) => s.id === "s_old")!.status).toBe("canceled");
    expect(subs.find((s) => s.id === "s_new")!.status).toBe("active");
  });

  it("3. cancellazione dell'unica subscription attiva: zona liberata", () => {
    const zones = occupiedZone("ag-1");
    const subs: Subscription[] = [{ id: "s_only", agency: "ag-1", zone: PILOT, status: "active" }];
    const res = releaseZone(zones, subs, "s_only");
    expect(res).toMatchObject({ released: true, superseded: false });
    expect(zones[0].status).toBe("disponibile");
    expect(zones[0].occupied_agency_id).toBeNull();
  });

  it("4. retry della cancellazione: idempotente", () => {
    const zones = occupiedZone("ag-1");
    const subs: Subscription[] = [{ id: "s_only", agency: "ag-1", zone: PILOT, status: "active" }];
    releaseZone(zones, subs, "s_only");
    const retry = releaseZone(zones, subs, "s_only");
    expect(retry).toMatchObject({ ok: true, released: false });
    expect(zones[0].status).toBe("disponibile");
    const unknown = releaseZone(zones, subs, "s_missing");
    expect(unknown).toMatchObject({ ok: true, code: "SUBSCRIPTION_UNKNOWN", released: false });
  });

  it("non libera la zona se occupata da un'altra agenzia", () => {
    const zones = occupiedZone("ag-2");
    const subs: Subscription[] = [{ id: "s1", agency: "ag-1", zone: PILOT, status: "active" }];
    const res = releaseZone(zones, subs, "s1");
    expect(res.released).toBe(false);
    expect(zones[0].occupied_agency_id).toBe("ag-2");
  });
});

describe("9E2-FINAL — codice webhook allineato al contratto", () => {
  it("nessun checkout Civiko pagato termina con skipped su incoerenze", () => {
    const gate = WEBHOOK.slice(WEBHOOK.indexOf("async function handleCheckoutCompleted"));
    const body = gate.slice(0, gate.indexOf("async function handleSubscriptionUpsert"));
    const afterPaid = body.slice(body.indexOf('return { skipped: "not_paid" };'));
    for (const code of [
      "no_subscription",
      "no_workspace_id",
      "zone_not_official",
      "no_customer",
      "subscription_not_active",
      "price_tier_mismatch",
    ]) {
      expect(afterPaid).toContain(`RetryableError("${code}")`);
      expect(afterPaid).not.toContain(`skipped: "${code}"`);
    }
  });

  it("mark_processed: controlla error e data === true", () => {
    expect(WEBHOOK).toContain("markErr || markData !== true");
    expect(WEBHOOK).toMatch(/registry_close_failed[\s\S]{0,60}500/);
    expect(WEBHOOK).toMatch(/mark_processed_failed[\s\S]{0,400}stripe_webhook_event_mark_failed/);
  });

  it("nessun dettaglio tecnico esposto al client", () => {
    expect(WEBHOOK).not.toMatch(/jsonRes\(\{[^}]*msg\b/);
    expect(WEBHOOK).not.toMatch(/jsonRes\(\{[^}]*e\.message/);
  });
});
