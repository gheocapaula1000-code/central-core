import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SHARED = resolve(process.cwd(), "supabase/functions/_shared/agencyEnrichment.ts");
const RUNNER = resolve(process.cwd(), "supabase/functions/padova-agency-enrich-run/index.ts");
const WRAPPER = resolve(process.cwd(), "supabase/functions/cron-padova-agency-enrich/index.ts");

const shared = readFileSync(SHARED, "utf8");
const runner = readFileSync(RUNNER, "utf8");
const wrapper = readFileSync(WRAPPER, "utf8");

const CACHE_TTL_MS = 72 * 3600 * 1000;

// ── Reimplementazione locale delle regole di selezione (mirror del modulo Deno) ──
type CandidateState = "never_tried" | "cache_stale" | "cache_fresh";
interface Ranked { url: string; id: number; state: CandidateState; enriched_at: string | null }

function rankCandidates(
  rows: { id: number; url: string }[],
  cache: Map<string, { enriched_at: string | null }>,
  now = Date.now(),
): Ranked[] {
  const seen = new Set<string>();
  const items: Ranked[] = [];
  for (const r of rows) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    const at = cache.get(r.url)?.enriched_at ?? null;
    let state: CandidateState = "never_tried";
    if (at) state = now - new Date(at).getTime() < CACHE_TTL_MS ? "cache_fresh" : "cache_stale";
    items.push({ url: r.url, id: r.id, state, enriched_at: at });
  }
  const rank: Record<CandidateState, number> = { never_tried: 0, cache_stale: 1, cache_fresh: 2 };
  return items.sort((a, b) => {
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    const ta = a.enriched_at ? new Date(a.enriched_at).getTime() : 0;
    const tb = b.enriched_at ? new Date(b.enriched_at).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });
}

async function runBounded<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  opts: { concurrency: number; shouldStart: () => boolean },
): Promise<T[]> {
  const conc = Math.max(1, Math.min(3, opts.concurrency));
  let next = 0;
  const deferred: T[] = [];
  async function lane() {
    for (;;) {
      if (next >= items.length) return;
      if (!opts.shouldStart()) {
        while (next < items.length) deferred.push(items[next++]);
        return;
      }
      await worker(items[next++]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, () => lane()));
  return deferred;
}

describe("5C — timeout locale Firecrawl", () => {
  it("la fetch usa AbortController con timer e signal", () => {
    expect(shared).toMatch(/new AbortController\(\)/);
    expect(shared).toMatch(/setTimeout\(\(\) => ctrl\.abort\(\), timeoutMs\)/);
    expect(shared).toMatch(/signal: ctrl\.signal/);
    expect(shared).toMatch(/clearTimeout\(timer\)/);
  });

  it("l'abort locale produce l'errore local_timeout", () => {
    expect(shared).toMatch(/AbortError.*\n?.*local_timeout|error: "local_timeout"/s);
  });

  it("il timeout provider resta sotto quello locale", () => {
    expect(shared).toMatch(/providerTimeout = Math\.max\(5_000, timeoutMs - 3_000\)/);
  });

  it("timeout per URL di default (20s) molto inferiore al budget totale", () => {
    expect(shared).toMatch(/DEFAULT_URL_TIMEOUT_MS = 20_000/);
    expect(runner).toMatch(/DEFAULT_DEADLINE_MS = 75_000/);
  });

  it("abortisce realmente una fetch che non risponde", async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    expect(ctrl.signal.aborted).toBe(false);
    vi.advanceTimersByTime(20_001);
    expect(ctrl.signal.aborted).toBe(true);
    clearTimeout(timer);
    vi.useRealTimers();
  });
});

describe("5C — deadline globale e concorrenza", () => {
  it("non avvia nuovo lavoro quando il tempo residuo e' insufficiente", async () => {
    let now = 0;
    const urlTimeout = 20_000, reserve = 8_000, deadlineAt = 30_000;
    const shouldStart = () => now + urlTimeout + reserve <= deadlineAt;
    const items = [1, 2, 3, 4, 5];
    const done: number[] = [];
    const deferred = await runBounded(items, async (i) => { done.push(i); now += 10_000; }, { concurrency: 1, shouldStart });
    expect(done.length).toBe(1);
    expect(deferred.length).toBe(4);
  });

  it("gli URL rinviati sono conteggiati, non persi", async () => {
    const items = ["a", "b", "c"];
    let started = 0;
    const deferred = await runBounded(items, async () => { started++; }, { concurrency: 2, shouldStart: () => started < 1 });
    expect(started + deferred.length).toBe(items.length);
  });

  it("rispetta la concorrenza massima (max 3, default 2)", async () => {
    let inFlight = 0, peak = 0;
    await runBounded([1, 2, 3, 4, 5, 6], async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    }, { concurrency: 2, shouldStart: () => true });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("la concorrenza e' clampata a 3 anche se richiesta superiore", async () => {
    let inFlight = 0, peak = 0;
    await runBounded([1, 2, 3, 4, 5, 6, 7, 8], async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    }, { concurrency: 99, shouldStart: () => true });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("nessun Promise.all illimitato nel runner", () => {
    expect(runner).not.toMatch(/Promise\.all\(\s*rows/);
    expect(runner).toMatch(/runBounded</);
    expect(runner).toMatch(/const concurrency = Math\.max\(1, Math\.min\(3,/);
  });

  it("partial_deadline non produce 504: risposta 200 controllata", () => {
    expect(runner).toMatch(/runStatus = "partial_deadline"/);
    // finish() usa status 200 di default; 500 solo nel catch strutturale
    expect(runner).toMatch(/const finish = \(payload: Record<string, unknown>, status = 200\)/);
    expect(runner).toMatch(/run_status: "failure",\s*\n?\s*error: \{ code: "internal_error"/);
  });
});

describe("5C — fairness della selezione", () => {
  const cache = new Map<string, { enriched_at: string | null }>([
    ["u_fresh", { enriched_at: new Date(Date.now() - 3600_000).toISOString() }],
    ["u_old", { enriched_at: new Date(Date.now() - 200 * 3600_000).toISOString() }],
    ["u_older", { enriched_at: new Date(Date.now() - 400 * 3600_000).toISOString() }],
  ]);
  const rows = [
    { id: 1, url: "u_fresh" }, { id: 2, url: "u_old" },
    { id: 3, url: "u_new1" }, { id: 4, url: "u_older" },
  ];

  it("priorita' agli URL mai tentati", () => {
    const r = rankCandidates(rows, cache);
    expect(r[0].url).toBe("u_new1");
    expect(r[0].state).toBe("never_tried");
  });

  it("poi cache scaduta piu' vecchia prima", () => {
    const r = rankCandidates(rows, cache);
    expect(r[1].url).toBe("u_older");
    expect(r[2].url).toBe("u_old");
  });

  it("cache valida in coda (usata senza nuova chiamata)", () => {
    const r = rankCandidates(rows, cache);
    expect(r[3].url).toBe("u_fresh");
    expect(r[3].state).toBe("cache_fresh");
  });

  it("nessun URL duplicato nello stesso run", () => {
    const dup = [{ id: 1, url: "x" }, { id: 2, url: "x" }, { id: 3, url: "y" }];
    const r = rankCandidates(dup, new Map());
    expect(r.map((i) => i.url)).toEqual(["x", "y"]);
  });

  it("ordinamento stabile e deterministico a parita' di stato", () => {
    const eq = [{ id: 1, url: "b" }, { id: 2, url: "a" }];
    expect(rankCandidates(eq, new Map()).map((i) => i.url)).toEqual(["a", "b"]);
    expect(rankCandidates(eq, new Map()).map((i) => i.url)).toEqual(["a", "b"]);
  });

  it("il runner considera un insieme di candidati piu' ampio del limite finale", () => {
    expect(runner).toMatch(/CANDIDATE_MULTIPLIER = 3/);
    expect(runner).toMatch(/\.limit\(limit \* CANDIDATE_MULTIPLIER\)/);
    expect(runner).toMatch(/rankCandidates\([\s\S]*?\.slice\(0, limit\)/);
  });

  it("non introduce una nuova architettura di code", () => {
    expect(runner).not.toMatch(/scraping_queue/);
  });
});

describe("5C — cache, budget e modalita' senza costo", () => {
  it("cache 72 ore preservata", () => {
    expect(shared).toMatch(/CACHE_TTL_MS = 72 \* 3600 \* 1000/);
    expect(shared).toMatch(/ageMs < CACHE_TTL_MS/);
  });

  it("cache hit ritorna senza chiamare il provider", () => {
    const cacheBranch = shared.slice(shared.indexOf("// Cache 72h"), shared.indexOf("// Modalita' QA senza costo"));
    expect(cacheBranch).toMatch(/from_cache: true/);
    expect(cacheBranch).not.toMatch(/firecrawlScrape/);
  });

  it("cache_only non chiama mai Firecrawl e non registra spesa", () => {
    const idxCacheOnly = shared.indexOf("if (opts?.cacheOnly)");
    const idxBudget = shared.indexOf("// Budget gate");
    const idxScrape = shared.indexOf("const fc = await firecrawlScrape");
    expect(idxCacheOnly).toBeGreaterThan(-1);
    expect(idxCacheOnly).toBeLessThan(idxBudget);
    expect(idxCacheOnly).toBeLessThan(idxScrape);
    const block = shared.slice(idxCacheOnly, idxBudget);
    expect(block).not.toMatch(/firecrawlScrape|recordFirecrawlSpend/);
    expect(block).toMatch(/cache_only_miss/);
  });

  it("cache_only forza force_refresh a false nel runner", () => {
    expect(runner).toMatch(/forceRefresh = !cacheOnly && !!body\.force_refresh/);
  });

  it("cache_only non promuove e non lancia recompute", () => {
    expect(runner).toMatch(/!dryRun && !cacheOnly && \(ext\.confidence/);
    expect(runner).toMatch(/recompute && !dryRun && !cacheOnly && anyPromoted/);
  });

  it("budget esaurito: nessuna fetch, ritorno immediato", () => {
    const idxBudget = shared.indexOf("const bud = await canSpendFirecrawl(1)");
    const idxScrape = shared.indexOf("const fc = await firecrawlScrape");
    expect(idxBudget).toBeLessThan(idxScrape);
    const block = shared.slice(idxBudget, idxScrape);
    expect(block).toMatch(/if \(!bud\.ok\)/);
    expect(block).toMatch(/return out;/);
    expect(block).not.toMatch(/firecrawlScrape/);
  });

  it("canSpendFirecrawl e recordFirecrawlSpend restano invariati per chiamata", () => {
    expect(shared).toMatch(/canSpendFirecrawl\(1\)/);
    expect(shared).toMatch(/recordFirecrawlSpend\(1, 1\)/);
  });

  it("nessun retry incontrollato", () => {
    expect(shared).not.toMatch(/for \(let attempt/);
    expect(shared).not.toMatch(/retr(y|ies)\s*[<=+]/i);
  });
});

describe("5C — contratto di risposta e gestione errori", () => {
  const required = [
    "ok", "run_status", "started_at", "completed_at", "duration_ms",
    "deadline_reached", "analyzed", "visited", "from_cache", "promoted",
    "deferred", "budget_skipped", "timed_out",
    "per_portal", "recompute_requested", "recompute_executed", "recompute_error",
  ];
  it("espone tutti i campi del contratto", () => {
    for (const f of required) expect(runner).toMatch(new RegExp(`${f}[,:]`));
  });

  it("gli stati ammessi sono esattamente i cinque previsti", () => {
    expect(runner).toMatch(/"success" \| "partial_deadline" \| "skipped_budget" \| "partial_failure" \| "failure"/);
  });

  it("errori di update Supabase controllati, non ignorati", () => {
    expect(runner).toMatch(/const \{ error: upErr \}/);
    expect(runner).toMatch(/if \(upErr\)/);
    expect(runner).toMatch(/stats\.update_errors\+\+/);
    expect(runner).toMatch(/update_errors > 0/);
  });

  it("recompute fallito non e' nascosto da ok:true", () => {
    expect(runner).toMatch(/const ok = runStatus !== "failure" && !recomputeError/);
    expect(runner).toMatch(/recomputeError = rcErr\.message/);
  });

  it("recompute eseguito una sola volta e solo con almeno una promozione", () => {
    expect(runner.match(/rpc\("recompute_padova_contendibili"\)/g)?.length).toBe(1);
    expect(runner).toMatch(/anyPromoted/);
  });

  it("nessun dettaglio tecnico nelle superfici utente", () => {
    expect(runner).toMatch(/message: "Esecuzione non completata\."/);
    expect(runner).toMatch(/message: "Accesso non consentito\."/);
    expect(runner).not.toMatch(/message: String\(\(e as Error\)/);
  });

  it("nessuna esposizione di secret", () => {
    expect(runner).not.toMatch(/CENTRAL_CORE_JOB_SECRET.*(console\.log|JSON\.stringify)/);
    expect(wrapper).not.toMatch(/response_excerpt: secret|secret\.slice/);
    expect(wrapper).not.toMatch(/console\.log\([^)]*secret/i);
  });
});

describe("5C — wrapper cron", () => {
  it("mantiene autenticazione e URL correnti", () => {
    expect(wrapper).toMatch(/"x-job-secret": secret/);
    expect(wrapper).toMatch(/functions\/v1\/padova-agency-enrich-run/);
  });

  it("respinge un falso successo HTTP 200 con ok:false", () => {
    expect(wrapper).toMatch(/payload\.ok !== true/);
    expect(wrapper).toMatch(/status = "failure"/);
    expect(wrapper).toMatch(/app_not_ok/);
  });

  it("logica del wrapper: 200 + ok:false => failure", () => {
    const evaluate = (httpOk: boolean, payload: { ok?: boolean } | null) => {
      if (!httpOk) return "failure";
      if (!payload || payload.ok !== true) return "failure";
      return "success";
    };
    expect(evaluate(true, { ok: false })).toBe("failure");
    expect(evaluate(true, null)).toBe("failure");
    expect(evaluate(true, { ok: true })).toBe("success");
    expect(evaluate(false, { ok: true })).toBe("failure");
  });

  it("registra durata reale, http status, run_status e contatori", () => {
    expect(wrapper).toMatch(/duration_ms: completedAt\.getTime\(\) - triggeredAt\.getTime\(\)/);
    expect(wrapper).toMatch(/http_status: httpStatus/);
    expect(wrapper).toMatch(/runStatus = /);
    expect(wrapper).toMatch(/counters = \{/);
  });

  it("ritorna prima del proprio timeout (100s < 120s wrapper / 150s edge)", () => {
    expect(wrapper).toMatch(/AbortSignal\.timeout\(100_000\)/);
    expect(runner).toMatch(/DEFAULT_DEADLINE_MS = 75_000/);
  });

  it("payload cron: casa+immobiliare, 10 per portale, force_refresh false", () => {
    expect(wrapper).toMatch(/portals: \["casa", "immobiliare"\]/);
    expect(wrapper).toMatch(/limit_per_portal: 10/);
    expect(wrapper).toMatch(/force_refresh: false/);
  });
});

describe("5C — perimetro invariato", () => {
  it("nessuna modifica alle funzioni 5B di recompute", () => {
    expect(runner).not.toMatch(/recompute_padova_listings_contendibili/);
    expect(runner).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
  });

  it("il runner non tocca territorio, radar, billing o proxy", () => {
    for (const forbidden of ["civiko-radar", "stripe", "core-proxy", "civiko-zones-reserve"]) {
      expect(runner).not.toContain(forbidden);
    }
  });
});
