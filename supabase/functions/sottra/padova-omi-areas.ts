// Sottra report overlay: 8 recognizable Padova areas.
// Each area is a documented group of 2–3 official Agenzia delle Entrate
// OMI microzones. No invented letters. No city-wide min/max as a zona.

export type PadovaSellableAreaId =
  | "centro_riviere"
  | "stazione_portello"
  | "arcella_nord"
  | "est"
  | "ovest"
  | "sud"
  | "periferia_est"
  | "hinterland";

export type PadovaSellableArea = {
  id: PadovaSellableAreaId;
  name: string;
  omiCodes: readonly string[];
  quartieri: string;
};

/** 8 sellable areas. Union of omiCodes is the 22 official Padova microzones. */
export const PADOVA_SELLABLE_AREAS: readonly PadovaSellableArea[] = [
  {
    id: "centro_riviere",
    name: "Centro / Riviere",
    omiCodes: ["B1", "B2"],
    quartieri: "entro Riviere, Carmine, Santo, Santa Giustina",
  },
  {
    id: "stazione_portello",
    name: "Stazione / Portello",
    omiCodes: ["C1", "C2"],
    quartieri: "Portello, Stazione, Fiera, Scrovegni",
  },
  {
    id: "arcella_nord",
    name: "Arcella-nord",
    omiCodes: ["C3", "D6", "D7"],
    quartieri: "Prima Arcella, Borgomagno, Arcella Nord, Mortise, Torre",
  },
  {
    id: "est",
    name: "Est",
    omiCodes: ["C4", "D4", "D8"],
    quartieri: "San Lazzaro, Forcellini Est, Ponte di Brenta, PadovaUno",
  },
  {
    id: "ovest",
    name: "Ovest",
    omiCodes: ["D1", "D2", "D5"],
    quartieri: "Chiesanuova, Brusegana, Mandria, Altichiero",
  },
  {
    id: "sud",
    name: "Sud",
    omiCodes: ["C5", "C6", "D3"],
    quartieri: "Santa Rita, Palestro, Guizza, Voltabarozzo",
  },
  {
    id: "periferia_est",
    name: "Periferia est / ZIP",
    omiCodes: ["E1", "E2", "E3"],
    quartieri: "Camin, zona industriale ZIP, Salboro",
  },
  {
    id: "hinterland",
    name: "Hinterland",
    omiCodes: ["R1", "R2", "R3"],
    quartieri: "zone rurali, Ponterotto",
  },
] as const;

const CODE_TO_AREA = new Map<string, PadovaSellableArea>();
for (const area of PADOVA_SELLABLE_AREAS) {
  for (const code of area.omiCodes) {
    CODE_TO_AREA.set(code, area);
  }
}

export function isPadovaComuneName(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value.trim().toLowerCase().replace(/\s+/g, " ") === "padova";
}

/** Map an official OMI letter (B1, C3, …) to one sellable area. Fail-closed. */
export function mapPadovaOmiToArea(code: unknown): PadovaSellableArea | null {
  if (typeof code !== "string") return null;
  return CODE_TO_AREA.get(code.trim().toUpperCase()) ?? null;
}

export function padovaAreaCount(): number {
  return PADOVA_SELLABLE_AREAS.length;
}

export function padovaCoveredOmiCodes(): string[] {
  return PADOVA_SELLABLE_AREAS.flatMap((a) => [...a.omiCodes]);
}

export function officialPriceLabel(areaName: string, omiCode: string): string {
  return (
    `Area ${areaName} — €/m² ufficiali OMI microzona ${omiCode} ` +
    `(stato NORMALE). Non è una media comunale e non è un prezzo inventato.`
  );
}

export type PadovaPresentableOmi = {
  found: boolean;
  comune?: string;
  zona?: string;
  zona_descr?: string;
  officialMicrozona?: string;
  areaId?: string;
  areaName?: string;
  matchMethod: string;
  compr_min?: number;
  compr_max?: number;
  prezzoMedio?: number;
  loc_min?: number;
  loc_max?: number;
  tipologia?: string;
  pricingPrecisionLabel: string;
  limitations: string[];
  tutteZone?: Array<{
    zona: string;
    zona_descr: string;
    compr_min: number | null;
    compr_max: number | null;
    loc_min: number | null;
    loc_max: number | null;
    tipologia: string;
  }>;
};

/**
 * Padova report overlay: replace the raw OMI letter with one of 8 sellable
 * area names. Prices stay the official matched microzona range (NORMALE).
 * comune_aggregate stays unlabeled — no guessed area, no 18-zone dump.
 */
export function presentPadovaSellableArea<T extends PadovaPresentableOmi>(result: T): T {
  if (!isPadovaComuneName(result.comune)) return result;

  if (result.matchMethod === "comune_aggregate" || !result.zona) {
    return {
      ...result,
      found: result.matchMethod === "comune_aggregate" ? true : result.found,
      zona: undefined,
      officialMicrozona: undefined,
      areaId: undefined,
      areaName: undefined,
      compr_min: undefined,
      compr_max: undefined,
      prezzoMedio: undefined,
      loc_min: undefined,
      loc_max: undefined,
      tutteZone: undefined,
      limitations: [
        ...result.limitations.filter((l) => !/tutteZone/i.test(l)),
        "Punto non collocato in una delle 8 aree Padova: nessun nome zona e nessun min/max comunale da 18 microzone.",
      ],
    };
  }

  const officialCode = (result.officialMicrozona || result.zona || "").trim().toUpperCase();
  const area = mapPadovaOmiToArea(officialCode);
  if (!area) return result;

  const matched = (result.tutteZone ?? []).filter((z) => (z.zona || "").toUpperCase() === officialCode);
  const areaMembers = area.omiCodes.map((code) => {
    const row = (result.tutteZone ?? []).find((z) => (z.zona || "").toUpperCase() === code);
    return {
      zona: code,
      zona_descr: row?.zona_descr ?? (code === officialCode ? (result.zona_descr ?? "") : ""),
      compr_min: code === officialCode ? (result.compr_min ?? row?.compr_min ?? null) : (row?.compr_min ?? null),
      compr_max: code === officialCode ? (result.compr_max ?? row?.compr_max ?? null) : (row?.compr_max ?? null),
      loc_min: code === officialCode ? (result.loc_min ?? row?.loc_min ?? null) : (row?.loc_min ?? null),
      loc_max: code === officialCode ? (result.loc_max ?? row?.loc_max ?? null) : (row?.loc_max ?? null),
      tipologia: row?.tipologia ?? result.tipologia ?? "Abitazioni civili",
    };
  });

  return {
    ...result,
    zona: area.name,
    officialMicrozona: officialCode,
    areaId: area.id,
    areaName: area.name,
    zona_descr: `${area.name} (${area.quartieri}). Quotazione ufficiale OMI ${officialCode}${result.zona_descr ? ` — ${result.zona_descr}` : ""}.`,
    pricingPrecisionLabel: officialPriceLabel(area.name, officialCode),
    tutteZone: areaMembers.length ? areaMembers : (matched.length ? matched : undefined),
    limitations: [
      ...result.limitations,
      officialPriceLabel(area.name, officialCode),
      `Area ${area.name} raggruppa le microzone ufficiali ${area.omiCodes.join(", ")} — il range pubblicato è quello della microzona ${officialCode}, non il min/max di Padova.`,
    ],
  };
}
