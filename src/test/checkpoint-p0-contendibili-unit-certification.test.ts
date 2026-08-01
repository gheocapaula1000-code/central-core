// CHECKPOINT P0 — Eliminazione falsi contendibili.
// Contratto statico: la documentazione della correzione deve dichiarare le
// regole fail-closed di certificazione dell'unità immobiliare.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const DOC = readFileSync(
  "docs/pending-migrations/APPLIED_20260801060000_padova_contendibili_unit_certification_v3.sql",
  "utf8",
);

describe("contendibili — certificazione unità (v3)", () => {
  it("dichiara la versione di match", () => {
    expect(DOC).toContain("v3-unit-certified");
  });

  it("richiede civico obbligatorio e vieta via/coordinate come identità", () => {
    expect(DOC).toContain("CIVICO (obbligatorio)");
    expect(DOC).toMatch(/Coordinate uguali o stesso civico, da soli, NON certificano/);
  });

  it("elenca le tre evidenze forti ammesse", () => {
    for (const ev of ["PIANO", "REF", "DESCR"]) {
      expect(DOC).toContain(ev);
    }
  });

  it("fissa le soglie di compatibilità", () => {
    expect(DOC).toContain("mq_min * 1.05");
    expect(DOC).toContain("prezzo_min * 1.35");
    expect(DOC).toContain("n_agenzie distinte >= 2");
  });

  it("esclude le concatenazioni transitive", () => {
    expect(DOC).toMatch(/nessuna concatenazione transitiva/i);
  });

  it("prevede quarantena fail-closed e QA transazionale", () => {
    expect(DOC).toContain("padova_contendibili_quarantena");
    expect(DOC).toMatch(/Fail-closed/i);
    expect(DOC).toMatch(/nulla viene scritto/);
  });
});
