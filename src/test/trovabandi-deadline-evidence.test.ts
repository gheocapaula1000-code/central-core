// UEradar — matcher della data di scadenza (fail-closed).
// Il matcher vive in supabase/functions/trovabandi-engine/index.ts (runtime Deno):
// lo isoliamo dalla sorgente reale per testarne il comportamento effettivo.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ENGINE = readFileSync("supabase/functions/trovabandi-engine/index.ts", "utf8");

const start = ENGINE.indexOf("const ITALIAN_MONTH_NAMES");
const end = ENGINE.indexOf("\nfunction stringArray");
expect(start).toBeGreaterThan(-1);
expect(end).toBeGreaterThan(start);

const source = ENGINE.slice(start, end).replace(
  /markdown: string, iso: string \| null/,
  "markdown, iso",
);

const dateIsPresentInEvidence = new Function(
  `${source}\nreturn dateIsPresentInEvidence;`,
)() as (markdown: string, iso: string | null) => boolean;

const ISO = "2026-09-15T00:00:00.000Z";

describe("dateIsPresentInEvidence — formati già supportati", () => {
  it.each([
    "Scadenza 2026-09-15",
    "Scadenza 15/09/2026",
    "Scadenza 15/9/2026",
    "Scadenza 15-09-2026",
    "Scadenza 15 settembre 2026",
  ])("riconosce %s", (markdown) => {
    expect(dateIsPresentInEvidence(markdown, ISO)).toBe(true);
  });
});

describe("dateIsPresentInEvidence — date ufficiali UE in inglese", () => {
  it.each([
    "Deadline: 15 September 2026",
    "Deadline: September 15, 2026",
    "Deadline: 15th September 2026",
    "Deadline: 15th Sept. 2026",
    "Deadline: 15 Sep 2026",
    "Deadline: Sep. 15 2026",
    "Deadline:   15    September    2026",
    "DEADLINE: 15 SEPTEMBER 2026",
  ])("riconosce %s", (markdown) => {
    expect(dateIsPresentInEvidence(markdown, ISO)).toBe(true);
  });

  it("riconosce gli ordinali 1st/2nd/3rd/4th", () => {
    expect(dateIsPresentInEvidence("Closes 1st March 2026", "2026-03-01T00:00:00.000Z")).toBe(true);
    expect(dateIsPresentInEvidence("Closes 2nd March 2026", "2026-03-02T00:00:00.000Z")).toBe(true);
    expect(dateIsPresentInEvidence("Closes 3rd March 2026", "2026-03-03T00:00:00.000Z")).toBe(true);
    expect(dateIsPresentInEvidence("Closes 4th March 2026", "2026-03-04T00:00:00.000Z")).toBe(true);
  });
});

describe("dateIsPresentInEvidence — fail-closed", () => {
  it("rifiuta mese/anno senza giorno", () => {
    expect(dateIsPresentInEvidence("Deadline: September 2026", ISO)).toBe(false);
  });

  it("rifiuta un giorno diverso", () => {
    expect(dateIsPresentInEvidence("Deadline: 16 September 2026", ISO)).toBe(false);
    expect(dateIsPresentInEvidence("Deadline: 150 September 2026", ISO)).toBe(false);
  });

  it("rifiuta un mese diverso", () => {
    expect(dateIsPresentInEvidence("Deadline: 15 October 2026", ISO)).toBe(false);
  });

  it("rifiuta un anno diverso", () => {
    expect(dateIsPresentInEvidence("Deadline: 15 September 2027", ISO)).toBe(false);
    expect(dateIsPresentInEvidence("Deadline: 15 September 20261", ISO)).toBe(false);
  });

  it("rifiuta evidenza assente o data non valida", () => {
    expect(dateIsPresentInEvidence("Nessuna data", ISO)).toBe(false);
    expect(dateIsPresentInEvidence("15 September 2026", null)).toBe(false);
    expect(dateIsPresentInEvidence("15 September 2026", "non-una-data")).toBe(false);
  });
});
