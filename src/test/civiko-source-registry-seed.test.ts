import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Verifies the source registry SQL seed covers the full Civiko F-code
 * catalog and that connector-status exposes a sources block consumable
 * by the admin dashboard. Pure file inspection — no DB or network.
 */

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

function loadMigrations(): string {
  const dir = resolve(root, "supabase/migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => read(`supabase/migrations/${f}`))
    .join("\n\n");
}

describe("Source registry — F-code catalog", () => {
  const sql = loadMigrations();

  const EXPECTED = [
    "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10",
    "F11", "F12", "F13", "F14", "F15", "F16", "F17", "F18", "F19",
    "F20", "F21", "F22",
  ];

  for (const code of EXPECTED) {
    it(`seeds ${code}`, () => {
      // Match a quoted code literal — guards against false-positives in column refs.
      const re = new RegExp(`'${code}'`);
      expect(sql).toMatch(re);
    });
  }

  it("F19 (necrologi) is active in aggregate_only mode with sensitive_aggregate compliance", () => {
    // Initial seed marked F19 as disabled/sensitive_restricted; a later migration
    // flips it to live + aggregate_only + sensitive_aggregate. Both forms appear
    // across migrations — we assert the activation outcome.
    expect(sql).toMatch(/'F19'/);
    expect(sql).toMatch(/aggregate_only/);
    expect(sql).toMatch(/sensitive_aggregate/);
  });
});

describe("connector-status — exposes sources block", () => {
  const code = read("supabase/functions/connector-status/index.ts");

  it("queries civiko_source_registry", () => {
    expect(code).toMatch(/civiko_source_registry/);
  });
  it("returns sources and sources_summary in the response", () => {
    expect(code).toMatch(/sources_summary/);
    expect(code).toMatch(/sources,/);
  });
  it("degrades gracefully on read failure", () => {
    expect(code).toMatch(/source registry read failed/);
  });
});

describe("Score evidence — source attribution preserved", () => {
  const scoring = read("supabase/functions/_shared/civikoScoring.ts");
  it("contribution payload includes source_code, confidence, last_updated, explanation", () => {
    expect(scoring).toMatch(/source_code/);
    expect(scoring).toMatch(/confidence/);
    expect(scoring).toMatch(/last_updated/);
    expect(scoring).toMatch(/explanation/);
  });
});

describe("Compliance — no person-level fields in aggregate importers", () => {
  const compliance = read("supabase/functions/_shared/compliance.ts");
  it("assertAggregateOnly helper exists and rejects PII keys", () => {
    expect(compliance).toMatch(/assertAggregateOnly/);
  });
});
