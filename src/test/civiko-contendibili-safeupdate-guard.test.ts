// CHECKPOINT — chain Civiko: la RPC contendibili è invocata via PostgREST,
// dove pg_safeupdate rifiuta ogni UPDATE/DELETE privo di WHERE (SQLSTATE 21000
// → HTTP 400). Il contratto statico impedisce la regressione.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SQL = readFileSync(
  "docs/pending-migrations/APPLIED_20260807_civiko_contendibili_safeupdate_where.sql",
  "utf8",
);

describe("Civiko chain — safeupdate guard sulla RPC contendibili", () => {
  it("patcha i due statement privi di WHERE", () => {
    expect(SQL).toContain("ELSE agency_n_full END WHERE true;");
    expect(SQL).toContain("DELETE FROM public.padova_contendibili_quarantena WHERE true;");
  });

  it("è fail-closed: fallisce se gli anchor non esistono più", () => {
    expect(SQL).toContain("anchor UPDATE _cand non trovato");
    expect(SQL).toContain("anchor DELETE quarantena non trovato");
    expect(SQL).toContain("patch safeupdate non applicata");
  });

  it("non compie operazioni distruttive sui dati immobiliari", () => {
    expect(SQL).not.toMatch(/TRUNCATE/i);
    expect(SQL).not.toMatch(/DROP\s+TABLE/i);
    expect(SQL).not.toMatch(/DELETE\s+FROM\s+public\.padova_listings/i);
    expect(SQL).not.toMatch(/padova_contendibili\s+WHERE/i);
  });

  it("non tocca zone ufficiali né percorsi non Civiko", () => {
    expect(SQL).not.toMatch(/civiko_commercial_zones/i);
    expect(SQL).not.toMatch(/trovabandi/i);
  });
});
