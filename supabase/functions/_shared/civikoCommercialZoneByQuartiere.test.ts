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
    ["Forcellini", "nord-est"],
    ["Camin", "est-brenta"],
    ["ZIP", "est-brenta"],
    ["Zona Industriale", "est-brenta"],
    ["Sant'Osvaldo", "sud-est-sant-osvaldo"],
    ["S. Osvaldo", "sud-est-sant-osvaldo"],
    ["Città Giardino", "sud-est-sant-osvaldo"],
    ["San Paolo", "sud-est-sant-osvaldo"],
    ["Voltabarozzo", "sud-voltabarozzo-guizza"],
    ["Guizza", "sud-voltabarozzo-guizza"],
    ["SS. Crocefisso", "sud-voltabarozzo-guizza"],
    ["Crocifisso", "sud-voltabarozzo-guizza"],
    ["CROCIFISSO", "sud-voltabarozzo-guizza"],
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
    expect(commercialZoneForQuartiereParts(["Terranegra", "San Gregorio"])).toBe("nord-est");
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

describe("commercialZoneForQuartiere — alias composti nuovi", () => {
  const cases: Array<[string, string]> = [
    // centro-storico
    ["Prato della Valle Universitario", "centro-storico"],
    ["Portello Ognissanti", "centro-storico"],
    ["Piazze Duomo", "centro-storico"],
    ["Savonarola Ponte Molino", "centro-storico"],
    ["Santa Sofia Altinate", "centro-storico"],
    ["Prato della Valle Pontecorvo", "centro-storico"],
    ["Portello Ospedali", "centro-storico"],
    ["Riviere", "centro-storico"],
    ["Ferrovia", "centro-storico"],
    ["Specola", "centro-storico"],
    ["Specola Corso Milano", "centro-storico"],
    ["Piazza Mazzini Ospedale Militare", "centro-storico"],
    ["Scrovegni", "centro-storico"],
    ["Zona entro Riviere via XX Settembre", "centro-storico"],
    // nord-arcella
    ["Nord Arcella", "nord-arcella"],
    ["Pontevigodarzere Ovest", "nord-arcella"],
    ["San Carlo San Bellino", "nord-arcella"],
    ["Santissima Trinita", "nord-arcella"],
    ["San Bellino San Filippo Neri", "nord-arcella"],
    ["Borgomagno Prima Arcella Pescarotto", "nord-arcella"],
    ["Arcella Sant Antonino", "nord-arcella"],
    // est-brenta
    ["Est Brenta", "est-brenta"],
    ["Stanga Pio X", "est-brenta"],
    ["Ponte di Brenta San Lazzaro", "est-brenta"],
    // nord-est / est-brenta (contratto v2)
    ["Camin San Marco", "est-brenta"],
    ["Camin Industriale", "est-brenta"],
    ["Forcellini Terranegra", "nord-est"],
    ["Camin Sud", "est-brenta"],
    ["S Gregorio Terranegra Forcellini Est", "nord-est"],
    // Alias composto Subito validato same-zone
    ["Zona Industriale ZIP", "est-brenta"],
    ["ZONA INDUSTRIALE,ZIP", "est-brenta"],
    ["BASSANELLO, GUIZZA, VOLTABAROZZO", "sud-voltabarozzo-guizza"],
    // sud-est-sant-osvaldo
    ["Sud Est Sant Osvaldo", "sud-est-sant-osvaldo"],
    ["Sant Osvaldo Facciolati", "sud-est-sant-osvaldo"],
    ["Citta Giardino Santa Croce", "sud-est-sant-osvaldo"],
    ["Madonna Pellegrina S Rita Nazareth Sant Osvaldo", "sud-est-sant-osvaldo"],
    ["Sant Osvaldo San Paolo", "sud-est-sant-osvaldo"],
    ["San Camillo Nazareth", "sud-est-sant-osvaldo"],
    // sud-voltabarozzo-guizza
    ["Sud Voltabarozzo Guizza", "sud-voltabarozzo-guizza"],
    ["Voltabarozzo Guizza", "sud-voltabarozzo-guizza"],
    ["Bassanello Guizza Voltabarozzo", "sud-voltabarozzo-guizza"],
    ["Sud Guizza Bassanello", "sud-voltabarozzo-guizza"],
    ["Crocifisso Ponte Quattro Martiri", "sud-voltabarozzo-guizza"],
    // sud-ovest-mandria
    ["Sud Ovest Mandria", "sud-ovest-mandria"],
    ["Paltana Mandria", "sud-ovest-mandria"],
    ["Paltana Voltabrusegana Mandria", "sud-ovest-mandria"],
    // ovest-chiesanuova-brentelle
    ["Ovest Chiesanuova Brentelle", "ovest-chiesanuova-brentelle"],
    ["Chiesanuova Brentelle", "ovest-chiesanuova-brentelle"],
    ["Ovest Sacra Famiglia Chiesanuova Brusegana Altichiero", "ovest-chiesanuova-brentelle"],
    ["Brentelle Chiesanuova Cave", "ovest-chiesanuova-brentelle"],
    ["San Giuseppe San Giovanni", "ovest-chiesanuova-brentelle"],
    ["Palestro Sacra Famiglia San Giuseppe", "ovest-chiesanuova-brentelle"],
    ["Sacra Famiglia Basso Isonzo", "ovest-chiesanuova-brentelle"],
    ["Chiesanuova Brusegana", "ovest-chiesanuova-brentelle"],
    ["Brusegana Aeroporto", "ovest-chiesanuova-brentelle"],
    ["Altichero", "ovest-chiesanuova-brentelle"],
    ["Monta Sant Ignazio", "ovest-chiesanuova-brentelle"],
    ["S Ignazio Monta Altichiero", "ovest-chiesanuova-brentelle"],
  ];
  for (const [name, slug] of cases) {
    it(`${name} → ${slug}`, () => expect(commercialZoneForQuartiere(name)).toBe(slug));
  }
});

describe("commercialZoneForQuartiere — null obbligatori", () => {
  const nulls = [
    "altre zone",
    "sconosciuta",
    "sconosciuta padova citta",
    "mortise arcella est",
    "mandria savonarola",
    "torre ponte di brenta san marco camin",
    "ospedale militare piazza mazzini porta trento",
    "sud voltabarozzo guizza mandria paltana",
    "portello stazione stanga forcellini",
    "rurale periferia r2",
    "rurale sud guizza",
    "rurale nord",
    "carmine savonarola riviere ext porta san giovanni citta giardino santa giustina santo santa sofia",
    "torre pontevigodarzere sacro cuore",
    "arcella nord mortise",
    "pontevigodarzere isola di torre",
    "san carlo san gregorio",
    "stazione scrovegni c so del popolo fiera cittadella",
    // Etichette Subito cross-zona o generiche/commerciali: DEVONO restare null
    "torre pontevigodarzere sacro cuore",
    "stazione,scrovegni,c.so del popolo,fiera, cittadella",
    // "s. gregorio, terranegra, forcellini est" è già alias esplicito preesistente
    // ("S Gregorio Terranegra Forcellini Est"): quindi risolvibile, non va tra i null.
    "altre zone",
    "zona direzionale padovauno",
    "selvazzano dentro",
    "piazza del municipio",
    "via alsazia 3",
    "via croce bianca n 22 24",
    "via del perloso n 14 16 18",
    "via poma 8",
    "via unita d italia e via caperle",
  ];
  for (const s of nulls) {
    it(`"${s}" → null`, () => expect(commercialZoneForQuartiere(s)).toBeNull());
  }
});
