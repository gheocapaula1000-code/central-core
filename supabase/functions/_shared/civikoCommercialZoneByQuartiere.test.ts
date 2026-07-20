import { describe, it, expect } from "vitest";
import {
  normalizePadovaQuartiere,
  PADOVA_QUARTIERE_TO_COMMERCIAL_ZONE,
  commercialZoneForQuartiere,
  commercialZoneForQuartiereParts,
} from "./civikoCommercialZoneByQuartiere.ts";
import {
  CIVIKO_COMMERCIAL_ZONE_SLUGS,
  isCivikoCommercialZoneSlug,
} from "./civikoCommercialZoneContract.ts";

describe("normalizePadovaQuartiere", () => {
  it("lowercase + trim + collasso spazi", () => {
    expect(normalizePadovaQuartiere("  Prato   della  Valle  ")).toBe("prato della valle");
  });
  it("rimuove diacritici", () => {
    expect(normalizePadovaQuartiere("Montà")).toBe("monta");
    expect(normalizePadovaQuartiere("Città Giardino")).toBe("citta giardino");
  });
  it("apostrofi e punteggiatura diventano spazio", () => {
    expect(normalizePadovaQuartiere("Sant'Osvaldo")).toBe("sant osvaldo");
    expect(normalizePadovaQuartiere("S. Rita")).toBe("s rita");
    expect(normalizePadovaQuartiere("Santo - Portello")).toBe("santo portello");
  });
  it("input non stringa → stringa vuota", () => {
    expect(normalizePadovaQuartiere(null)).toBe("");
    expect(normalizePadovaQuartiere(undefined)).toBe("");
    expect(normalizePadovaQuartiere(42)).toBe("");
  });
});

describe("PADOVA_QUARTIERE_TO_COMMERCIAL_ZONE", () => {
  it("tutti i valori sono slug ufficiali", () => {
    for (const slug of PADOVA_QUARTIERE_TO_COMMERCIAL_ZONE.values()) {
      expect(isCivikoCommercialZoneSlug(slug)).toBe(true);
    }
  });
  it("copre tutte le 8 zone", () => {
    const covered = new Set(PADOVA_QUARTIERE_TO_COMMERCIAL_ZONE.values());
    expect(covered.size).toBe(8);
    for (const s of CIVIKO_COMMERCIAL_ZONE_SLUGS) expect(covered.has(s)).toBe(true);
  });
  it("chiavi tutte normalizzate", () => {
    for (const k of PADOVA_QUARTIERE_TO_COMMERCIAL_ZONE.keys()) {
      expect(normalizePadovaQuartiere(k)).toBe(k);
    }
  });
});

describe("commercialZoneForQuartiere — match esatto", () => {
  const cases: Array<[string, string]> = [
    ["Centro", "centro-storico"],
    ["centro storico", "centro-storico"],
    ["Prato della Valle", "centro-storico"],
    ["Stazione Ferroviaria", "centro-storico"],
    ["Portello", "centro-storico"],
    ["Arcella", "nord-arcella"],
    ["Arcella Nord", "nord-arcella"],
    ["Pontevigodarzere", "nord-arcella"],
    ["San Bellino", "nord-arcella"],
    ["Fiera", "est-brenta"],
    ["Stanga", "est-brenta"],
    ["Mortise", "est-brenta"],
    ["Ponte di Brenta", "est-brenta"],
    ["Forcellini", "est-forcellini-camin"],
    ["Camin", "est-forcellini-camin"],
    ["ZIP", "est-forcellini-camin"],
    ["Zona Industriale", "est-forcellini-camin"],
    ["Sant'Osvaldo", "sud-est-sant-osvaldo"],
    ["S. Osvaldo", "sud-est-sant-osvaldo"],
    ["Città Giardino", "sud-est-sant-osvaldo"],
    ["San Paolo", "sud-est-sant-osvaldo"],
    ["Voltabarozzo", "sud-voltabarozzo-guizza"],
    ["Guizza", "sud-voltabarozzo-guizza"],
    ["SS. Crocefisso", "sud-voltabarozzo-guizza"],
    ["Bassanello", "sud-voltabarozzo-guizza"],
    ["Mandria", "sud-ovest-mandria"],
    ["Paltana", "sud-ovest-mandria"],
    ["Voltabrusegana", "sud-ovest-mandria"],
    ["Sacra Famiglia", "ovest-chiesanuova-brentelle"],
    ["Chiesanuova", "ovest-chiesanuova-brentelle"],
    ["Brentelle", "ovest-chiesanuova-brentelle"],
    ["Montà", "ovest-chiesanuova-brentelle"],
    ["Sant'Ignazio", "ovest-chiesanuova-brentelle"],
    ["Altichiero", "ovest-chiesanuova-brentelle"],
  ];
  for (const [name, slug] of cases) {
    it(`${name} → ${slug}`, () => expect(commercialZoneForQuartiere(name)).toBe(slug));
  }
});

describe("commercialZoneForQuartiere — fail-closed", () => {
  it("null / undefined / vuoto / sconosciuto → null", () => {
    expect(commercialZoneForQuartiere(null)).toBeNull();
    expect(commercialZoneForQuartiere(undefined)).toBeNull();
    expect(commercialZoneForQuartiere("")).toBeNull();
    expect(commercialZoneForQuartiere("   ")).toBeNull();
    expect(commercialZoneForQuartiere("Padova")).toBeNull();
    expect(commercialZoneForQuartiere("Venezia")).toBeNull();
    expect(commercialZoneForQuartiere(42)).toBeNull();
  });
  it("non fa fuzzy: 'Forcellin' → null", () => {
    expect(commercialZoneForQuartiere("Forcellin")).toBeNull();
  });
});

describe("commercialZoneForQuartiereParts — composte", () => {
  it("stessa zona → risolve", () => {
    expect(commercialZoneForQuartiereParts(["Mortise", "Torre"])).toBe("est-brenta");
    expect(commercialZoneForQuartiereParts(["Forcellini", "Camin"])).toBe("est-forcellini-camin");
    expect(commercialZoneForQuartiereParts(["Sacra Famiglia", "Chiesanuova"]))
      .toBe("ovest-chiesanuova-brentelle");
    expect(commercialZoneForQuartiereParts(["Mandria", "Paltana"])).toBe("sud-ovest-mandria");
    expect(commercialZoneForQuartiereParts(["Guizza", "Voltabarozzo"]))
      .toBe("sud-voltabarozzo-guizza");
  });
  it("zone diverse → null", () => {
    expect(commercialZoneForQuartiereParts(["Stazione", "Fiera"])).toBeNull();
    expect(commercialZoneForQuartiereParts(["Arcella Nord", "Mortise"])).toBeNull();
    expect(commercialZoneForQuartiereParts(["Torre", "Pontevigodarzere"])).toBeNull();
    expect(commercialZoneForQuartiereParts(["Pontevigodarzere", "Camin"])).toBeNull();
  });
  it("un elemento sconosciuto → null", () => {
    expect(commercialZoneForQuartiereParts(["Forcellini", "Sconosciuto"])).toBeNull();
    expect(commercialZoneForQuartiereParts(["Sconosciuto"])).toBeNull();
  });
  it("array vuoto o non array → null", () => {
    expect(commercialZoneForQuartiereParts([])).toBeNull();
    expect(commercialZoneForQuartiereParts(null)).toBeNull();
    expect(commercialZoneForQuartiereParts(undefined)).toBeNull();
  });
});
