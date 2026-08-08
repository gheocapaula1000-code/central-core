// Territory Contract Padova Pilot v1 — test statici del contratto e del
// perimetro fail-closed. Nessuna chiamata di rete, nessun dato live.
import { describe, it, expect } from "vitest";
import {
  PADOVA_PILOT_ALLOWED_ZONE_SLUG,
  PADOVA_PILOT_CENTRO_STORICO_QUARTIERE_KEYS,
  PADOVA_PILOT_CENTRO_STORICO_USER_LABELS,
  PADOVA_PILOT_EXCLUDED_AREAS,
  TERRITORY_CONTRACT_PADOVA_PILOT_V1_VERSION,
  describePadovaPilotContract,
  isPadovaPilotAllowedZoneSlug,
} from "../../supabase/functions/_shared/civikoTerritoryContractPadovaPilotV1.ts";
import { CIVIKO_COMMERCIAL_ZONE_SLUGS } from "../../supabase/functions/_shared/civikoCommercialZoneContract.ts";

const KEYS = PADOVA_PILOT_CENTRO_STORICO_QUARTIERE_KEYS;

describe("Territory Contract Padova Pilot v1 — struttura", () => {
  it("versione dichiarata", () => {
    expect(TERRITORY_CONTRACT_PADOVA_PILOT_V1_VERSION).toBe("1.1.0");
  });
  it("slug pilot appartiene al set canonico degli 8 slug", () => {
    expect(
      (CIVIKO_COMMERCIAL_ZONE_SLUGS as ReadonlySet<string>).has(
        PADOVA_PILOT_ALLOWED_ZONE_SLUG,
      ),
    ).toBe(true);
    expect(PADOVA_PILOT_ALLOWED_ZONE_SLUG).toBe("centro-storico");
  });
  it("27 quartiere_key non ambigue, uniche, non vuote", () => {
    expect(KEYS).toHaveLength(27);
    expect(new Set(KEYS).size).toBe(27);
    for (const k of KEYS) expect(k.trim().length).toBeGreaterThan(0);
  });
  it("denominazioni utente deduplicate (nessun duplicato)", () => {
    expect(new Set(PADOVA_PILOT_CENTRO_STORICO_USER_LABELS).size).toBe(
      PADOVA_PILOT_CENTRO_STORICO_USER_LABELS.length,
    );
  });
});

describe("Territory Contract Padova Pilot v1 — inclusioni/esclusioni", () => {
  it("Portello è incluso (chiave standalone)", () => {
    expect(KEYS).toContain("portello");
  });
  it("Stazione è inclusa (chiave standalone)", () => {
    expect(KEYS).toContain("stazione");
  });
  it("Fiera NON è chiave standalone nel perimetro", () => {
    expect(KEYS).not.toContain("fiera");
    expect(KEYS.some((k) => k === "fiera")).toBe(false);
  });
  it("nessuna chiave accettata cita insieme Stazione e Fiera", () => {
    for (const k of KEYS) {
      const w = k.split(" ");
      expect(w.includes("stazione") && w.includes("fiera")).toBe(false);
    }
  });
  it("il composto ambiguo Stazione–Fiera non è più accettato", () => {
    expect(KEYS).not.toContain(
      "stazione scrovegni c so del popolo fiera cittadella",
    );
  });
  it("Fiera è dichiarata esplicitamente tra le aree escluse", () => {
    const names = PADOVA_PILOT_EXCLUDED_AREAS.map((a) => a.name.toLowerCase());
    expect(names).toContain("fiera");
  });
});

describe("Territory Contract Padova Pilot v1 — fail-closed slug", () => {
  it("accetta solo `centro-storico`", () => {
    expect(isPadovaPilotAllowedZoneSlug("centro-storico")).toBe(true);
  });
  it("rifiuta gli altri 7 slug canonici", () => {
    const others = [
      "nord-arcella",
      "est-brenta",
      "nord-est",
      "sud-est-sant-osvaldo",
      "sud-voltabarozzo-guizza",
      "sud-ovest-mandria",
      "ovest-chiesanuova-brentelle",
    ];
    for (const s of others) expect(isPadovaPilotAllowedZoneSlug(s)).toBe(false);
  });
  it("rifiuta slug legacy, vuoti, non stringa, spoofing client", () => {
    for (const v of [
      "arcella",
      "portello-stazione-stanga",
      "centro storico", // spazio, non canonico
      "CENTRO-STORICO", // case diverso
      "",
      null,
      undefined,
      42,
      { slug: "centro-storico" },
    ]) {
      expect(isPadovaPilotAllowedZoneSlug(v)).toBe(false);
    }
  });
});

describe("Territory Contract Padova Pilot v1 — descrittore", () => {
  it("descrizione serializzabile coerente", () => {
    const d = describePadovaPilotContract();
    expect(d.contract_version).toBe("1.1.0");
    expect(d.municipality).toBe("padova");
    expect(d.province).toBe("PD");
    expect(d.commercial_zone_slug).toBe("centro-storico");
    expect(d.derivation_rules.client_authoritative).toBe(false);
    expect(d.derivation_rules.fail_closed).toBe(true);
    expect(d.accepted_quartiere_keys).toHaveLength(27);
  });
});

// Simulazione del gate server-side di civiko-zones-reserve (Fase 2 §2).
// Non chiama l'edge function reale: verifica che l'invariante "solo
// centro-storico prosegue oltre il gate" sia rispettata dal predicato.
describe("Territory Contract Padova Pilot v1 — gate prenotazione (simulazione)", () => {
  type Res = { status: number; error?: string };
  function reserveGate(bodySlug: unknown): Res {
    const slug = typeof bodySlug === "string" ? bodySlug.trim() : "";
    if (!slug) return { status: 400, error: "slug required" };
    if (!isPadovaPilotAllowedZoneSlug(slug)) {
      return { status: 403, error: "pilot_zone_locked" };
    }
    return { status: 200 };
  }
  it("centro-storico → passa il gate", () => {
    expect(reserveGate("centro-storico")).toEqual({ status: 200 });
  });
  it("altro slug canonico → 403 pilot_zone_locked", () => {
    expect(reserveGate("nord-arcella").status).toBe(403);
    expect(reserveGate("nord-arcella").error).toBe("pilot_zone_locked");
  });
  it("slug spoofato dal client → 403", () => {
    for (const v of ["arcella", "CENTRO-STORICO", " centro-storico ", "fiera"]) {
      const r = reserveGate(v);
      // " centro-storico " viene .trim() e passa: coerente col codice edge.
      if (v.trim() === "centro-storico") {
        expect(r.status).toBe(200);
      } else {
        expect(r.status).toBe(403);
      }
    }
  });
  it("body senza slug → 400", () => {
    expect(reserveGate(undefined).status).toBe(400);
    expect(reserveGate("").status).toBe(400);
  });
  // "Seconda prenotazione concorrente" a livello di edge NON viene
  // gestita dal gate del pilot: resta responsabilità della RPC
  // reserve_commercial_zone (già presente, fail-closed su trial attivo).
  // Il gate si limita a non aprire la strada a slug diversi.
  it("il gate NON sostituisce reserve_commercial_zone per la concorrenza", () => {
    // Due chiamate consecutive con lo stesso slug passano il gate:
    // la protezione concorrente è demandata alla RPC DB (già esistente).
    expect(reserveGate("centro-storico").status).toBe(200);
    expect(reserveGate("centro-storico").status).toBe(200);
  });
});
