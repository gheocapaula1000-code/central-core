import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION = resolve(
  process.cwd(),
  "docs/sql/20260804071500_idealista_tipo_lead_fail_closed.sql",
);

const sql = readFileSync(MIGRATION, "utf8");

/** Mirror TS della normalizzazione SQL applicata al ramo Idealista. */
function normalizeTipoLead(raw: string | null | undefined): "AGENZIA" | "PRIVATO" | null {
  const v = (raw ?? "").trim().toUpperCase();
  if (v === "AGENZIA") return "AGENZIA";
  if (v === "PRIVATO") return "PRIVATO";
  return null;
}

describe("Idealista tipo_lead fail-closed", () => {
  it("copia AGENZIA dalla riga sorgente", () => {
    expect(normalizeTipoLead("AGENZIA")).toBe("AGENZIA");
    expect(normalizeTipoLead(" agenzia ")).toBe("AGENZIA");
  });

  it("copia PRIVATO dalla riga sorgente", () => {
    expect(normalizeTipoLead("PRIVATO")).toBe("PRIVATO");
    expect(normalizeTipoLead("privato")).toBe("PRIVATO");
  });

  it("fail-closed su valore assente o non valido: mai PRIVATO automatico", () => {
    for (const bad of [null, undefined, "", "   ", "UNKNOWN", "builder", "agenzia_immobiliare"]) {
      expect(normalizeTipoLead(bad as string | null)).toBeNull();
    }
  });

  it("il ramo Idealista non hardcoda piu' 'PRIVATO'", () => {
    const idealistaBranch = sql.slice(sql.indexOf("WITH src_id AS"));
    expect(idealistaBranch).not.toContain("'PRIVATO'::text");
    expect(idealistaBranch).toContain("WHEN 'AGENZIA' THEN 'AGENZIA'");
    expect(idealistaBranch).toContain("WHEN 'PRIVATO' THEN 'PRIVATO'");
    expect(idealistaBranch).toContain("ELSE NULL");
    expect(idealistaBranch).toContain("s.tipo_lead");
  });

  it("il ramo altri portali resta invariato", () => {
    const otherBranch = sql.slice(sql.indexOf("WITH src AS"), sql.indexOf("WITH src_id AS"));
    expect(otherBranch).toContain("'PRIVATO'::text");
    expect(otherBranch).not.toContain("WHEN 'AGENZIA' THEN 'AGENZIA'");
  });

  it("l'update preserva il valore esistente quando la sorgente e' NULL", () => {
    expect(sql.match(/tipo_lead = COALESCE\(EXCLUDED\.tipo_lead, public\.padova_listings\.tipo_lead\)/g)?.length).toBe(2);
  });
});
