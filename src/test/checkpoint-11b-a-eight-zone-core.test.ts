// Checkpoint 11B-A — apertura core delle 8 zone Civiko One.
// Test comportamentali sui moduli e handler reali. Nessuna rete, nessun DB,
// nessuna chiamata Stripe: le dipendenze sono iniettate.
import { describe, it, expect, beforeAll } from "vitest";
import {
  CIVIKO_COMMERCIAL_ZONES,
  isCivikoCommercialZoneSlug,
} from "../../supabase/functions/_shared/civikoCommercialZoneContract.ts";
import { commercialZoneForQuartiere } from "../../supabase/functions/_shared/civikoCommercialZoneByQuartiere.ts";
import { PADOVA_PILOT_AMBIGUOUS_STAZIONE_FIERA_KEYS } from "../../supabase/functions/_shared/civikoTerritoryContractPadovaPilotV1.ts";
import { applyCivikoSingleZoneGate } from "../../supabase/functions/_shared/civikoZoneAccessGate.ts";
import {
  resolveCivikoZonePricing,
  CIVIKO_TIER_MONTHLY_EUR,
  CIVIKO_TIER_PRICE_ENV,
  isCivikoLaunchInterval,
} from "../../supabase/functions/_shared/civikoCheckoutContract.ts";
import {
  handleZonesList,
  type ZoneRow,
} from "../../supabase/functions/civiko-zones-list/index.ts";
import { handleZonesReserve } from "../../supabase/functions/civiko-zones-reserve/index.ts";

const EIGHT = [
  "centro-storico",
  "nord-arcella",
  "est-brenta",
  "nord-est",
  "sud-est-sant-osvaldo",
  "sud-voltabarozzo-guizza",
  "sud-ovest-mandria",
  "ovest-chiesanuova-brentelle",
] as const;

const PREMIUM = ["centro-storico", "sud-est-sant-osvaldo"];
const STANDARD = EIGHT.filter((s) => !PREMIUM.includes(s));

const SECRET = "job-secret-11ba";
const WS = "11111111-2222-3333-4444-555555555555";
const WS2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const USER = "66666666-7777-8888-9999-000000000000";

function tierOf(slug: string) {
  return PREMIUM.includes(slug) ? "premium" : "standard";
}

function zoneRows(slugs: readonly string[]): ZoneRow[] {
  return slugs.map((slug) => ({
    slug,
    nome: `Zona ${slug}`,
    tier: tierOf(slug),
    canone_mese_eur: tierOf(slug) === "premium" ? 2990 : 1990,
    provvigioni_anno_eur: 20000,
    contendibili_count: 3,
    status: "in_trial",
    trial_reserved_until: new Date(Date.now() + 86400000).toISOString(),
    occupied_since: "2026-07-01T00:00:00.000Z",
  }));
}

// ── 1–5 · contratto territoriale ──────────────────────────────────────────
describe("11B-A · contratto territoriale delle 8 zone", () => {
  it("1. tutte e 8 le zone ufficiali sono accettate dal contratto", () => {
    expect(CIVIKO_COMMERCIAL_ZONES.map((z) => z.slug).sort()).toEqual([...EIGHT].sort());
    for (const s of EIGHT) expect(isCivikoCommercialZoneSlug(s)).toBe(true);
  });
  it("2. slug estraneo/legacy respinto dal contratto", () => {
    for (const s of ["arcella", "portello-stazione-fiera", "CENTRO-STORICO", "", null, 42]) {
      expect(isCivikoCommercialZoneSlug(s)).toBe(false);
    }
  });
  it("3. Stazione → centro-storico", () => {
    for (const q of ["Stazione", "Stazione Ferroviaria", "Scrovegni"]) {
      expect(commercialZoneForQuartiere(q)).toBe("centro-storico");
    }
  });
  it("4. Fiera → est-brenta", () => {
    expect(commercialZoneForQuartiere("Fiera")).toBe("est-brenta");
  });
  it("5. stringhe miste Stazione/Fiera → fail-closed (null)", () => {
    for (const q of [...PADOVA_PILOT_AMBIGUOUS_STAZIONE_FIERA_KEYS, "Stazione / Fiera"]) {
      expect(commercialZoneForQuartiere(q)).toBeNull();
    }
  });
});

// ── 6–13 · prenotazione (handler reale, RPC iniettata) ────────────────────
describe("11B-A · prenotazione delle 8 zone", () => {
  beforeAll(() => {
    process.env.CENTRAL_CORE_JOB_SECRET = SECRET;
    process.env.SUPABASE_URL = "http://db.local";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  });

  function req(slug: unknown, userId = USER, wsId = WS) {
    return new Request("http://local/civiko-zones-reserve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-job-secret": SECRET,
        "x-workspace-id": wsId,
        "x-user-id": userId,
      },
      body: JSON.stringify({ slug }),
    });
  }

  /** DB simulato: una zona per agenzia, una agenzia per zona, trial 7 giorni. */
  function makeDb() {
    const calls: string[] = [];
    const zones = new Map<string, { status: string; agency: string | null; trial_until: string | null }>(
      EIGHT.map((s) => [s, { status: "disponibile", agency: null, trial_until: null }]),
    );
    const rpc = async (fn: string, args: Record<string, unknown>) => {
      calls.push(`rpc:${fn}:${String(args.p_slug ?? "")}`);
      const slug = String(args.p_slug ?? "").trim();
      const agency = String(args.p_agency_id ?? "");
      if (!EIGHT.includes(slug as (typeof EIGHT)[number])) {
        return { data: { ok: false, error: "zona_non_trovata" }, error: null };
      }
      const z = zones.get(slug)!;
      if (z.agency && z.agency !== agency) {
        return { data: { ok: false, error: "zona_occupata" }, error: null };
      }
      if (z.agency === agency) {
        // retry idempotente: trial_until invariato
        return {
          data: { ok: true, already_mine: true, zona: slug, status: z.status, trial_until: z.trial_until },
          error: null,
        };
      }
      const other = [...zones.entries()].find(([s, v]) => s !== slug && v.agency === agency);
      if (other) return { data: { ok: false, error: "agency_ha_gia_zona" }, error: null };
      const until = new Date(Date.now() + 7 * 86400000).toISOString();
      zones.set(slug, { status: "in_trial", agency, trial_until: until });
      return { data: { ok: true, already_mine: false, zona: slug, trial_until: until }, error: null };
    };
    const factory = () => {
      calls.push("createClient");
      return { rpc, from: (t: string) => { calls.push(`from:${t}`); throw new Error("no direct table access"); } };
    };
    return { calls, zones, factory };
  }

  it("6. prenotazione riuscita per ognuna delle 8 zone (agenzie distinte)", async () => {
    for (const slug of EIGHT) {
      const db = makeDb();
      const agency = WS;
      const res = await handleZonesReserve(req(slug, USER, agency), db.factory);
      expect(res.status).toBe(200);
      const b = await res.json();
      expect(b.ok).toBe(true);
      expect(b.data.zona).toBe(slug);
      expect(db.zones.get(slug)!.agency).toBe(agency);
    }
  });

  it("2b/16. slug estraneo respinto PRIMA di qualunque accesso DB", async () => {
    for (const bad of ["arcella", "portello-stazione-fiera", "fiera-stazione", "CENTRO-STORICO"]) {
      const db = makeDb();
      const res = await handleZonesReserve(req(bad), db.factory);
      expect(res.status).toBe(404);
      expect(db.calls).toHaveLength(0);
      const b = await res.json();
      expect(b.error.message).toBe("Questa zona non è disponibile. Scegli un'altra zona.");
    }
  });

  it("7. retry idempotente: stessa zona, nessun rinnovo del trial", async () => {
    const db = makeDb();
    const first = await (await handleZonesReserve(req("nord-arcella"), db.factory)).json();
    const trial1 = first.data.trial_until;
    const second = await (await handleZonesReserve(req("nord-arcella"), db.factory)).json();
    expect(second.ok).toBe(true);
    expect(second.data.already_mine).toBe(true);
    expect(second.data.trial_until).toBe(trial1); // 12. nessun rinnovo
  });

  it("8. concorrenza stessa zona, agenzie diverse → una sola vince", async () => {
    const db = makeDb();
    const [a, b] = await Promise.all([
      handleZonesReserve(req("est-brenta", USER, WS), db.factory),
      handleZonesReserve(req("est-brenta", USER, WS2), db.factory),
    ]);
    const bodies = [await a.json(), await b.json()];
    const winners = bodies.filter((x) => x.ok === true);
    const losers = bodies.filter((x) => x.ok === false);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].error.message).toBe("Questa zona non è disponibile. Scegli un'altra zona.");
  });

  it("9/10. stessa agenzia su zone diverse → una sola zona finale", async () => {
    const db = makeDb();
    const first = await (await handleZonesReserve(req("sud-ovest-mandria"), db.factory)).json();
    expect(first.ok).toBe(true);
    const second = await handleZonesReserve(req("nord-est"), db.factory);
    expect(second.status).toBe(409);
    const owned = [...db.zones.entries()].filter(([, v]) => v.agency === WS);
    expect(owned).toHaveLength(1);
    expect(owned[0][0]).toBe("sud-ovest-mandria");
  });

  it("11. trial esattamente 7 giorni", async () => {
    const db = makeDb();
    const b = await (await handleZonesReserve(req("est-brenta"), db.factory)).json();
    const delta = new Date(b.data.trial_until).getTime() - Date.now();
    expect(delta).toBeGreaterThan(6.9 * 86400000);
    expect(delta).toBeLessThan(7.1 * 86400000);
  });

  it("13. nessuna riga orfana: una sola RPC, nessun accesso diretto a tabelle", async () => {
    const db = makeDb();
    await handleZonesReserve(req("centro-storico"), db.factory);
    expect(db.calls.filter((c) => c.startsWith("rpc:"))).toHaveLength(1);
    expect(db.calls.some((c) => c.startsWith("from:"))).toBe(false);
  });

  it("nessun campo economico o identità accettato dal body", async () => {
    const db = makeDb();
    const res = await handleZonesReserve(
      new Request("http://local/civiko-zones-reserve", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-job-secret": SECRET,
          "x-workspace-id": WS,
          "x-user-id": USER,
        },
        body: JSON.stringify({
          slug: "est-brenta",
          price_id: "price_hack",
          amount: 1,
          workspace_id: WS2,
          agency_id: WS2,
          tier: "entry",
        }),
      }),
      db.factory,
    );
    expect(res.status).toBe(200);
    expect(db.calls.filter((c) => c.startsWith("rpc:"))).toEqual(["rpc:reserve_padova_pilot_zone_atomic:est-brenta"]);
    expect(db.zones.get("est-brenta")!.agency).toBe(WS); // identità solo dagli header
  });

  it("nessun termine tecnico o 'pilot' nei messaggi pubblici", async () => {
    const db = makeDb();
    await handleZonesReserve(req("centro-storico", USER, WS2), db.factory);
    const res = await handleZonesReserve(req("centro-storico", USER, WS), db.factory);
    const b = await res.json();
    const msg = String(b.error.message).toLowerCase();
    for (const t of ["pilot", "rpc", "postgres", "supabase", "civiko_commercial_zones", "debug_id"]) {
      expect(msg).not.toContain(t);
    }
  });
});

// ── 14 · catalogo pubblico ────────────────────────────────────────────────
describe("11B-A · catalogo pubblico senza stato operativo", () => {
  const loader = async () => ({ rows: zoneRows(EIGHT), error: null });

  it("14. la risposta pubblica non espone stato, trial, occupazione o agenzie", async () => {
    const res = await handleZonesList(new Request("http://local/civiko-zones-list"), loader);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.count).toBe(8);
    const raw = JSON.stringify(b);
    for (const t of ["status", "trial_reserved_until", "occupied_since", "in_trial", "occupata", "agency", "workspace"]) {
      expect(raw).not.toContain(t);
    }
    for (const z of b.data.zones) {
      expect(z.selectable).toBe(true);
      expect(z.availability_action).toBe("verify");
      expect(typeof z.canone_mese_eur).toBe("number");
      expect(Array.isArray(z.quartieri_principali)).toBe(true);
    }
  });

  it("14b. tutte e 8 le zone sono commercialmente selezionabili", async () => {
    const res = await handleZonesList(new Request("http://local/civiko-zones-list"), loader);
    const b = await res.json();
    expect(b.data.zones.map((z: { slug: string }) => z.slug).sort()).toEqual([...EIGHT].sort());
  });

  it("14c. i campi operativi solo per la chiamata server-to-server autenticata", async () => {
    process.env.CENTRAL_CORE_JOB_SECRET = SECRET;
    const res = await handleZonesList(
      new Request("http://local/civiko-zones-list", { headers: { "x-job-secret": SECRET } }),
      loader,
    );
    const b = await res.json();
    expect(b.data.scope).toBe("private");
    expect(b.data.zones[0].status).toBeDefined();
    const raw = JSON.stringify(b);
    expect(raw).not.toContain("trial_agency_id");
    expect(raw).not.toContain("occupied_agency_id");
  });

  it("14d. secret errato → risposta pubblica", async () => {
    const res = await handleZonesList(
      new Request("http://local/civiko-zones-list", { headers: { "x-job-secret": "sbagliato" } }),
      loader,
    );
    const b = await res.json();
    expect(b.data.scope).toBe("public");
    expect(b.data.zones[0].status).toBeUndefined();
  });
});

// ── 15–18 · isolamento dati ───────────────────────────────────────────────
describe("11B-A · isolamento dati a zona singola", () => {
  const CIVIKO = "civiko-one";

  it("15. utente normale vede esattamente la sua unica zona", () => {
    for (const slug of EIGHT) {
      const g = applyCivikoSingleZoneGate(CIVIKO, [slug]);
      expect(g).toEqual({ civiko: true, ok: true, slugs: [slug] });
    }
  });

  it("16. spoofing di un'altra zona respinto", () => {
    const g = applyCivikoSingleZoneGate(CIVIKO, ["nord-arcella"], "centro-storico");
    expect(g).toEqual({ civiko: true, ok: false, code: "ZONE_NOT_ASSIGNED" });
    const g2 = applyCivikoSingleZoneGate(CIVIKO, ["nord-arcella"], "arcella");
    expect(g2).toEqual({ civiko: true, ok: false, code: "SLUG_OUT_OF_CONTRACT" });
  });

  it("17. admin: una zona ufficiale per volta", () => {
    const g = applyCivikoSingleZoneGate(CIVIKO, [...EIGHT], "sud-voltabarozzo-guizza");
    expect(g).toEqual({ civiko: true, ok: true, slugs: ["sud-voltabarozzo-guizza"] });
  });

  it("18. nessun full-city: admin senza zona esplicita → fail-closed", () => {
    const g = applyCivikoSingleZoneGate(CIVIKO, [...EIGHT]);
    expect(g).toEqual({ civiko: true, ok: false, code: "MULTIPLE_ZONES_ASSIGNED" });
  });

  it("18b. zero zone → fail-closed", () => {
    expect(applyCivikoSingleZoneGate(CIVIKO, [])).toEqual({
      civiko: true, ok: false, code: "NO_ZONE_ASSIGNED",
    });
  });

  it("30. altre applicazioni Core non sono toccate dal gate Civiko", () => {
    const g = applyCivikoSingleZoneGate("acquisitionradar", [...EIGHT]);
    expect(g).toEqual({ civiko: false, ok: true, slugs: [...EIGHT] });
  });
});

// ── 19–23 · prezzi e checkout ─────────────────────────────────────────────
describe("11B-A · matrice prezzi e checkout", () => {
  const row = (slug: string, agency: string) => ({
    slug,
    tier: tierOf(slug),
    canone_mese_eur: tierOf(slug) === "premium" ? 2990 : 1990,
    trial_agency_id: agency,
    occupied_agency_id: null,
  });

  it("19. Premium €2.990 esattamente su centro-storico e sud-est-sant-osvaldo", () => {
    for (const slug of PREMIUM) {
      const r = resolveCivikoZonePricing([row(slug, WS)], WS);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.zoneTier).toBe("premium");
        expect(r.value.canoneMeseEur).toBe(2990);
        expect(r.value.priceEnvVar).toBe("STRIPE_PRICE_CIVIKO_PREMIUM_MONTHLY");
      }
    }
  });

  it("20. Standard €1.990 sulle altre 6 zone", () => {
    expect(STANDARD).toHaveLength(6);
    for (const slug of STANDARD) {
      const r = resolveCivikoZonePricing([row(slug, WS)], WS);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.zoneTier).toBe("standard");
        expect(r.value.canoneMeseEur).toBe(1990);
        expect(r.value.priceEnvVar).toBe("STRIPE_PRICE_CIVIKO_STANDARD_MONTHLY");
      }
    }
  });

  it("21. nessuna delle 8 zone è Entry (infrastruttura conservata)", () => {
    for (const slug of EIGHT) expect(tierOf(slug)).not.toBe("entry");
    expect(CIVIKO_TIER_MONTHLY_EUR.entry).toBe(990);
    expect(CIVIKO_TIER_PRICE_ENV.entry).toBe("STRIPE_PRICE_CIVIKO_ENTRY_MONTHLY");
  });

  it("22. checkout risolvibile per tutte e 8 le zone, solo mensile", () => {
    for (const slug of EIGHT) {
      expect(resolveCivikoZonePricing([row(slug, WS)], WS).ok).toBe(true);
    }
    expect(isCivikoLaunchInterval("month")).toBe(true);
    expect(isCivikoLaunchInterval("year")).toBe(false);
  });

  it("23. metadata zona/tier derivati dalla zona reale, mai dal client", () => {
    const r = resolveCivikoZonePricing([row("est-brenta", WS)], WS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.zoneSlug).toBe("est-brenta");
      expect(r.value.zoneTier).toBe("standard");
    }
  });

  it("22b. zero zone, più zone o tier incoerente → checkout respinto", () => {
    expect(resolveCivikoZonePricing([], WS)).toMatchObject({ ok: false, error: { code: "NO_ZONE_ASSIGNED" } });
    expect(
      resolveCivikoZonePricing([row("est-brenta", WS), row("nord-arcella", WS)], WS),
    ).toMatchObject({ ok: false, error: { code: "MULTIPLE_ZONES_ASSIGNED" } });
    expect(
      resolveCivikoZonePricing([{ ...row("est-brenta", WS), canone_mese_eur: 990 }], WS),
    ).toMatchObject({ ok: false, error: { code: "ZONE_PRICING_INVALID" } });
    expect(
      resolveCivikoZonePricing([{ ...row("est-brenta", WS), slug: "arcella" }], WS),
    ).toMatchObject({ ok: false, error: { code: "ZONE_NOT_OFFICIAL" } });
  });

  it("nessun ZONE_NOT_IN_PILOT e nessun pilotOnly residuo nel contratto prezzi", () => {
    expect(resolveCivikoZonePricing.length).toBe(2);
    for (const slug of EIGHT) {
      const r = resolveCivikoZonePricing([row(slug, WS)], WS);
      expect(JSON.stringify(r)).not.toContain("PILOT");
    }
  });
});

// ── 24–29 · webhook e attivazione pagata (contratto statico del sorgente) ──
describe("11B-A · webhook e occupazione pagata", () => {
  let src = "";
  beforeAll(async () => {
    const { readFileSync } = await import("node:fs");
    src = readFileSync("supabase/functions/stripe-webhook/index.ts", "utf8");
  });

  it("24. la zona dei metadata è validata sulle 8 ufficiali, non sul pilot", () => {
    expect(src).toContain("isCivikoCommercialZoneSlug(zoneSlug)");
    expect(src).not.toContain("PADOVA_PILOT_ALLOWED_ZONE_SLUG");
    expect(src).not.toContain("zone_not_in_pilot");
  });

  it("25. conflitto con altra agenzia gestito dalla RPC atomica senza scritture dirette", () => {
    expect(src).toContain("civiko_activate_paid_zone_atomic");
    expect(src).toContain("activate_rejected");
  });

  it("26/27. cancellazione delegata alla RPC atomica (guardia superseded lato DB)", () => {
    expect(src).toContain("civiko_release_zone_on_cancel_atomic");
    expect(src).toContain("customer.subscription.deleted");
  });

  it("28. eventi non Civiko restano ignorati", () => {
    expect(src).toContain('skipped: "non_civiko"');
  });

  it("29. incoerenze Civiko su checkout pagato sono ritentabili (failed + 500)", () => {
    expect(src).toContain("RetryableError");
    expect(src).toContain('throw new RetryableError("no_subscription")');
    expect(src).toContain('throw new RetryableError("price_tier_mismatch")');
  });
});
