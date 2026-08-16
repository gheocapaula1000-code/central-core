// TrovaBandi — contratto di matching per la ditta individuale.
// Verifica statica su trovabandi-engine: nessuna invenzione di requisiti,
// fail-open ("da verificare") al posto del blocco quando la fonte non è verificata.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ENGINE = readFileSync("supabase/functions/trovabandi-engine/index.ts", "utf8");

describe("matchOpportunity — ditta individuale", () => {
  it("riconosce le forme del profilo assimilate a ditta individuale", () => {
    for (const form of [
      "DITTAINDIVIDUALE",
      "DI",
      "PERSONAFISICA",
      "LAVORATOREAUTONOMO",
    ]) {
      expect(ENGINE).toContain(`"${form}"`);
    }
  });

  it("ammette la ditta individuale se l'elenco cita imprese/PMI/micro", () => {
    expect(ENGINE).toContain("SOLE_PROPRIETOR_COMPATIBLE_FORMS");
    expect(ENGINE).toContain(
      'confirmed.push("Forma giuridica ammessa (ditta individuale)")',
    );
  });

  it("include tutte le voci compatibili richieste (MICRO, PICCOLA, PMI, IMPRESE, DI, PERSONA FISICA, LAVORATORE AUTONOMO)", () => {
    for (const form of [
      "MICRO",
      "PICCOLA",
      "PMI",
      "IMPRESE",
      "DI",
      "PERSONAFISICA",
      "LAVORATOREAUTONOMO",
    ]) {
      expect(ENGINE).toContain(`"${form}"`);
    }
  });

  it("blocca solo se l'elenco ufficiale è composto esclusivamente da società", () => {
    expect(ENGINE).toContain(
      "forms.every((form) => COMPANY_ONLY_FORMS.has(form))",
    );
    expect(ENGINE).toContain(
      'blockers.push("Forma giuridica non ammessa: solo società")',
    );
  });

  it("elenco forme vuoto resta 'da verificare'", () => {
    expect(ENGINE).toContain(
      'if (forms.length === 0) missing.push("Forma giuridica da verificare")',
    );
  });
});

describe("matchOpportunity — ATECO fail-open su fonti non verificate", () => {
  it("blocca solo se il bando è VERIFICATO", () => {
    expect(ENGINE).toContain(
      'else if (verified) blockers.push("Codice ATECO non compreso");',
    );
    expect(ENGINE).toContain(
      'else missing.push("ATECO da verificare nel testo ufficiale");',
    );
  });
});

describe("matchOpportunity — conferme mirate", () => {
  it("conferma il femminile solo su bandi femminili", () => {
    expect(ENGINE).toContain('category === "IMPRENDITORIAFEMMINILE"');
    expect(ENGINE).toContain(
      'confirmed.push("Requisito imprenditoria femminile soddisfatto")',
    );
  });

  it("conferma il digitale solo con ATECO 62/63 su bandi DIGITALIZZAZIONE", () => {
    expect(ENGINE).toContain('category === "DIGITALIZZAZIONE"');
    expect(ENGINE).toContain('ateco.startsWith("62") || ateco.startsWith("63")');
  });

  it("0 dipendenti resta MICRO: soglia invariata", () => {
    expect(ENGINE).toContain(
      'if (employees < 10 && revenue <= 2_000_000) return "MICRO";',
    );
  });
});
