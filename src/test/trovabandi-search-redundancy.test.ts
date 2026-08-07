// UEradar — ridondanza dei provider di ricerca (fail-closed conservativo).
// La funzione vive in supabase/functions/trovabandi-engine/index.ts (runtime
// Deno): la isoliamo dalla sorgente reale per testarne il comportamento.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ENGINE = readFileSync("supabase/functions/trovabandi-engine/index.ts", "utf8");

const start = ENGINE.indexOf("function searchRedundancyOutcome");
const end = ENGINE.indexOf("\nfunction stringArray");
expect(start).toBeGreaterThan(-1);
expect(end).toBeGreaterThan(start);

const source = ENGINE.slice(start, end).replace(
  /entries: SearchRedundancyEntry\[\],/,
  "entries,",
);

const searchRedundancyOutcome = new Function(
  `${source}; return searchRedundancyOutcome;`,
)() as (
  entries: Array<{ phase: string; code: string; operational: boolean; hits: number }>,
) => Array<{ phase: string; code: string; operational: boolean; degraded: boolean }>;

function fc(code: string, hits: number) {
  return { phase: "search_firecrawl", code, operational: code !== "OK" && code !== "OK_EMPTY", hits };
}
function pp(code: string, hits: number) {
  return { phase: "search_perplexity", code, operational: code !== "OK" && code !== "OK_EMPTY", hits };
}

const operationalCount = (
  out: Array<{ operational: boolean }>,
) => out.filter((entry) => entry.operational).length;

describe("ridondanza search provider", () => {
  it("Firecrawl TIMEOUT con Perplexity OK e 8 hit non è operativo", () => {
    const out = searchRedundancyOutcome([fc("TIMEOUT", 0), pp("OK", 8)]);
    expect(operationalCount(out)).toBe(0);
    expect(out[0]).toEqual({
      phase: "search_firecrawl",
      code: "TIMEOUT",
      operational: false,
      degraded: true,
    });
  });

  it("Perplexity TIMEOUT con Firecrawl OK e hit non è operativo", () => {
    const out = searchRedundancyOutcome([fc("OK", 3), pp("TIMEOUT", 0)]);
    expect(operationalCount(out)).toBe(0);
    expect(out[1].degraded).toBe(true);
  });

  it("un provider in timeout e l'altro OK ma vuoto resta operativo", () => {
    const out = searchRedundancyOutcome([fc("TIMEOUT", 0), pp("OK_EMPTY", 0)]);
    expect(operationalCount(out)).toBe(1);
    expect(out[0].operational).toBe(true);
  });

  it("entrambi in timeout restano operativi", () => {
    const out = searchRedundancyOutcome([fc("TIMEOUT", 0), pp("TIMEOUT", 0)]);
    expect(operationalCount(out)).toBe(2);
  });

  it("nessun guasto: nessuna degradazione e nessun falso PARTIAL", () => {
    const out = searchRedundancyOutcome([fc("OK", 2), pp("OK_EMPTY", 0)]);
    expect(operationalCount(out)).toBe(0);
    expect(out.every((entry) => entry.degraded === false)).toBe(true);
  });

  it("guasti non-search restano fuori scope: la diagnostica è preservata", () => {
    const out = searchRedundancyOutcome([fc("HTTP_429", 0), pp("OK", 1)]);
    expect(out.map((entry) => entry.code)).toEqual(["HTTP_429", "OK"]);
  });
});
