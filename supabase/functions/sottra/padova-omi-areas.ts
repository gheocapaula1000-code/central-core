// Sottra report overlay: Paula's 7 Padova display zones.
// Each area is a documented group of official Agenzia delle Entrate
// OMI microzones. No invented letters. Prices stay the matched microzona
// min/max — never an average of B1+B2 or a city-wide envelope.

export type PadovaSellableAreaId =
  | "centro"
  | "stazione_portello"
  | "arcella"
  | "est"
  | "ovest"
  | "sud"
  | "nord";

export type PadovaSellableArea = {
  id: PadovaSellableAreaId;
  name: string;
  omiCodes: readonly string[];
  quartieri: string;
};

/**
 * Official Padova letters that are not in the 7-zone product cut
 * (C4 PadovaUno, E2 ZIP, R2/R3 rural). Fail-closed: no invented display name.
 */
export const PADOVA_UNMAPPED_OMI = ["C4", "E2", "R2", "R3"] as const;

/** Paula's 7 display zones. Codes are official omi_zone.zona only. */
export const PADOVA_SELLABLE_AREAS: readonly PadovaSellableArea[] = [
  {
    id: "centro",
    name: "Centro",
    omiCodes: ["B1", "B2"],
    quartieri: "Entro Riviere / Via XX Settembre; Carmine, Savonarola, Riviere ext., Porta San Giovanni, Città Giardino, Santa Giustina, Santo, Santa Sofia",
  },
  {
    id: "stazione_portello",
    name: "Stazione / Portello",
    omiCodes: ["C1", "C2"],
    quartieri: "Portello; Stazione / Scrovegni / Corso del Popolo / Fiera / Cittadella",
  },
  {
    id: "arcella",
    name: "Arcella",
    omiCodes: ["C3", "D7"],
    quartieri: "Borgomagno / Prima Arcella / Pescarotto; Arcella Nord / Mortise",
  },
  {
    id: "est",
    name: "Est",
    omiCodes: ["D8", "D4", "E1"],
    quartieri: "S.Gregorio / Terranegra / Forcellini Est; Ponte di Brenta / San Lazzaro; Camin",
  },
  {
    id: "ovest",
    name: "Ovest",
    omiCodes: ["C5", "C6", "D1", "D2"],
    quartieri: "Madonna Pellegrina / S.Rita / Nazareth / Sant'Osvaldo; Palestro / Sacra Famiglia / San Giuseppe; Chiesanuova / Brusegana; Paltana / Voltabrusegana / Mandria",
  },
  {
    id: "sud",
    name: "Sud",
    omiCodes: ["D3", "E3"],
    quartieri: "Bassanello / Guizza / Voltabarozzo; Salboro",
  },
  {
    id: "nord",
    name: "Nord",
    omiCodes: ["D5", "D6", "R1"],
    quartieri: "S.Ignazio / Montà / Altichiero; Torre / Pontevigodarzere / Sacro Cuore; Ponterotto",
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

/** Map an official OMI letter (B1, C3, …) to one of the 7 display zones. Fail-closed. */
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

export function displayAreaName(areaName: string, omiCode: string): string {
  return `${areaName} (OMI ${omiCode})`;
}

export function officialPriceLabel(areaName: string, omiCode: string): string {
  return (
    `Area ${areaName} — €/m² ufficiali OMI microzona ${omiCode} ` +
    `(stato NORMALE). Non è una media delle microzone dell'area e non è una media comunale.`
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
 * Padova report overlay: friendly name + official matched letter.
 * Prices stay that microzona's official range. Never average siblings.
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
        "Punto non collocato in una delle 7 aree Padova: nessun nome zona e nessun min/max comunale da 18 microzone.",
      ],
    };
  }

  const officialCode = (result.officialMicrozona || result.zona || "").trim().toUpperCase();
  const area = mapPadovaOmiToArea(officialCode);
  if (!area) {
    return {
      ...result,
      officialMicrozona: officialCode,
      areaId: undefined,
      areaName: undefined,
      limitations: [
        ...result.limitations,
        `Microzona ufficiale ${officialCode} non appartiene alle 7 aree display Padova — nessun nome area inventato.`,
      ],
    };
  }

  const matched = (result.tutteZone ?? []).filter((z) => (z.zona || "").toUpperCase() === officialCode);
  const areaMembers = area.omiCodes.map((code) => {
    const row = (result.tutteZone ?? []).find((z) => (z.zona || "").toUpperCase() === code);
    const isMatched = code === officialCode;
    return {
      zona: code,
      zona_descr: row?.zona_descr ?? (isMatched ? (result.zona_descr ?? "") : ""),
      // Only the matched microzona carries prices. Siblings are listed, not averaged.
      compr_min: isMatched ? (result.compr_min ?? row?.compr_min ?? null) : null,
      compr_max: isMatched ? (result.compr_max ?? row?.compr_max ?? null) : null,
      loc_min: isMatched ? (result.loc_min ?? row?.loc_min ?? null) : null,
      loc_max: isMatched ? (result.loc_max ?? row?.loc_max ?? null) : null,
      tipologia: row?.tipologia ?? result.tipologia ?? "Abitazioni civili",
    };
  });

  return {
    ...result,
    zona: displayAreaName(area.name, officialCode),
    officialMicrozona: officialCode,
    areaId: area.id,
    areaName: area.name,
    zona_descr: `${area.name} (${area.quartieri}). Quotazione ufficiale OMI ${officialCode}${result.zona_descr ? ` — ${result.zona_descr}` : ""}. Non è la media di ${area.omiCodes.join("+")}.`,
    pricingPrecisionLabel: officialPriceLabel(area.name, officialCode),
    tutteZone: areaMembers.length ? areaMembers : (matched.length ? matched : undefined),
    limitations: [
      ...result.limitations,
      officialPriceLabel(area.name, officialCode),
      `Area ${area.name} raggruppa le microzone ufficiali ${area.omiCodes.join(", ")} — il range pubblicato è solo ${officialCode}, non B1+B2 e non il min/max di Padova.`,
    ],
  };
}
