import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SQL = readFileSync(
  "supabase/migrations/20260805203200_2869f720-4f28-4227-b775-e735d6dcb1f0.sql",
  "utf8",
);

describe("Civiko contendibili — publication cardinality", () => {
  it("rende univoche entrambe le sorgenti prima degli upsert", () => {
    expect(SQL).toContain("cardinality-safe-v1");
    expect(SQL).toContain("CREATE UNIQUE INDEX _cert_publish_chiave_match_uq");
    expect(SQL).toContain("CREATE UNIQUE INDEX _mp_publish_chiave_match_uq");
    expect(SQL).toContain("FROM _mp_publish f");
  });

  it("preserva gruppi distinti disambiguando solo le chiavi in collisione", () => {
    expect(SQL).toContain("WHERE c.chiave_match IN");
    expect(SQL).toContain("WHERE m.chiave_match IN");
    expect(SQL).toContain("md5(jsonb_build_array(");
    expect(SQL).toContain("'|K:'");
  });

  it("deduplica solo payload identici e resta fail-closed sui divergenti", () => {
    expect(SQL).toContain("count(DISTINCT to_jsonb(c)) > 1");
    expect(SQL).toContain("count(DISTINCT (to_jsonb(m) - 'source_rank')) > 1");
    expect(SQL).toContain("ERRCODE = '21000'");
    expect(SQL).toContain("duplicate divergent contendibili publish key");
    expect(SQL).toContain("duplicate divergent multi_portale publish key");
  });

  it("non indebolisce QA e non compie operazioni distruttive sui dataset", () => {
    expect(SQL).not.toMatch(/TRUNCATE/i);
    expect(SQL).not.toMatch(/DROP\s+TABLE\s+public\./i);
    expect(SQL).not.toMatch(/DELETE\s+FROM\s+public\.padova_listings/i);
    expect(SQL).not.toMatch(/DELETE\s+FROM\s+public\.padova_contendibili\s*;/i);
  });

  it("fallisce se la funzione live non corrisponde agli anchor attesi", () => {
    expect(SQL).toContain("anchor pubblicazione non trovato");
    expect(SQL).toContain("anchor sorgente multi_portale non trovato");
    expect(SQL).toContain("anchor delete multi_portale non trovato");
    expect(SQL).toContain("patch cardinality-safe non applicata");
  });
});
