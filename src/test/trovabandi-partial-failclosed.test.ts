// TrovaBandi — P0 fail-closed su collect PARTIAL.
// Dominio isolato: nessun Civiko/shared/cron coinvolto.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  COLLECTION_PARTIAL_CODE,
  collectResponseContract,
} from "../../supabase/functions/trovabandi-engine/hardening";

const INDEX = readFileSync(
  "supabase/functions/trovabandi-engine/index.ts",
  "utf8",
);

describe("contratto risposta collect", () => {
  it("PARTIAL è fail-closed: non-2xx, ok:false, codice stabile", () => {
    const c = collectResponseContract("PARTIAL");
    expect(c.ok).toBe(false);
    expect(c.http).toBe(502);
    expect(c.http < 200 || c.http >= 300).toBe(true);
    expect(c.error_code).toBe("COLLECTION_PARTIAL");
    expect(COLLECTION_PARTIAL_CODE).toBe("COLLECTION_PARTIAL");
    expect(c.collection_succeeded).toBe(false);
  });

  it("SUCCEEDED resta 200 ok:true e segnala raccolta riuscita", () => {
    expect(collectResponseContract("SUCCEEDED")).toEqual({
      http: 200,
      ok: true,
      error_code: null,
      collection_succeeded: true,
    });
  });

  it("SKIPPED/NO_SOURCE_DUE è distinto da PARTIAL e non è raccolta riuscita", () => {
    const s = collectResponseContract("SKIPPED");
    expect(s.http).toBe(200);
    expect(s.ok).toBe(true);
    expect(s.error_code).toBe("NO_SOURCE_DUE");
    expect(s.collection_succeeded).toBe(false);
    expect(s.error_code).not.toBe(COLLECTION_PARTIAL_CODE);
  });

  it("il codice PARTIAL è stabile su chiamate ripetute", () => {
    const codes = new Set(
      Array.from({ length: 5 }, () => collectResponseContract("PARTIAL").error_code),
    );
    expect([...codes]).toEqual([COLLECTION_PARTIAL_CODE]);
  });
});

describe("integrazione nell'engine", () => {
  it("la risposta finale del collect usa il contratto, non un 200 hardcoded", () => {
    expect(INDEX).toContain("const contract = collectResponseContract(runStatus);");
    expect(INDEX).toContain("return response(contract.http, {");
    expect(INDEX).toContain("ok: contract.ok,");
    expect(INDEX).toContain("error_code: contract.error_code,");
  });

  it("PARTIAL non viene mai riscritto come FAILED nel DB", () => {
    expect(INDEX).toContain('const runStatus = operationalFailures > 0 ? "PARTIAL" : "SUCCEEDED";');
    // gli unici FAILED sono la riconciliazione dei run stale e il catch
    // delle eccezioni: nessuno appartiene al ramo PARTIAL.
    const failedOccurrences = INDEX.match(/status: "FAILED"/g) ?? [];
    expect(failedOccurrences.length).toBe(2);
    expect(INDEX).toContain('{ status: "FAILED", error_code: "STALE_RUN_TIMEOUT"');
    expect(INDEX).toContain('error_code: error instanceof Error ? error.name : "UNKNOWN"');
  });

  it("il run PARTIAL conserva contatori, provider_usage e diagnostica", () => {
    for (const fragment of [
      "status: runStatus,",
      "discovered_count: byUrl.size,",
      "processed_count: processed,",
      "verified_count: verified,",
      "provider_usage: {",
      "pages_scraped: pagesScraped,",
      "diagnostics: diagnosticCounters,",
      "warnings: [...new Set(warnings)],",
    ]) {
      expect(INDEX).toContain(fragment);
    }
  });

  it("la risposta PARTIAL espone diagnostica completa al chiamante", () => {
    for (const fragment of [
      "operational_failures: operationalFailures,",
      "collection_succeeded: contract.collection_succeeded,",
      "scraped: pagesScraped,",
    ]) {
      expect(INDEX).toContain(fragment);
    }
  });

  it("NO_SOURCE_DUE persiste un run SKIPPED e mai SUCCEEDED", () => {
    expect(INDEX).toContain('status: "SKIPPED",\n      error_code: "NO_SOURCE_DUE",');
    expect(INDEX).not.toContain('status: "SUCCEEDED",\n      error_code: "NO_SOURCE_DUE"');
    expect(INDEX).toContain("collection_succeeded: false,");
  });
});

describe("simulazione gateway/orchestratore", () => {
  const simulateGateway = (runStatus: "SUCCEEDED" | "PARTIAL" | "SKIPPED") => {
    const c = collectResponseContract(runStatus);
    const httpOk = c.http >= 200 && c.http < 300;
    // L'orchestratore marca il job riuscito solo con HTTP 2xx e ok:true.
    return { jobSucceeded: httpOk && c.ok, body: c };
  };

  it("PARTIAL fa fallire il job dell'orchestratore", () => {
    const r = simulateGateway("PARTIAL");
    expect(r.jobSucceeded).toBe(false);
    expect(r.body.error_code).toBe(COLLECTION_PARTIAL_CODE);
  });

  it("SUCCEEDED fa passare il job", () => {
    expect(simulateGateway("SUCCEEDED").jobSucceeded).toBe(true);
  });

  it("SKIPPED non fallisce ma non conta come raccolta per il release gate", () => {
    const r = simulateGateway("SKIPPED");
    expect(r.jobSucceeded).toBe(true);
    expect(r.body.collection_succeeded).toBe(false);
  });
});
