import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const LEGACY_MIGRATION = resolve(
  process.cwd(),
  "docs/sql/20260804071500_idealista_tipo_lead_fail_closed.sql",
);
const MIGRATION = resolve(
  process.cwd(),
  "docs/pending-migrations/20260806150000_civiko_padova_tipo_lead_fail_closed_all_portals.sql",
);

const legacySql = readFileSync(LEGACY_MIGRATION, "utf8");
const sql = readFileSync(MIGRATION, "utf8");

/** Mirror TS della normalizzazione esplicita della sorgente. */
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

  it("la migrazione storica introduceva il fail-closed solo su Idealista", () => {
    const idealistaBranch = legacySql.slice(legacySql.indexOf("WITH src_id AS"));
    expect(idealistaBranch).not.toContain("'PRIVATO'::text");
  });

  it("la migrazione corrente elimina il default PRIVATO su TUTTI i portali", () => {
    expect(sql).not.toContain("'PRIVATO'::text");
    const otherBranch = sql.slice(sql.indexOf("WITH src AS"), sql.indexOf("WITH src_id AS"));
    expect(otherBranch).toContain("public.civiko_classify_tipo_lead(tipo_lead, n_agenzie, agency)");
  });

  it("l'update non declassa mai una classificazione affidabile", () => {
    expect(
      sql.match(
        /tipo_lead = public\.civiko_merge_tipo_lead\(public\.padova_listings\.tipo_lead, EXCLUDED\.tipo_lead\)/g,
      )?.length,
    ).toBe(2);
    expect(sql).not.toContain("tipo_lead = COALESCE(EXCLUDED.tipo_lead");
  });
});
