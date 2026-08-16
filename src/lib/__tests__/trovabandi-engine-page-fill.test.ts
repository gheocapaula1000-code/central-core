import { describe, expect, it } from "vitest";
import {
  mergeDetailIntoExtraction,
  needsDetailEnrichment,
  parseAmounts,
  parseDeadline,
} from "../../../supabase/functions/trovabandi-engine/detail";

const NOW = new Date("2026-08-16T00:00:00Z");

function fillFromPageText(text: string) {
  const base = { deadline_at: null, max_grant_amount: null, total_budget: null };
  return mergeDetailIntoExtraction(base, {
    deadline: parseDeadline(text, NOW),
    amounts: parseAmounts(text),
  });
}

describe("UEradar — scadenza e importo letti dalla pagina ufficiale", () => {
  it("riempie i due campi dal testo della pagina scaricata", () => {
    const merged = fillFromPageText(
      "Le domande vanno presentate entro il 30 novembre 2026. Il contributo massimo concedibile è pari a 10.000 euro.",
    );
    expect(merged.patch.deadline_at).toBe("2026-11-30T23:59:00.000Z");
    expect(merged.patch.max_grant_amount).toBe(10000);
    expect(needsDetailEnrichment({ ...merged.patch })).toBe(false);
  });

  it("non inventa nulla su un testo senza date né cifre", () => {
    const merged = fillFromPageText(
      "L'avviso sostiene progetti di innovazione delle imprese del territorio.",
    );
    expect(merged.patch).toEqual({});
    expect(merged.filled).toEqual([]);
  });
});
