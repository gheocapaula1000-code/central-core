import { describe, expect, it } from "vitest";
import {
  mapValoriRowsToQuotes,
  pickCivileHeadlineFromQuotes,
} from "../../supabase/functions/sottra/omi-zone-join.ts";

/** Official AdE omi_valori rows for Padova D8 / PD00002850 / 2025/1. Do not invent extras. */
const D8_VALORI_ROWS: Array<Record<string, unknown>> = [
  { descr_tipologia: "Abitazioni civili", stato: "NORMALE", compr_min: 1400, compr_max: 1850, loc_min: 6.5, loc_max: 9, semestre: "2025/1", link_zona: "PD00002850" },
  { descr_tipologia: "Abitazioni civili", stato: "OTTIMO", compr_min: 1800, compr_max: 2750, loc_min: 7, loc_max: 9.5, semestre: "2025/1", link_zona: "PD00002850" },
  { descr_tipologia: "Abitazioni di tipo economico", stato: "NORMALE", compr_min: 1150, compr_max: 1400, loc_min: 5.8, loc_max: 7.2, semestre: "2025/1", link_zona: "PD00002850" },
  { descr_tipologia: "Box", stato: "NORMALE", compr_min: 1200, compr_max: 1500, loc_min: 6, loc_max: 7.5, semestre: "2025/1", link_zona: "PD00002850" },
  { descr_tipologia: "Negozi", stato: "OTTIMO", compr_min: 1700, compr_max: 2550, loc_min: 9, loc_max: 15.5, semestre: "2025/1", link_zona: "PD00002850" },
  { descr_tipologia: "Uffici", stato: "NORMALE", compr_min: 1450, compr_max: 1950, loc_min: 6.9, loc_max: 9, semestre: "2025/1", link_zona: "PD00002850" },
  { descr_tipologia: "Ville e Villini", stato: "NORMALE", compr_min: 1800, compr_max: 2300, loc_min: 6.6, loc_max: 8, semestre: "2025/1", link_zona: "PD00002850" },
];

describe("official omi_valori quotes — Padova D8", () => {
  it("maps all 7 official rows and prefers civile NORMALE 1400–1850", () => {
    const quotes = mapValoriRowsToQuotes(D8_VALORI_ROWS);
    expect(quotes).toHaveLength(7);
    expect(quotes.map((q) => `${q.tipologia}|${q.stato}`)).toEqual([
      "Abitazioni civili|NORMALE",
      "Abitazioni civili|OTTIMO",
      "Abitazioni di tipo economico|NORMALE",
      "Box|NORMALE",
      "Negozi|OTTIMO",
      "Uffici|NORMALE",
      "Ville e Villini|NORMALE",
    ]);
    const headline = pickCivileHeadlineFromQuotes(quotes);
    expect(headline).toEqual({
      min: 1400,
      max: 1850,
      tipologia: "Abitazioni civili",
      stato: "NORMALE",
    });
    expect(headline.max).not.toBe(2750);
  });

  it("keeps missing loc_* null and does not invent rent", () => {
    const quotes = mapValoriRowsToQuotes([
      { descr_tipologia: "Box", stato: "NORMALE", compr_min: 1200, compr_max: 1500, loc_min: null, loc_max: null, semestre: "2025/1" },
    ]);
    expect(quotes[0].locMin).toBeNull();
    expect(quotes[0].locMax).toBeNull();
  });

  it("does not invent extra rows beyond stored omi_valori", () => {
    const quotes = mapValoriRowsToQuotes(D8_VALORI_ROWS);
    expect(quotes.some((q) => /garage|cantina/i.test(q.tipologia))).toBe(false);
    expect(quotes).toHaveLength(7);
  });

  it("prefers semestre 2025/1 when older rows are also present", () => {
    const quotes = mapValoriRowsToQuotes([
      { descr_tipologia: "Abitazioni civili", stato: "NORMALE", compr_min: 1000, compr_max: 1200, semestre: "2024/2" },
      ...D8_VALORI_ROWS,
    ]);
    expect(quotes).toHaveLength(7);
    expect(quotes[0].comprMin).toBe(1400);
    expect(quotes.every((q) => q.semestre === "2025/1")).toBe(true);
  });
});
