// UEradar — estrattori locali high-confidence dell'azione "backfill_nulls".
// Vivono in supabase/functions/trovabandi-engine/index.ts (runtime Deno):
// li isoliamo dalla sorgente reale per testarne il comportamento effettivo.

import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, rmSync } from "node:fs";

const ENGINE = readFileSync(
  "supabase/functions/trovabandi-engine/index.ts",
  "utf8",
);

const start = ENGINE.indexOf("// BACKFILL_HELPERS_START");
const end = ENGINE.indexOf("// BACKFILL_HELPERS_END");
expect(start).toBeGreaterThan(-1);
expect(end).toBeGreaterThan(start);

// Il modulo temporaneo conserva i tipi originali: la sorgente reale viene
// transpilata da Vitest, senza riscritture manuali che ne altererebbero la logica.
const TMP = "src/test/.trovabandi-backfill-helpers.generated.ts";
writeFileSync(
  TMP,
  `${ENGINE.slice(start, end)}\nexport { localExtractDeadline, localExtractAmounts };\n`,
);

const helpers = (await import(
  /* @vite-ignore */ `./.trovabandi-backfill-helpers.generated.ts?t=${Date.now()}`
)) as {
  localExtractDeadline: (markdown: string) => string | null;
  localExtractAmounts: (markdown: string) => {
    min_grant_amount?: number;
    max_grant_amount?: number;
    total_budget?: number;
  };
};
rmSync(TMP, { force: true });

const { localExtractDeadline, localExtractAmounts } = helpers;

describe("localExtractDeadline", () => {
  it("estrae la data italiana in lettere", () => {
    expect(localExtractDeadline("Scadenza: 15 settembre 2026")).toBe(
      "2026-09-15T00:00:00.000Z",
    );
  });

  it("estrae la data inglese ordinale", () => {
    expect(localExtractDeadline("Deadline 15th September 2026")).toBe(
      "2026-09-15T00:00:00.000Z",
    );
  });

  it("estrae la data numerica vicino a keyword", () => {
    expect(localExtractDeadline("Termine: 01/03/2027")).toBe(
      "2027-03-01T00:00:00.000Z",
    );
  });

  it("estrae la data dopo 'termine ultimo'", () => {
    expect(localExtractDeadline("Termine ultimo 30 settembre 2026")).toBe(
      "2026-09-30T00:00:00.000Z",
    );
  });

  it("estrae la data numerica dopo 'scadenza il'", () => {
    expect(localExtractDeadline("scadenza il 15/09/2026")).toBe(
      "2026-09-15T00:00:00.000Z",
    );
  });

  it("restituisce null senza keyword di scadenza", () => {
    expect(
      localExtractDeadline("Il bando è stato pubblicato il 15 settembre 2026"),
    ).toBeNull();
  });

  it("restituisce null su testo cortissimo", () => {
    expect(localExtractDeadline("bando")).toBeNull();
  });

  it("restituisce null su anni fuori finestra", () => {
    expect(localExtractDeadline("Scadenza: 15 settembre 2099")).toBeNull();
  });
});

describe("localExtractAmounts", () => {
  it("estrae l'importo massimo con separatore di migliaia", () => {
    expect(localExtractAmounts("Contributo fino a 500.000 euro")).toMatchObject(
      { max_grant_amount: 500000 },
    );
  });

  it("estrae la dotazione espressa in milioni", () => {
    expect(
      localExtractAmounts("Il bando ha una dotazione di 2 milioni di euro"),
    ).toMatchObject({ total_budget: 2000000 });
  });

  it("estrae gli importi espressi in 'mila'", () => {
    expect(localExtractAmounts("Agevolazione fino a 50 mila euro"))
      .toMatchObject({ max_grant_amount: 50000 });
  });

  it("estrae la dotazione finanziaria con virgola italiana", () => {
    expect(
      localExtractAmounts(
        "La dotazione finanziaria è di 356,4 milioni di euro.",
      ),
    ).toMatchObject({ total_budget: 356400000 });
  });

  it("estrae il massimale espresso in milioni con virgola", () => {
    expect(localExtractAmounts("Contributo massimo 2,5 milioni di euro"))
      .toMatchObject({ max_grant_amount: 2500000 });
  });

  it("estrae 'fino a 500 mila euro'", () => {
    expect(localExtractAmounts("Agevolazione fino a 500 mila euro"))
      .toMatchObject({ max_grant_amount: 500000 });
  });

  it("non inventa importi su testo senza cifre", () => {
    expect(localExtractAmounts("Bando per imprese del territorio")).toEqual({});
  });
});
