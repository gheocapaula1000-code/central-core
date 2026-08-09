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
import {
  COLLECTION_PARTIAL_ERROR_CODE,
  COVERAGE_WINDOW_HOURS,
  REFRESH_PREFERENCE_MAX_BYPASS_MINUTES,
  boundedMaxPages,
  collectionCompletionOutcome,
  sourceScrapeOperationalFailures,
  evaluateReleaseGate,
  isRealSuccessfulScan,
  nonNegativeSafeInteger,
  rankDueSources,
  type DueSource,
  type SuccessfulRun,
} from "../../supabase/functions/trovabandi-engine/hardening";

const ENGINE = readFileSync("supabase/functions/trovabandi-engine/index.ts", "utf8");
const RUNTIME_MIGRATION = readFileSync(
  "supabase/migrations/20260806201632_52f5ff47-98e2-42bf-b088-424b41f6fc85.sql",
  "utf8",
);
const GATE = ENGINE.slice(
  ENGINE.indexOf('if (action === "release_gate")'),
  ENGINE.indexOf('if (action === "request_refresh")'),
);
const STATUS = ENGINE.slice(
  ENGINE.indexOf('if (action === "status")'),
  ENGINE.indexOf('if (action === "maintenance")'),
);
const MAINTENANCE = ENGINE.slice(
  ENGINE.indexOf('if (action === "maintenance")'),
  ENGINE.indexOf('if (action === "release_gate")'),
);
const STORE = ENGINE.slice(
  ENGINE.indexOf("async function storeOpportunity"),
  ENGINE.indexOf("serve(async (req)"),
);
const COLLECT = ENGINE.slice(ENGINE.indexOf("const diagnostics: Array<"));
const SOURCE_SELECTION = ENGINE.slice(
  ENGINE.indexOf("const sourceId = normalizeText(body.source_id)"),
  ENGINE.indexOf("const warnings: string[] = []"),
);

const SOURCE_KINDS = [
  "CATALOGO",
  "BUR",
  "ALBO_PRETORIO",
  "CAMERALE",
  "GAL",
  "FONDAZIONE",
  "DECRETO",
  "EU_PORTAL",
];
const COVERAGE_SINCE = "2026-08-05T10:00:00.000Z";
const LAST_SCAN = "2026-08-06T08:00:00.000Z";

function source(index: number): DueSource {
  return {
    id: `source-${String(index).padStart(2, "0")}`,
    source_kind: SOURCE_KINDS[index % SOURCE_KINDS.length],
    priority: 100 - (index % 20),
    region: null,
    last_scanned_at: LAST_SCAN,
    next_scan_at: "2026-08-06T09:00:00.000Z",
  };
}

function realRun(sourceId: string, pagesAttempted = 0): SuccessfulRun {
  return {
    source_id: sourceId,
    provider_usage: {
      firecrawl_search_status: "OK",
      perplexity_search_status: "OK",
      pages_attempted: pagesAttempted,
      pages_scraped: pagesAttempted,
    },
  };
}

function validGateInput() {
  const enabledSources = Array.from({ length: 53 }, (_, index) => source(index));
  return {
    enabledSources,
    recentSuccessfulRuns: enabledSources.map((item) => realRun(item.id, 0)),
    staleRunningCount: 0,
    verifiedActiveCount: SOURCE_KINDS.length,
    partialActiveCount: 12,
    coverageSinceIso: COVERAGE_SINCE,
  };
}

describe("release_gate — copertura reale e nessun falso positivo", () => {
  it("accetta 53 fonti coperte e zero novità quando la scansione provider è reale", () => {
    const gate = evaluateReleaseGate(validGateInput());
    expect(COVERAGE_WINDOW_HOURS).toBe(26);
    expect(gate.ok).toBe(true);
    expect(gate.metrics.enabled_sources).toBe(53);
    expect(gate.metrics.recently_covered_sources).toBe(53);
    expect(gate.metrics.catalogue_required_dynamic).toBe(SOURCE_KINDS.length);
  });

  it("zero risultati non significa scansione finta", () => {
    expect(isRealSuccessfulScan(realRun("source-1", 0))).toBe(true);
    expect(
      isRealSuccessfulScan({
        source_id: "source-1",
        provider_usage: {
          firecrawl_search_status: "OK",
          perplexity_search_status: "HTTP_429",
          pages_attempted: 0,
          pages_scraped: 0,
        },
      }),
    ).toBe(false);
    expect(
      isRealSuccessfulScan({
        source_id: "source-1",
        provider_usage: {
          firecrawl_search_status: "OK",
          perplexity_search_status: "OK",
          pages_attempted: null,
          pages_scraped: null,
        },
      }),
    ).toBe(false);
  });

  it("fallisce se manca anche una sola fonte nelle 26 ore", () => {
    const input = validGateInput();
    input.recentSuccessfulRuns.pop();
    const gate = evaluateReleaseGate(input);
    expect(gate.ok).toBe(false);
    expect(gate.checks.recent_source_coverage_26h).toBe(false);
  });

  it("richiede un successo recente per ogni source_kind abilitato", () => {
    const input = validGateInput();
    const missingKind = "GAL";
    const idsOfMissingKind = new Set(
      input.enabledSources
        .filter((item) => item.source_kind === missingKind)
        .map((item) => item.id),
    );
    input.recentSuccessfulRuns = input.recentSuccessfulRuns.filter(
      (run) => !run.source_id || !idsOfMissingKind.has(run.source_id),
    );
    const gate = evaluateReleaseGate(input);
    expect(gate.checks.all_enabled_source_kinds_succeeded).toBe(false);
    expect(gate.ok).toBe(false);
  });

  it("fallisce con registry stantio anche se esiste un run formalmente riuscito", () => {
    const input = validGateInput();
    input.enabledSources[10] = {
      ...input.enabledSources[10],
      last_scanned_at: "2026-08-04T08:00:00.000Z",
    };
    const gate = evaluateReleaseGate(input);
    expect(gate.checks.source_registry_fresh_26h).toBe(false);
    expect(gate.ok).toBe(false);
  });

  it("fallisce con un RUNNING stale", () => {
    const input = validGateInput();
    input.staleRunningCount = 1;
    const gate = evaluateReleaseGate(input);
    expect(gate.checks.no_stale_running).toBe(false);
    expect(gate.ok).toBe(false);
  });

  it("usa una soglia catalogo dinamica, non un numero commerciale inventato", () => {
    const input = validGateInput();
    input.verifiedActiveCount = SOURCE_KINDS.length - 1;
    const gate = evaluateReleaseGate(input);
    expect(gate.metrics.catalogue_required_dynamic).toBe(SOURCE_KINDS.length);
    expect(gate.checks.verified_official_catalogue_populated).toBe(false);
  });

  it("usa l'RPC distinct e rifiuta conteggi non validi", () => {
    expect(GATE).toContain('rpc("trovabandi_verified_active_distinct_count"');
    expect(GATE).toContain("nonNegativeSafeInteger(verifiedResult.data)");
    expect(GATE).toContain('code: "RELEASE_GATE_COUNT_INVALID"');
    expect(nonNegativeSafeInteger(8)).toBe(8);
    expect(nonNegativeSafeInteger("8")).toBe(8);
    expect(nonNegativeSafeInteger(-1)).toBeNull();
    expect(nonNegativeSafeInteger("1.5")).toBeNull();
  });

  it("evidenze multiple della stessa opportunità non gonfiano verifiedActive", () => {
    expect(RUNTIME_MIGRATION).toContain("RETURNS bigint");
    expect(RUNTIME_MIGRATION).toMatch(/count\s*\(\s*DISTINCT\s+opportunity\.id\s*\)/i);
    expect(RUNTIME_MIGRATION).toMatch(
      /EXISTS\s*\([\s\S]*evidence\.opportunity_id\s*=\s*opportunity\.id/i,
    );
    expect(RUNTIME_MIGRATION).toContain("opportunity.verification_status = 'VERIFICATO'");
    expect(RUNTIME_MIGRATION).toContain("opportunity.official_source = true");
    expect(RUNTIME_MIGRATION).toContain("opportunity.last_verified_at IS NOT NULL");
    expect(RUNTIME_MIGRATION).toContain("opportunity.deadline_at >= p_now");
    expect(RUNTIME_MIGRATION).toMatch(/SET\s+search_path\s*=\s*public\s*,\s*pg_temp/i);
    expect(RUNTIME_MIGRATION).not.toMatch(/DROP\s+FUNCTION/i);
    expect(RUNTIME_MIGRATION).toContain("rolname LIKE 'sandbox_exec_%'");
  });

  it("qualsiasi errore di query produce 503 fail-closed", () => {
    expect(GATE).toContain('code: "RELEASE_GATE_QUERY_FAILED"');
    expect(GATE).toContain("gate_passed: false");
    expect(GATE).toContain("cron_activation_allowed: false");
  });

  it("mantiene gate_passed e cron_activation_allowed uguali al risultato reale", () => {
    expect(GATE).toContain("response(gate.ok ? 200 : 409");
    expect(GATE).toContain("gate_passed: gate.ok");
    expect(GATE).toContain("cron_activation_allowed: gate.ok");
  });

  it("il gate non espone dati sensibili o URL", () => {
    expect(GATE).not.toMatch(/official_url|raw_excerpt|excerpt|secret/i);
  });
});

describe("rotazione fonti — oldest/most-overdue", () => {
  it("la fonte più scaduta precede fast lane e priorità", () => {
    const ranked = rankDueSources([
      {
        ...source(1),
        id: "high-priority-newer",
        priority: 100,
        next_scan_at: "2026-08-06T09:00:00.000Z",
      },
      {
        ...source(2),
        id: "oldest-due",
        priority: 1,
        next_scan_at: "2026-08-06T06:00:00.000Z",
      },
    ]);
    expect(ranked.map((item) => item.id)).toEqual(["oldest-due", "high-priority-newer"]);
  });

  it("a parità di scadenza, una fonte mai scansionata passa prima", () => {
    const ranked = rankDueSources([
      { ...source(1), id: "already-seen", last_scanned_at: LAST_SCAN },
      { ...source(2), id: "never-seen", last_scanned_at: null },
    ]);
    expect(ranked[0].id).toBe("never-seen");
  });

  it("un refresh regionale preferisce una fonte compatibile entro la finestra fair", () => {
    const ranked = rankDueSources(
      [
        {
          ...source(1),
          id: "other-region",
          region: "Lombardia",
          next_scan_at: "2026-08-06T08:00:00.000Z",
        },
        {
          ...source(2),
          id: "preferred-region",
          region: "Veneto",
          next_scan_at: "2026-08-06T08:20:00.000Z",
        },
      ],
      "venèto",
    );
    expect(REFRESH_PREFERENCE_MAX_BYPASS_MINUTES).toBe(30);
    expect(ranked[0].id).toBe("preferred-region");
  });

  it("il refresh regionale non scavalca una fonte incompatibile troppo arretrata", () => {
    const ranked = rankDueSources(
      [
        {
          ...source(1),
          id: "starvation-guard",
          region: "Lombardia",
          next_scan_at: "2026-08-06T07:00:00.000Z",
        },
        {
          ...source(2),
          id: "preferred-but-newer",
          region: "Veneto",
          next_scan_at: "2026-08-06T08:00:00.000Z",
        },
      ],
      "Veneto",
    );
    expect(ranked[0].id).toBe("starvation-guard");
  });

  it("dopo l'unico sorpasso regionale la fonte precedente torna prima", () => {
    const sources = [
      {
        ...source(1),
        id: "fallback-next",
        region: "Lombardia",
        next_scan_at: "2026-08-06T08:00:00.000Z",
      },
      {
        ...source(2),
        id: "preferred-once",
        region: "Veneto",
        next_scan_at: "2026-08-06T08:20:00.000Z",
      },
    ];
    const first = rankDueSources(sources, "Veneto");
    expect(first[0].id).toBe("preferred-once");
    const second = rankDueSources(first.slice(1), "Veneto");
    expect(second[0].id).toBe("fallback-next");
  });
});

describe("maintenance, status e SKIPPED — stato persistito corretto", () => {
  it("maintenance riconcilia soltanto RUNNING stale come FAILED", () => {
    expect(MAINTENANCE).toContain('status: "FAILED"');
    expect(MAINTENANCE).toContain('error_code: "STALE_RUN_TIMEOUT"');
    expect(MAINTENANCE).toContain('.eq("status", "RUNNING")');
    expect(MAINTENANCE).toContain('.lt("started_at", staleBefore)');
    expect(MAINTENANCE).toContain("RUN_STALE_AFTER_MINUTES");
  });

  it("maintenance non trasforma mai un RITIRATO in SCADUTO", () => {
    expect(MAINTENANCE).toContain(
      '.in("verification_status", ["VERIFICATO", "PARZIALE", "DA_VERIFICARE"])',
    );
    expect(MAINTENANCE).not.toContain('.neq("verification_status", "SCADUTO")');
  });

  it("status esclude bandi già scaduti e fallisce chiuso su errore DB", () => {
    expect(STATUS).toContain("deadline_at.is.null,deadline_at.gte.");
    expect(STATUS).toContain('code: "STATUS_QUERY_FAILED"');
  });

  it("NO_SOURCE_DUE crea un run SKIPPED concluso e senza telemetria provider finta", () => {
    expect(SOURCE_SELECTION).toContain('status: "SKIPPED"');
    expect(SOURCE_SELECTION).toContain('error_code: "NO_SOURCE_DUE"');
    expect(SOURCE_SELECTION).toContain("provider_usage: {}");
    expect(SOURCE_SELECTION).toContain("started_at: selectionNow");
    expect(SOURCE_SELECTION).toContain("finished_at: finishedAt");
    expect(SOURCE_SELECTION).toContain('status: "SKIPPED",\n        run_id:');
  });

  it("un errore di persistenza dello SKIPPED non restituisce un falso 200", () => {
    expect(SOURCE_SELECTION).toContain('code: "SKIPPED_RUN_WRITE_FAILED"');
  });

  it("preserva il cap di spesa max_pages 1..5", () => {
    expect(boundedMaxPages(0)).toBe(1);
    expect(boundedMaxPages(1)).toBe(1);
    expect(boundedMaxPages(5)).toBe(5);
    expect(boundedMaxPages(6)).toBe(5);
    expect(boundedMaxPages("4")).toBe(4);
    expect(boundedMaxPages(2.5)).toBe(2);
    expect(boundedMaxPages("invalid")).toBe(2);
    expect(SOURCE_SELECTION).toContain("boundedMaxPages(body.max_pages ?? 2)");
  });

  it("usa ordine fair e lease atomica, non fast_lane-first", () => {
    expect(SOURCE_SELECTION).toContain('.order("next_scan_at", { ascending: true })');
    expect(SOURCE_SELECTION).toContain(
      '.order("last_scanned_at", { ascending: true, nullsFirst: true })',
    );
    expect(SOURCE_SELECTION).not.toContain('.order("fast_lane"');
    expect(SOURCE_SELECTION).toContain('.eq("next_scan_at", candidate.next_scan_at)');
    expect(SOURCE_SELECTION).toContain("RUN_STALE_AFTER_MINUTES * 60_000");
  });

  it("il dry-run non prende lease, non chiama provider e non scrive run", () => {
    const dryRunStart = SOURCE_SELECTION.indexOf("if (dryRun) {");
    const dryRunEnd = SOURCE_SELECTION.indexOf("const leaseUntil");
    const automaticDryRunBranch = SOURCE_SELECTION.slice(dryRunStart, dryRunEnd);
    expect(automaticDryRunBranch).toContain("const candidate = rankedCandidates[0] ?? null");
    expect(automaticDryRunBranch).toContain("return response(");
    expect(automaticDryRunBranch).toContain("would_collect");
    expect(automaticDryRunBranch).not.toContain(".update(");
    expect(automaticDryRunBranch).not.toContain(".insert(");
    expect(automaticDryRunBranch).not.toContain('.from("trovabandi_runs")');
    expect(automaticDryRunBranch).not.toContain("last_scanned_at:");
    expect(automaticDryRunBranch).not.toContain("processed_at:");
    expect(automaticDryRunBranch).not.toContain("firecrawlSearch(");
    expect(automaticDryRunBranch).not.toContain("perplexitySearch(");

    const explicitBranch = SOURCE_SELECTION.slice(
      SOURCE_SELECTION.indexOf("if (sourceId)"),
      SOURCE_SELECTION.indexOf("} else {"),
    );
    expect(explicitBranch).toContain("if (dryRun)");
    expect(explicitBranch).toContain("return response(200");
    expect(explicitBranch).not.toContain(".update(");
    expect(explicitBranch).not.toContain(".insert(");
    expect(explicitBranch).not.toContain('.from("trovabandi_runs")');
    expect(explicitBranch).not.toContain("last_scanned_at:");
    expect(explicitBranch).not.toContain("processed_at:");
    expect(explicitBranch).not.toContain("firecrawlSearch(");
    expect(explicitBranch).not.toContain("perplexitySearch(");
  });
});

describe("isolamento TrovaBandi", () => {
  it("la migration tocca soltanto oggetti public.trovabandi_*", () => {
    const publicObjects = [...RUNTIME_MIGRATION.matchAll(/public\.([a-z0-9_]+)/gi)].map(
      (match) => match[1],
    );
    expect(publicObjects.length).toBeGreaterThan(0);
    expect(publicObjects.every((name) => name.startsWith("trovabandi_"))).toBe(true);
  });

  it("non crea, modifica o attiva cron", () => {
    expect(RUNTIME_MIGRATION).not.toMatch(/cron\.schedule|cron\.unschedule|pg_cron/i);
  });

  it("mantiene il deploy selettivo e vieta il deploy globale", () => {
    const manifest = JSON.parse(
      readFileSync("supabase/trovabandi-deploy-manifest.json", "utf8"),
    ) as {
      product: string;
      deploy_mode: string;
      global_deploy_forbidden: boolean;
      migrations: string[];
    };
    expect(manifest).toMatchObject({
      product: "trovabandi",
      deploy_mode: "selective_only",
      global_deploy_forbidden: true,
    });
    expect(manifest.migrations).toContain(
      "20260806201632_52f5ff47-98e2-42bf-b088-424b41f6fc85.sql",
    );
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
    for (const code of [
      "HTTP_400",
      "HTTP_422",
      "EMPTY_CONTENT",
      "PARSE_FAILED",
      "NOT_OBJECT",
    ] as const) {
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
    expect(ENGINE.replace(/\s+/g, " ")).toMatch(
      /const modes: Array<"json_schema" \| "json_fallback"> = \[ ?"json_schema", ?"json_fallback",? ?\]/,
    );
  });
});

describe("NOT_OPPORTUNITY è l'unico esito negativo valido", () => {
  it("solo NOT_OPPORTUNITY non è un guasto operativo", () => {
    expect(isNegativeOutcome("NOT_OPPORTUNITY")).toBe(true);
    expect(isOperationalFailure("NOT_OPPORTUNITY")).toBe(false);
    for (const code of ["SCHEMA_INVALID", "CATEGORY_INVALID", "URL_OFF_DOMAIN"] as const) {
      expect(isNegativeOutcome(code)).toBe(false);
      expect(isOperationalFailure(code)).toBe(true);
    }
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
    expect(ENGINE).toContain("collectionCompletionOutcome(operationalFailures)");
    expect(ENGINE).not.toContain('status: warnings.length ? "PARTIAL" : "SUCCEEDED"');
  });
});

describe("PARTIAL — persistenza diagnostica e risposta scheduler fail-closed", () => {
  it("Padovanet/VDA mixed success conserva il warning ma non forza PARTIAL", () => {
    expect(sourceScrapeOperationalFailures(1, 1)).toBe(0);
    expect(sourceScrapeOperationalFailures(3, 1)).toBe(0);
  });

  it("tutti i candidati NO_CONTENT restano un guasto operativo fail-closed", () => {
    expect(sourceScrapeOperationalFailures(2, 0)).toBe(2);
    expect(sourceScrapeOperationalFailures(0, 0)).toBe(0);
  });

  it("mappa dinamicamente PARTIAL su HTTP 502/ok:false e conserva SUCCEEDED su 200", () => {
    expect(collectionCompletionOutcome(1)).toEqual({
      runStatus: "PARTIAL",
      httpStatus: 502,
      ok: false,
      errorCode: COLLECTION_PARTIAL_ERROR_CODE,
    });
    expect(collectionCompletionOutcome(0)).toEqual({
      runStatus: "SUCCEEDED",
      httpStatus: 200,
      ok: true,
      errorCode: null,
    });
    expect(COLLECTION_PARTIAL_ERROR_CODE).not.toBe("NO_SOURCE_DUE");
  });

  it("usa lo stesso outcome per DB e HTTP senza perdere contatori o diagnostica", () => {
    expect(COLLECT).toContain(
      "const completion = collectionCompletionOutcome(operationalFailures)",
    );
    expect(COLLECT).toContain("status: completion.runStatus");
    expect(COLLECT).toContain("error_code: completion.errorCode");
    expect(COLLECT).toContain("provider_usage: {");
    expect(COLLECT).toContain("diagnostics: diagnosticCounters");
    expect(COLLECT).toContain("discovered_count: byUrl.size");
    expect(COLLECT).toContain("processed_count: processed");
    expect(COLLECT).toContain("verified_count: verified");
    expect(COLLECT).toContain("return response(completion.httpStatus");
    expect(COLLECT).toContain("ok: completion.ok");
    expect(COLLECT).toContain("error_code: completion.errorCode");
    expect(COLLECT).toContain("run_id: run.id");
    expect(COLLECT).toContain("source_id: source.id");
    expect(COLLECT).toContain("status: completion.runStatus");
  });
});

describe("persistenza fail-closed dell'evidenza", () => {
  it("l'engine delega la sequenza al modulo fail-closed", () => {
    expect(STORE).toContain("persistOpportunityFailClosed(");
    expect(STORE).not.toContain(".delete()");
  });

  it("non scrive mai stati verificati direttamente nella riga iniziale", () => {
    expect(STORE).not.toContain("verification_status: verification,");
    expect(STORE).not.toContain(
      'last_verified_at: verification === "VERIFICATO" ? now.toISOString() : null',
    );
  });

  it("rifiuta fail-closed una categoria non ammessa", () => {
    expect(STORE).toContain('code: "CATEGORY_INVALID"');
    expect(STORE).not.toContain('normalizeCategoryCode(extracted.category) ?? "ALTRO"');
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
