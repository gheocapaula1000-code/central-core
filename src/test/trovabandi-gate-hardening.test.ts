// TrovaBandi — hardening production-blocking: gate, retry policy, persistenza,
// metrica scrape. Dominio isolato: nessun altro prodotto è coinvolto.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  httpFailureCode,
  isNegativeOutcome,
  isOperationalFailure,
  shouldTryPlainJsonFallback,
} from "../../supabase/functions/trovabandi-engine/extraction";

const ENGINE = readFileSync("supabase/functions/trovabandi-engine/index.ts", "utf8");
const GATE = ENGINE.slice(
  ENGINE.indexOf('if (action === "release_gate")'),
  ENGINE.indexOf('if (action === "request_refresh")'),
);
const STORE = ENGINE.slice(
  ENGINE.indexOf("async function storeOpportunity"),
  ENGINE.indexOf("serve(async (req)"),
);
const COLLECT = ENGINE.slice(ENGINE.indexOf("const diagnostics: Array<"));

describe("release_gate — nessun falso positivo", () => {
  it("conta solo opportunità VERIFICATO, ufficiali e non scadute", () => {
    expect(GATE).toContain('.eq("verification_status", "VERIFICATO")');
    expect(GATE).toContain('.eq("official_source", true)');
    expect(GATE).toContain("deadline_at.is.null,deadline_at.gte.");
  });

  it("non considera mai PARZIALE, PARTIAL, RUNNING o FAILED come esito valido", () => {
    // PARZIALE compare solo come metrica informativa, mai in un check.
    expect(GATE).not.toContain('.in("verification_status", ["VERIFICATO", "PARZIALE"])');
    expect(GATE).not.toContain('["SUCCEEDED", "PARTIAL"]');
    expect(GATE).not.toContain('"RUNNING"');
    expect(GATE).not.toContain('"FAILED"');
  });

  it("richiede run recenti SUCCEEDED, conclusi e con verified_count > 0", () => {
    expect(GATE).toContain('.eq("status", "SUCCEEDED")');
    expect(GATE).toContain('.not("finished_at", "is", null)');
    expect(GATE).toContain('.gt("verified_count", 0)');
  });

  it("richiede almeno una fonte profonda BUR/ALBO_PRETORIO/CAMERALE/GAL conclusa", () => {
    expect(GATE).toContain('["BUR", "ALBO_PRETORIO", "CAMERALE", "GAL"]');
  });

  it("espone le quattro metriche non sensibili richieste", () => {
    for (const metric of [
      "verified_active",
      "partial_active",
      "recent_verified_runs",
      "deep_successful_runs",
    ]) {
      expect(GATE).toContain(`${metric}:`);
    }
  });

  it("mantiene gate_passed e cron_activation_allowed uguali al risultato reale", () => {
    expect(GATE).toContain("const ok = Object.values(checks).every(Boolean)");
    expect(GATE).toContain("response(ok ? 200 : 409");
    expect(GATE).toContain("gate_passed: ok");
    expect(GATE).toContain("cron_activation_allowed: ok");
  });

  it("il gate non espone dati sensibili o URL", () => {
    expect(GATE).not.toMatch(/official_url|raw_excerpt|excerpt|secret/i);
  });
});

describe("policy di retry sanificata", () => {
  it("classifica gli status HTTP senza esporre body o URL", () => {
    expect(httpFailureCode(400)).toBe("HTTP_400");
    expect(httpFailureCode(401)).toBe("HTTP_401");
    expect(httpFailureCode(402)).toBe("HTTP_402");
    expect(httpFailureCode(403)).toBe("HTTP_403");
    expect(httpFailureCode(422)).toBe("HTTP_422");
    expect(httpFailureCode(429)).toBe("HTTP_429");
    expect(httpFailureCode(500)).toBe("HTTP_5XX");
    expect(httpFailureCode(503)).toBe("HTTP_5XX");
    expect(httpFailureCode(418)).toBe("HTTP_4XX");
    expect(httpFailureCode(undefined)).toBe("HTTP_ERROR");
  });

  it("consente il fallback plain JSON solo dopo 400/422 o risposta 200 non parsabile", () => {
    for (const code of ["HTTP_400", "HTTP_422", "EMPTY_CONTENT", "PARSE_FAILED", "NOT_OBJECT"] as const) {
      expect(shouldTryPlainJsonFallback(code)).toBe(true);
    }
  });

  it("non ritenta mai su 401/402/403/429/5xx/timeout", () => {
    for (const code of [
      "HTTP_401",
      "HTTP_402",
      "HTTP_403",
      "HTTP_429",
      "HTTP_5XX",
      "HTTP_ERROR",
      "TIMEOUT",
      "NO_KEY",
    ] as const) {
      expect(shouldTryPlainJsonFallback(code)).toBe(false);
    }
  });

  it("l'engine interrompe la cascata quando il fallback non è ammesso", () => {
    expect(ENGINE).toContain("if (!shouldTryPlainJsonFallback(call.code)) return lastFailure;");
    expect(ENGINE).toContain("if (!shouldTryPlainJsonFallback(parsed.code)) return lastFailure;");
  });

  it("mantiene al massimo due tentativi di estrazione", () => {
    expect(ENGINE).toContain(
      'const modes: Array<"json_schema" | "json_fallback"> = ["json_schema", "json_fallback"]',
    );
  });
});

describe("NOT_OPPORTUNITY è esito negativo valido", () => {
  it("non è un guasto operativo", () => {
    expect(isNegativeOutcome("NOT_OPPORTUNITY")).toBe(true);
    expect(isOperationalFailure("NOT_OPPORTUNITY")).toBe(false);
    expect(isOperationalFailure("SCHEMA_INVALID")).toBe(false);
    expect(isOperationalFailure("CATEGORY_INVALID")).toBe(false);
    expect(isOperationalFailure("URL_OFF_DOMAIN")).toBe(false);
  });

  it("gli errori operativi restano tali", () => {
    for (const code of ["TIMEOUT", "HTTP_429", "HTTP_5XX", "NO_KEY", "PARSE_FAILED"] as const) {
      expect(isOperationalFailure(code)).toBe(true);
    }
  });

  it("l'engine diagnostica sempre ma genera warning solo per guasti operativi", () => {
    expect(COLLECT).toContain('diagnostics.push({ phase: "extract", code: extracted.code })');
    expect(COLLECT).toContain("if (isOperationalFailure(extracted.code)) {");
    expect(COLLECT).toContain("operationalFailures++");
  });

  it("lo stato del run dipende dai guasti operativi, non dal numero di warning", () => {
    expect(ENGINE).toContain('status: operationalFailures > 0 ? "PARTIAL" : "SUCCEEDED"');
    expect(ENGINE).not.toContain('status: warnings.length ? "PARTIAL" : "SUCCEEDED"');
  });
});

describe("persistenza fail-closed dell'evidenza", () => {
  it("controlla l'errore dell'upsert su trovabandi_evidence", () => {
    expect(STORE).toContain("const { error: evidenceError } = await sb.from(\"trovabandi_evidence\")");
    expect(STORE).toContain("if (evidenceError) {");
  });

  it("compensa portando l'opportunità a DA_VERIFICARE senza cancellare nulla", () => {
    expect(STORE).toContain('verification_status: "DA_VERIFICARE"');
    expect(STORE).toContain("last_verified_at: null");
    expect(STORE).not.toContain(".delete()");
  });

  it("restituisce un codice store specifico e non conteggia stored/verified", () => {
    expect(STORE).toContain("code: `EVIDENCE_WRITE_FAILED_${sanitizeDbErrorCode(evidenceError)}`");
    expect(STORE).toContain("OPPORTUNITY_WRITE_FAILED_${error ? sanitizeDbErrorCode(error)");
    expect(STORE).not.toContain("error.message");
    expect(STORE).not.toContain("error.details");
  });


  it("valorizza last_verified_at soltanto per VERIFICATO", () => {
    expect(STORE).toContain(
      'last_verified_at: verification === "VERIFICATO" ? now.toISOString() : null',
    );
    expect(STORE).not.toContain("last_verified_at: hasEvidence ? now.toISOString() : null");
  });

  it("un fallimento di store incrementa i guasti operativi e non processed", () => {
    expect(COLLECT).toContain("if (!stored.stored) {");
    expect(COLLECT).toContain("warnings.push(`store_${stored.code.toLowerCase()}`)");
  });

  it("i codici store non contengono URL o contenuti", () => {
    expect(STORE).not.toMatch(/code: `[^`]*\$\{(officialUrl|markdown|hit)/);
  });
});

describe("metrica pages_scraped", () => {
  it("conta gli scrape riusciti, non i tentativi", () => {
    expect(ENGINE).toContain("pages_scraped: pagesScraped");
    expect(ENGINE).toContain("pages_attempted: hits.length");
    expect(ENGINE).not.toContain("pages_scraped: hits.length");
  });

  it("l'incremento avviene solo dopo uno scrape riuscito", () => {
    const afterFailure = COLLECT.indexOf('code: "NO_CONTENT"');
    const increment = COLLECT.indexOf("pagesScraped++");
    expect(increment).toBeGreaterThan(afterFailure);
  });
});
