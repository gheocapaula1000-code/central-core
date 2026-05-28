import { describe, it, expect } from "vitest";
import {
  assertAggregateOnly,
  redactSensitiveForPwa,
  ComplianceError,
} from "../../supabase/functions/_shared/compliance.ts";
import {
  parseCsv,
  toIntOrNull,
  toNumberOrNull,
} from "../../supabase/functions/_shared/csvImport.ts";
import {
  buildScoreContributions,
  SOURCE_WEIGHTS,
} from "../../supabase/functions/_shared/civikoScoring.ts";

describe("compliance.assertAggregateOnly", () => {
  it("accetta record aggregati", () => {
    expect(() =>
      assertAggregateOnly({ year: 2024, comune: "Padova", separations_count: 100 }, "F22"),
    ).not.toThrow();
  });

  it("rigetta nome persona", () => {
    expect(() =>
      assertAggregateOnly({ year: 2024, full_name: "Mario Rossi" }, "F22"),
    ).toThrow(ComplianceError);
  });

  it("rigetta codice fiscale e proprietario", () => {
    for (const field of ["codice_fiscale", "owner_name", "proprietario", "heir_name"]) {
      expect(() => assertAggregateOnly({ [field]: "x" }, "F4")).toThrow(ComplianceError);
    }
  });
});

describe("compliance.redactSensitiveForPwa", () => {
  it("rimuove campi person-level dal payload", () => {
    const out = redactSensitiveForPwa({
      title: "Opportunità A",
      owner_name: "Tizio Caio",
      heir_name: "Erede X",
      area: { name: "Arcella", owner_name: "nested" },
    }) as Record<string, unknown>;
    expect(out.title).toBe("Opportunità A");
    expect(out.owner_name).toBeUndefined();
    expect(out.heir_name).toBeUndefined();
    expect((out.area as Record<string, unknown>).owner_name).toBeUndefined();
    expect((out.area as Record<string, unknown>).name).toBe("Arcella");
  });

  it("redacta blocchi sensitive_restricted", () => {
    const out = redactSensitiveForPwa({
      block: { compliance_level: "sensitive_restricted", data: "secret" },
      safe: { compliance_level: "public", data: "ok" },
    }) as Record<string, unknown>;
    expect((out.block as Record<string, unknown>).redacted).toBe(true);
    expect((out.safe as Record<string, unknown>).data).toBe("ok");
  });
});

describe("csvImport", () => {
  it("parsifica CSV con header e separatore virgola", () => {
    const rows = parseCsv("year,area_name\n2024,Arcella\n2024,Stanga\n");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ year: "2024", area_name: "Arcella" });
  });

  it("supporta separatore punto e virgola e quoting", () => {
    const rows = parseCsv('year;area_name\n2024;"Centro, storico"\n');
    expect(rows[0].area_name).toBe("Centro, storico");
  });

  it("toIntOrNull e toNumberOrNull gestiscono format IT", () => {
    expect(toIntOrNull("1.234")).toBe(1234);
    expect(toNumberOrNull("1.234,56")).toBeCloseTo(1234.56);
    expect(toIntOrNull("")).toBeNull();
    expect(toNumberOrNull(undefined)).toBeNull();
  });
});

describe("civikoScoring.buildScoreContributions", () => {
  const iso = new Date().toISOString();

  it("ogni contributo ha source_code, confidence e explanation", () => {
    const r = buildScoreContributions({
      elderly: { over_75_rate: 0.18, year: 2024, imported_at: iso },
      mobility: { saldo_migratorio: -50, iscritti: 1200, cancellati: 1250, year: 2024, imported_at: iso },
      marketBenchmark: { avg_price_eur_mq: 2100, omi_avg_price_eur_mq: 2000, imported_at: iso },
      suePermits: { recent_count: 12, window_days: 180, imported_at: iso },
      separations: { separation_rate: 0.005, year: 2024, imported_at: iso },
    });
    expect(r.contributions).toHaveLength(5);
    for (const c of r.contributions) {
      expect(c.source_code).toMatch(/^F\d+$/);
      expect(["low", "medium", "high"]).toContain(c.confidence);
      expect(c.explanation.length).toBeGreaterThan(5);
      expect(c.last_updated).toBeTruthy();
    }
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.missing_sources).toHaveLength(0);
  });

  it("traccia fonti mancanti senza inventare valori", () => {
    const r = buildScoreContributions({
      elderly: { over_75_rate: 0.10, year: 2024, imported_at: iso },
    });
    expect(r.contributions).toHaveLength(1);
    expect(r.missing_sources).toEqual(expect.arrayContaining(["F3", "F12", "F18", "F22"]));
  });

  it("i pesi sommano a 0.75 nella tabella ufficiale", () => {
    const total = Object.values(SOURCE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(0.75, 2);
  });
});
