import { describe, it, expect } from "vitest";
import {
  PADOVA_SELLABLE_AREAS,
  PADOVA_UNMAPPED_OMI,
  displayAreaName,
  isPadovaComuneName,
  mapPadovaOmiToArea,
  officialPriceLabel,
  padovaAreaCount,
  padovaCoveredOmiCodes,
  presentPadovaSellableArea,
  type PadovaPresentableOmi,
} from "../../supabase/functions/sottra/padova-omi-areas.ts";
import {
  pickOfficialValoriRow,
  remapPolygonToOfficialZone,
} from "../../supabase/functions/sottra/omi-zone-join.ts";

const OFFICIAL_22 = [
  "B1", "B2", "C1", "C2", "C3", "C4", "C5", "C6",
  "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8",
  "E1", "E2", "E3", "R1", "R2", "R3",
];

const PAULA_7: Record<string, readonly string[]> = {
  Centro: ["B1", "B2"],
  "Stazione / Portello": ["C1", "C2"],
  Arcella: ["C3", "D7"],
  Est: ["D8", "D4", "E1"],
  Ovest: ["C5", "C6", "D1", "D2"],
  Sud: ["D3", "E3"],
  Nord: ["D5", "D6", "R1"],
};

const padovaZones = [
  { zona: "B1", zona_descr: "ZONA ENTRO RIVIERE-VIA XX SETTEMBRE", link_zona: "PD00000015", comune_descrizione: "PADOVA", comune_amm: "G224" },
  { zona: "C3", zona_descr: "BORGOMAGNO, PRIMA ARCELLA, PESCAROTTO", link_zona: "PD00000020", comune_descrizione: "PADOVA", comune_amm: "G224" },
  { zona: "B2", zona_descr: "CARMINE, SANTO", link_zona: "PD00000016", comune_descrizione: "PADOVA", comune_amm: "G224" },
];

function baseResult(over: Partial<PadovaPresentableOmi>): PadovaPresentableOmi {
  return {
    found: true,
    matchMethod: "polygon_match",
    pricingPrecisionLabel: "micro",
    limitations: [],
    comune: "PADOVA",
    ...over,
  };
}

describe("Padova display zones — Paula's exact 7", () => {
  it("defines exactly 7 display zones", () => {
    expect(padovaAreaCount()).toBe(7);
    expect(PADOVA_SELLABLE_AREAS.map((a) => a.name)).toEqual(Object.keys(PAULA_7));
  });

  it("maps official letters exactly as specified, no extras", () => {
    for (const area of PADOVA_SELLABLE_AREAS) {
      expect([...area.omiCodes]).toEqual([...PAULA_7[area.name]]);
      for (const code of area.omiCodes) {
        expect(OFFICIAL_22).toContain(code);
        expect(PADOVA_UNMAPPED_OMI).not.toContain(code);
      }
    }
    expect(padovaCoveredOmiCodes().sort()).toEqual(
      Object.values(PAULA_7).flat().slice().sort(),
    );
    expect(new Set(padovaCoveredOmiCodes()).size).toBe(18);
  });

  it("leaves C4/E2/R2/R3 unmapped — no invented 8th area", () => {
    for (const code of PADOVA_UNMAPPED_OMI) {
      expect(mapPadovaOmiToArea(code)).toBeNull();
    }
  });

  it("maps Centro B1 and Arcella C3 to different names", () => {
    expect(mapPadovaOmiToArea("B1")?.name).toBe("Centro");
    expect(mapPadovaOmiToArea("B2")?.name).toBe("Centro");
    expect(mapPadovaOmiToArea("C3")?.name).toBe("Arcella");
    expect(mapPadovaOmiToArea("D7")?.name).toBe("Arcella");
    expect(mapPadovaOmiToArea("B1")?.name).not.toBe(mapPadovaOmiToArea("C3")?.name);
  });

  it("fails closed on unknown or empty codes", () => {
    expect(mapPadovaOmiToArea("Z9")).toBeNull();
    expect(mapPadovaOmiToArea("")).toBeNull();
    expect(mapPadovaOmiToArea(null)).toBeNull();
  });

  it("recognizes Padova comune names only", () => {
    expect(isPadovaComuneName("PADOVA")).toBe(true);
    expect(isPadovaComuneName("Milano")).toBe(false);
  });
});

describe("geometry link_zona → official omi_zone", () => {
  it("remaps synthetic G224-B1 to official PD00000015", () => {
    const official = remapPolygonToOfficialZone(
      { zona: "B1", link_zona: "G224-B1", comune_descrizione: "PADOVA" },
      padovaZones,
    );
    expect(official?.link_zona).toBe("PD00000015");
    expect(official?.zona).toBe("B1");
  });

  it("remaps G224-C3 to official C3", () => {
    const official = remapPolygonToOfficialZone(
      { zona: "C3", link_zona: "G224-C3", comune_descrizione: "PADOVA" },
      padovaZones,
    );
    expect(official?.link_zona).toBe("PD00000020");
  });

  it("does not invent a zona when the join is not unique", () => {
    const dupes = [
      ...padovaZones,
      { zona: "B1", zona_descr: "DUP", link_zona: "PD999", comune_descrizione: "PADOVA", comune_amm: "G224" },
    ];
    expect(remapPolygonToOfficialZone({ zona: "B1", link_zona: "G224-B1" }, dupes)).toBeNull();
  });

  it("prefers official NORMALE valori over OTTIMO/SCADENTE", () => {
    const picked = pickOfficialValoriRow([
      { stato: "OTTIMO", compr_min: 3400, compr_max: 4700 },
      { stato: "NORMALE", compr_min: 2400, compr_max: 3400 },
      { stato: "SCADENTE", compr_min: 650, compr_max: 900 },
    ]);
    expect(picked?.compr_min).toBe(2400);
    expect(picked?.compr_max).toBe(3400);
  });
});

describe("presentPadovaSellableArea", () => {
  it("Via San Francesco / B1 shows Centro + B1 prices, not Arcella", () => {
    const out = presentPadovaSellableArea(baseResult({
      zona: "B1",
      officialMicrozona: "B1",
      zona_descr: "ZONA ENTRO RIVIERE-VIA XX SETTEMBRE",
      compr_min: 2400,
      compr_max: 3400,
      tutteZone: [
        { zona: "B1", zona_descr: "Riviere", compr_min: 2400, compr_max: 3400, loc_min: 8.5, loc_max: 11, tipologia: "Abitazioni civili" },
        { zona: "B2", zona_descr: "Carmine", compr_min: 2250, compr_max: 3100, loc_min: 7.9, loc_max: 10.5, tipologia: "Abitazioni civili" },
        { zona: "C3", zona_descr: "Arcella", compr_min: 1000, compr_max: 1150, loc_min: 5.5, loc_max: 6.6, tipologia: "Abitazioni civili" },
      ],
    }));
    expect(out.zona).toBe(displayAreaName("Centro", "B1"));
    expect(out.areaName).toBe("Centro");
    expect(out.areaId).toBe("centro");
    expect(out.officialMicrozona).toBe("B1");
    expect(out.compr_min).toBe(2400);
    expect(out.compr_max).toBe(3400);
    expect(out.tutteZone?.map((z) => z.zona)).toEqual(["B1", "B2"]);
    const b2 = out.tutteZone?.find((z) => z.zona === "B2");
    expect(b2?.compr_min).toBeNull();
    expect(b2?.compr_max).toBeNull();
    expect(out.pricingPrecisionLabel).toContain("B1");
    expect(officialPriceLabel("Centro", "B1")).toMatch(/non è una media/i);
  });

  it("Prima Arcella / C3 shows Arcella + C3 prices, not B1", () => {
    const centro = presentPadovaSellableArea(baseResult({
      zona: "B1", officialMicrozona: "B1", compr_min: 2400, compr_max: 3400,
    }));
    const arcella = presentPadovaSellableArea(baseResult({
      zona: "C3", officialMicrozona: "C3", zona_descr: "PRIMA ARCELLA",
      compr_min: 1000, compr_max: 1150,
    }));
    expect(arcella.zona).toBe(displayAreaName("Arcella", "C3"));
    expect(arcella.areaName).toBe("Arcella");
    expect(arcella.officialMicrozona).toBe("C3");
    expect(arcella.compr_min).toBe(1000);
    expect(arcella.compr_max).toBe(1150);
    expect(arcella.zona).not.toBe(centro.zona);
    expect(arcella.compr_min).not.toBe(centro.compr_min);
    expect(arcella.compr_max).not.toBe(centro.compr_max);
    expect(arcella.officialMicrozona).not.toBe("B1");
  });

  it("does not invent a display zone for unmapped official letters", () => {
    const out = presentPadovaSellableArea(baseResult({
      zona: "E2", officialMicrozona: "E2", compr_min: 800, compr_max: 1100,
    }));
    expect(out.areaName).toBeUndefined();
    expect(out.zona).toBe("E2");
    expect(out.officialMicrozona).toBe("E2");
    expect(out.compr_min).toBe(800);
  });

  it("unplaced Padova point stays comune_aggregate without a guessed letter or city range", () => {
    const out = presentPadovaSellableArea(baseResult({
      matchMethod: "comune_aggregate",
      zona: undefined,
      compr_min: 650,
      compr_max: 4700,
      tutteZone: OFFICIAL_22.map((z) => ({
        zona: z, zona_descr: z, compr_min: 650, compr_max: 4700, loc_min: null, loc_max: null, tipologia: "Abitazioni civili",
      })),
    }));
    expect(out.matchMethod).toBe("comune_aggregate");
    expect(out.zona).toBeUndefined();
    expect(out.officialMicrozona).toBeUndefined();
    expect(out.compr_min).toBeUndefined();
    expect(out.compr_max).toBeUndefined();
    expect(out.tutteZone).toBeUndefined();
    expect(out.limitations.some((l) => /7 aree/i.test(l))).toBe(true);
  });

  it("does not rewrite non-Padova results", () => {
    const out = presentPadovaSellableArea(baseResult({
      comune: "MILANO",
      zona: "B12",
      compr_min: 8700,
      compr_max: 11000,
    }));
    expect(out.zona).toBe("B12");
    expect(out.areaId).toBeUndefined();
  });
});
