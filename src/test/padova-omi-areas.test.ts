import { describe, it, expect } from "vitest";
import {
  PADOVA_SELLABLE_AREAS,
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

const padovaZones = [
  { zona: "B1", zona_descr: "ZONA ENTRO RIVIERE-VIA XX SETTEMBRE", link_zona: "PD00000015", comune_descrizione: "PADOVA", comune_amm: "G224" },
  { zona: "C3", zona_descr: "BORGOMAGNO, PRIMA ARCELLA, PESCAROTTO", link_zona: "PD00000020", comune_descrizione: "PADOVA", comune_amm: "G224" },
  { zona: "B2", zona_descr: "CARMINE, SANTO", link_zona: "PD00000016", comune_descrizione: "PADOVA", comune_amm: "G224" },
];

function baseResult(over: Partial<PadovaPresentableOmi>): PadovaPresentableOmi {
  return {
    found: true,
    fonte: "Agenzia Entrate — OMI, 1° semestre 2025",
    matchConfidence: 0.98,
    matchMethod: "polygon_match",
    polygonMatch: true,
    omiGeoLevel: "microzona_omi",
    pricingPrecisionLabel: "micro",
    sourceCoverageLevel: "microzona",
    confidenceReason: "pip",
    limitations: [],
    comune: "PADOVA",
    ...over,
  };
}

describe("Padova sellable areas — 4–8 official groups", () => {
  it("defines between 4 and 8 recognizable areas", () => {
    expect(padovaAreaCount()).toBeGreaterThanOrEqual(4);
    expect(padovaAreaCount()).toBeLessThanOrEqual(8);
    expect(PADOVA_SELLABLE_AREAS).toHaveLength(8);
  });

  it("covers each official Padova OMI letter exactly once", () => {
    const covered = padovaCoveredOmiCodes();
    expect(covered.sort()).toEqual([...OFFICIAL_22].sort());
    expect(new Set(covered).size).toBe(22);
  });

  it("each area groups 2–3 official microzones, no invented letters", () => {
    for (const area of PADOVA_SELLABLE_AREAS) {
      expect(area.omiCodes.length).toBeGreaterThanOrEqual(2);
      expect(area.omiCodes.length).toBeLessThanOrEqual(3);
      for (const code of area.omiCodes) {
        expect(OFFICIAL_22).toContain(code);
      }
    }
  });

  it("maps Centro B1 and Arcella C3 to different area names", () => {
    const centro = mapPadovaOmiToArea("B1");
    const arcella = mapPadovaOmiToArea("C3");
    expect(centro?.id).toBe("centro_riviere");
    expect(arcella?.id).toBe("arcella_nord");
    expect(centro?.name).not.toBe(arcella?.name);
  });

  it("fails closed on unknown or empty codes", () => {
    expect(mapPadovaOmiToArea("Z9")).toBeNull();
    expect(mapPadovaOmiToArea("")).toBeNull();
    expect(mapPadovaOmiToArea(null)).toBeNull();
  });

  it("recognizes Padova comune names only", () => {
    expect(isPadovaComuneName("PADOVA")).toBe(true);
    expect(isPadovaComuneName("Padova")).toBe(true);
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
    expect(official?.zona).toBe("C3");
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
  it("Centro B1 becomes Centro / Riviere with official B1 prices, not city min/max", () => {
    const out = presentPadovaSellableArea(baseResult({
      zona: "B1",
      officialMicrozona: "B1",
      zona_descr: "ZONA ENTRO RIVIERE-VIA XX SETTEMBRE",
      compr_min: 2400,
      compr_max: 3400,
      tutteZone: [
        { zona: "B1", zona_descr: "Riviere", compr_min: 2400, compr_max: 3400, loc_min: 8.5, loc_max: 11, tipologia: "Abitazioni civili" },
        { zona: "C3", zona_descr: "Arcella", compr_min: 1000, compr_max: 1150, loc_min: 5.5, loc_max: 6.6, tipologia: "Abitazioni civili" },
      ],
    }));
    expect(out.zona).toBe("Centro / Riviere");
    expect(out.areaId).toBe("centro_riviere");
    expect(out.officialMicrozona).toBe("B1");
    expect(out.compr_min).toBe(2400);
    expect(out.compr_max).toBe(3400);
    expect(out.tutteZone?.map((z) => z.zona)).toEqual(["B1", "B2"]);
    expect(out.tutteZone?.length).toBeLessThanOrEqual(3);
    expect(out.pricingPrecisionLabel).toContain("B1");
    expect(officialPriceLabel("Centro / Riviere", "B1")).toMatch(/non è una media comunale/i);
  });

  it("Arcella C3 becomes Arcella-nord with a different range than Centro", () => {
    const centro = presentPadovaSellableArea(baseResult({
      zona: "B1", officialMicrozona: "B1", compr_min: 2400, compr_max: 3400,
    }));
    const arcella = presentPadovaSellableArea(baseResult({
      zona: "C3", officialMicrozona: "C3", zona_descr: "PRIMA ARCELLA",
      compr_min: 1000, compr_max: 1150,
    }));
    expect(arcella.zona).toBe("Arcella-nord");
    expect(arcella.areaId).toBe("arcella_nord");
    expect(arcella.officialMicrozona).toBe("C3");
    expect(arcella.zona).not.toBe(centro.zona);
    expect(arcella.compr_min).not.toBe(centro.compr_min);
    expect(arcella.compr_max).not.toBe(centro.compr_max);
  });

  it("unplaced Padova point stays comune_aggregate without a guessed letter or city range", () => {
    const out = presentPadovaSellableArea(baseResult({
      matchMethod: "comune_aggregate",
      polygonMatch: false,
      omiGeoLevel: "comune",
      sourceCoverageLevel: "comunale",
      matchConfidence: 0.72,
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
    expect(out.limitations.some((l) => /8 aree/i.test(l))).toBe(true);
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
