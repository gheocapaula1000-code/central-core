// TrovaBandi — hardening production-blocking: gate dinamico, selettore equo,
// riconciliazione run stale, dry-run read-only, retry policy, persistenza,
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
  COVERAGE_WINDOW_HOURS,
  REGIONAL_BYPASS_MAX_MINUTES,
  RUN_STALE_AFTER_MINUTES,
  evaluateGate,
  isRealScan,
  rankSources,
  selectDueSource,
  type RankableSource,
  type RunLike,
} from "../../supabase/functions/trovabandi-engine/hardening";

const ENGINE = readFileSync("supabase/functions/trovabandi-engine/index.ts", "utf8");
const HARDENING = readFileSync("supabase/functions/trovabandi-engine/hardening.ts", "utf8");
const MIGRATION = readFileSync(
  "supabase/migrations/20260806181739_25d516da-f340-4291-b4fd-a66f5910f998.sql",
  "utf8",
);
const GATE = ENGINE.slice(
  ENGINE.indexOf('if (action === "release_gate")'),
  ENGINE.indexOf('if (action === "request_refresh")'),
);
const MAINTENANCE = ENGINE.slice(
  ENGINE.indexOf('if (action === "maintenance")'),
  ENGINE.indexOf('if (action === "release_gate")'),
);
const STATUS = ENGINE.slice(
  ENGINE.indexOf('if (action === "status")'),
  ENGINE.indexOf('if (action === "maintenance")'),
);
const SELECTOR = ENGINE.slice(
  ENGINE.indexOf("const dryRun = body.dry_run === true;"),
  ENGINE.indexOf("const runInsert = await sb"),
);
const STORE = ENGINE.slice(
  ENGINE.indexOf("async function storeOpportunity"),
  ENGINE.indexOf("serve(async (req)"),
);
const COLLECT = ENGINE.slice(ENGINE.indexOf("const diagnostics: Array<"));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 7, 6, 12, 0, 0);

function source(id: string, over: Partial<RankableSource> = {}): RankableSource {
  return {
    id,
    region: null,
    source_kind: "BUR",
    priority: 0,
    last_scanned_at: new Date(NOW - 30 * HOUR).toISOString(),
    next_scan_at: new Date(NOW - HOUR).toISOString(),
    enabled: true,
    ...over,
  };
}

function realRun(sourceId: string, over: Partial<RunLike> = {}): RunLike {
  return {
    id: `run-${sourceId}`,
    source_id: sourceId,
    status: "SUCCEEDED",
    started_at: new Date(NOW - 2 * HOUR).toISOString(),
    finished_at: new Date(NOW - 2 * HOUR).toISOString(),
    provider_usage: {
      firecrawl_search_status: "OK",
      perplexity_search_status: "OK",
      pages_attempted: 0,
      pages_scraped: 0,
    },
    ...over,
  };
}

describe("costanti di contratto", () => {
  it("finestra copertura 26h e run stale a 20 minuti", () => {
    expect(COVERAGE_WINDOW_HOURS).toBe(26);
    expect(RUN_STALE_AFTER_MINUTES).toBe(20);
    expect(REGIONAL_BYPASS_MAX_MINUTES).toBe(30);
  });

  it("il modulo di hardening è puro: nessuna I/O, nessun provider", () => {
    expect(HARDENING).not.toMatch(/fetch\(|createClient|firecrawl\.|apify|Deno\.env/i);
  });
});

describe("selettore fonti equo — nessuna starvation su 53 fonti", () => {
  const many = Array.from({ length: 53 }, (_, i) =>
    source(`s${String(i).padStart(2, "0")}`, {
      next_scan_at: new Date(NOW - (53 - i) * MINUTE).toISOString(),
      priority: i % 5,
    }),
  );

  it("sceglie sempre la fonte con next_scan_at più vecchio", () => {
    const picked = selectDueSource(many, { nowMs: NOW });
    expect(picked.source?.id).toBe("s00");
    expect(picked.reason).toBe("FAIR_OLDEST");
  });

  it("priority alta non può scavalcare una fonte più arretrata", () => {
    const picked = selectDueSource(
      [source("vecchia", { priority: 0 }), source("prioritaria", {
        priority: 99,
        next_scan_at: new Date(NOW - MINUTE).toISOString(),
      })],
      { nowMs: NOW },
    );
    expect(picked.source?.id).toBe("vecchia");
  });

  it("priority resta solo tie-break a parità di scadenza e last_scanned", () => {
    const ranked = rankSources([
      source("bassa", { priority: 1 }),
      source("alta", { priority: 9 }),
    ]);
    expect(ranked[0].id).toBe("alta");
  });

  it("chi non è mai stato scansionato precede a parità di next_scan_at", () => {
    const ranked = rankSources([
      source("scansionata"),
      source("mai", { last_scanned_at: null }),
    ]);
    expect(ranked[0].id).toBe("mai");
  });

  it("un ciclo completo copre tutte le fonti: nessuna resta indietro", () => {
    const pool = many.map((s) => ({ ...s }));
    const seen = new Set<string>();
    for (let i = 0; i < pool.length; i++) {
      const picked = selectDueSource(pool, { nowMs: NOW });
      expect(picked.source).not.toBeNull();
      seen.add(picked.source!.id);
      const target = pool.find((s) => s.id === picked.source!.id)!;
      target.next_scan_at = new Date(NOW + HOUR).toISOString();
    }
    expect(seen.size).toBe(53);
  });

  it("nessuna fonte dovuta => NO_SOURCE_DUE", () => {
    const picked = selectDueSource(
      [source("futura", { next_scan_at: new Date(NOW + HOUR).toISOString() })],
      { nowMs: NOW },
    );
    expect(picked.source).toBeNull();
    expect(picked.reason).toBe("NO_SOURCE_DUE");
  });
});

describe("bypass regionale limitato", () => {
  it("anticipa una fonte regionale entro 30 minuti dalla più arretrata", () => {
    const picked = selectDueSource(
      [
        source("nazionale", { next_scan_at: new Date(NOW - 40 * MINUTE).toISOString() }),
        source("veneto", {
          region: "Veneto",
          next_scan_at: new Date(NOW - 20 * MINUTE).toISOString(),
        }),
      ],
      { nowMs: NOW, refreshRegion: "Veneto" },
    );
    expect(picked.source?.id).toBe("veneto");
    expect(picked.reason).toBe("REGIONAL_BYPASS");
    expect(picked.bypass_minutes).toBeLessThanOrEqual(REGIONAL_BYPASS_MAX_MINUTES);
  });

  it("oltre 30 minuti vince sempre la fonte più arretrata", () => {
    const picked = selectDueSource(
      [
        source("nazionale", { next_scan_at: new Date(NOW - 5 * HOUR).toISOString() }),
        source("veneto", {
          region: "Veneto",
          next_scan_at: new Date(NOW - 10 * MINUTE).toISOString(),
        }),
      ],
      { nowMs: NOW, refreshRegion: "Veneto" },
    );
    expect(picked.source?.id).toBe("nazionale");
    expect(picked.reason).toBe("FAIR_OLDEST");
  });
});

describe("scan reale a zero novità", () => {
  it("è valido con run SUCCEEDED, fonte e contatori interi anche a zero", () => {
    expect(isRealScan(realRun("s1"))).toBe(true);
  });

  it("non è valido senza source_id, senza finished_at o non SUCCEEDED", () => {
    expect(isRealScan(realRun("s1", { source_id: null }))).toBe(false);
    expect(isRealScan(realRun("s1", { finished_at: null }))).toBe(false);
    expect(isRealScan(realRun("s1", { status: "PARTIAL" }))).toBe(false);
    expect(isRealScan(realRun("s1", { status: "RUNNING" }))).toBe(false);
    expect(isRealScan(realRun("s1", { status: "SKIPPED" }))).toBe(false);
  });

  it("non è valido se un provider non ha status OK o i contatori sono incoerenti", () => {
    expect(
      isRealScan(
        realRun("s1", {
          provider_usage: {
            firecrawl_search_status: "HTTP_429",
            perplexity_search_status: "OK",
            pages_attempted: 0,
            pages_scraped: 0,
          },
        }),
      ),
    ).toBe(false);
    expect(
      isRealScan(
        realRun("s1", {
          provider_usage: {
            firecrawl_search_status: "OK",
            perplexity_search_status: "OK",
            pages_attempted: 1,
            pages_scraped: 2,
          },
        }),
      ),
    ).toBe(false);
    expect(isRealScan(realRun("s1", { provider_usage: null }))).toBe(false);
  });
});

describe("release_gate dinamico — fail closed", () => {
  const sources = [
    source("a", { source_kind: "BUR" }),
    source("b", { source_kind: "GAL" }),
  ];
  const base = {
    nowMs: NOW,
    enabledSources: sources,
    recentRuns: [realRun("a"), realRun("b")],
    staleRunningCount: 0,
    verifiedActiveDistinct: 2,
  };

  it("passa quando ogni fonte e ogni tipo sono coperti da scan reali", () => {
    const gate = evaluateGate(base);
    expect(gate.ok).toBe(true);
    expect(gate.metrics.covered_sources).toBe(2);
    expect(gate.metrics.covered_source_kinds).toBe(2);
  });

  it("fallisce se una sola fonte enabled non è coperta", () => {
    const gate = evaluateGate({ ...base, recentRuns: [realRun("a")] });
    expect(gate.ok).toBe(false);
    expect(gate.checks.all_enabled_sources_scanned).toBe(false);
  });

  it("fallisce se lo scan è oltre la finestra di 26 ore", () => {
    const gate = evaluateGate({
      ...base,
      recentRuns: [
        realRun("a"),
        realRun("b", { finished_at: new Date(NOW - 27 * HOUR).toISOString() }),
      ],
    });
    expect(gate.ok).toBe(false);
  });

  it("fallisce con run RUNNING stale", () => {
    const gate = evaluateGate({ ...base, staleRunningCount: 1 });
    expect(gate.ok).toBe(false);
    expect(gate.checks.no_stale_running_runs).toBe(false);
  });

  it("richiede catalogo verificato almeno pari ai source_kind enabled", () => {
    expect(evaluateGate({ ...base, verifiedActiveDistinct: 1 }).ok).toBe(false);
    expect(evaluateGate({ ...base, verifiedActiveDistinct: 2 }).ok).toBe(true);
  });

  it("registro vuoto non può mai passare", () => {
    const gate = evaluateGate({
      ...base,
      enabledSources: [],
      recentRuns: [],
      verifiedActiveDistinct: 99,
    });
    expect(gate.ok).toBe(false);
  });

  it("nessuna soglia commerciale inventata nel modulo", () => {
    expect(HARDENING).not.toMatch(/>=\s*(?:[1-9]\d{1,})\s*(?:;|\))/);
  });
});

describe("release_gate endpoint", () => {
  it("usa il modulo di hardening e non soglie hardcoded", () => {
    expect(GATE).toContain("evaluateGate({");
    expect(GATE).not.toContain('["BUR", "ALBO_PRETORIO", "CAMERALE", "GAL"]');
  });

  it("conta le opportunità verificate via RPC distinct, mai con un join", () => {
    expect(GATE).toContain('sb.rpc("trovabandi_verified_active_distinct_count"');
    expect(GATE).not.toContain("trovabandi_evidence!inner");
  });

  it("query in errore o nulle sono fail closed", () => {
    expect(GATE).toContain('code: "GATE_QUERY_FAILED"');
    expect(GATE).toContain("sourcesRes.error || runsRes.error");
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

describe("status e maintenance", () => {
  it("status non conta le opportunità scadute e fallisce sugli errori di query", () => {
    expect(STATUS).toContain("deadline_at.is.null,deadline_at.gte.");
    expect(STATUS).toContain('code: "STATUS_QUERY_FAILED"');
  });

  it("maintenance riconcilia i RUNNING stale a FAILED/STALE_RUN_TIMEOUT", () => {
    expect(MAINTENANCE).toContain('error_code: "STALE_RUN_TIMEOUT"');
    expect(MAINTENANCE).toContain('.eq("status", "RUNNING")');
    expect(MAINTENANCE).toContain("staleRunCutoffIso(nowMs)");
  });

  it("maintenance scade solo gli stati appropriati", () => {
    expect(MAINTENANCE).toContain('.in("verification_status", ["VERIFICATO", "PARZIALE", "DA_VERIFICARE"])');
  });

  it("maintenance è fail closed su entrambe le scritture", () => {
    expect(MAINTENANCE).toContain('code: "MAINTENANCE_RUNS_FAILED"');
    expect(MAINTENANCE).toContain('code: "MAINTENANCE_FAILED"');
  });
});

describe("collect — dry-run, SKIPPED e lease", () => {
  it("dry_run non tocca provider né scritture", () => {
    const dry = SELECTOR.slice(SELECTOR.indexOf("if (dryRun)"), SELECTOR.indexOf("if (!selected)"));
    expect(dry).toContain("would_collect");
    expect(dry).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|firecrawl|perplexity|fetch\(/i);
  });

  it("dry_run segnala NO_SOURCE_DUE senza persistere alcun run", () => {
    expect(SELECTOR).toContain('reason: selected ? selection.reason : "NO_SOURCE_DUE"');
    expect(SELECTOR.indexOf("if (dryRun)")).toBeLessThan(SELECTOR.indexOf('status: "SKIPPED"'));
  });

  it("in live senza fonti dovute persiste un run SKIPPED distinto da SUCCEEDED", () => {
    expect(SELECTOR).toContain('status: "SKIPPED"');
    expect(SELECTOR).toContain('error_code: "NO_SOURCE_DUE"');
    expect(SELECTOR).toContain("finished_at: nowIso");
    expect(SELECTOR).not.toContain('status: "SUCCEEDED"');
  });

  it("usa il selettore equo del modulo, non fast_lane/priority order", () => {
    expect(SELECTOR).toContain("selectDueSource(");
    expect(SELECTOR).not.toContain('.order("fast_lane"');
    expect(SELECTOR).not.toContain('.order("priority"');
  });

  it("lease ottimistico compare-and-set contro l'overlap", () => {
    expect(SELECTOR).toContain('.eq("next_scan_at", baseSource.next_scan_at)');
    expect(SELECTOR).toContain('error_code: "LEASE_LOST"');
  });

  it("persistenza run e query fonti fail closed", () => {
    expect(SELECTOR).toContain('code: "SOURCE_QUERY_FAILED"');
    expect(SELECTOR).toContain('code: "REFRESH_QUERY_FAILED"');
    expect(ENGINE).toContain('code: "RUN_PERSIST_FAILED"');
  });

  it("i cap su max_pages restano 1..5", () => {
    expect(ENGINE).toContain("Math.max(1, Math.min(5, Number(body.max_pages ?? 2)))");
  });
});

describe("migration isolata al dominio trovabandi", () => {
  it("crea solo indici trovabandi_* e la RPC distinct", () => {
    expect(MIGRATION).toContain("trovabandi_verified_active_distinct_count");
    expect(MIGRATION).toContain("EXISTS (");
    expect(MIGRATION).not.toMatch(/civiko|padova|cron\.schedule|DELETE FROM|DROP TABLE/i);
  });

  it("la RPC non è esposta a PUBLIC/anon/authenticated", () => {
    expect(MIGRATION).toContain("REVOKE ALL ON FUNCTION public.trovabandi_verified_active_distinct_count(timestamptz) FROM PUBLIC");
    expect(MIGRATION).toContain("GRANT EXECUTE ON FUNCTION public.trovabandi_verified_active_distinct_count(timestamptz) TO service_role");
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
    expect(ENGINE).toContain('status: operationalFailures > 0 ? "PARTIAL" : "SUCCEEDED"');
    expect(ENGINE).not.toContain('status: warnings.length ? "PARTIAL" : "SUCCEEDED"');
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
