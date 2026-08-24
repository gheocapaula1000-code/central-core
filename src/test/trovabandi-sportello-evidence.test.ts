// UEradar — sportello senza scadenza: SPORTELLO, mai PARZIALE, mai date inventate.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hasSportelloEvidence } from "../../supabase/functions/trovabandi-engine/detail";

const ENGINE = readFileSync("supabase/functions/trovabandi-engine/index.ts", "utf8");

describe("hasSportelloEvidence", () => {
  it.each([
    "Le domande sono presentate a sportello fino a esaurimento delle risorse.",
    "Procedura a sportello, senza scadenza predefinita per la presentazione.",
    "L'avviso non ha scadenza: resta aperto fino ad esaurimento dei fondi.",
    "Sportello sempre aperto per le imprese del territorio veneto.",
  ])("riconosce lo sportello: %s", (text) => {
    expect(hasSportelloEvidence(text)).toBe(true);
  });

  it.each([
    "Le domande vanno presentate entro il 30 novembre 2026 tramite il portale.",
    "Lo sportello telematico chiude il 12 marzo 2026 alle ore 12:00.",
    "",
  ])("non inventa sportello: %s", (text) => {
    expect(hasSportelloEvidence(text)).toBe(false);
  });
});

describe("engine — SPORTELLO applicato a extract e backfill", () => {
  it("usa hasSportelloEvidence in entrambi i rami", () => {
    expect(ENGINE.match(/hasSportelloEvidence\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("non assegna SPORTELLO quando esiste una scadenza", () => {
    expect(ENGINE).toContain("!deadline && hasSportelloEvidence(proofText)");
    expect(ENGINE).toContain("!newDeadline && hasSportelloEvidence(page.markdown)");
  });

  it("VERIFICATO nel backfill richiede scadenza e importo massimo", () => {
    expect(ENGINE).toContain("newDeadline && deadlineProven && newMaxGrant != null");
  });
});
