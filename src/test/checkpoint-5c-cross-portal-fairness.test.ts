import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SHARED = resolve(process.cwd(), "supabase/functions/_shared/agencyEnrichment.ts");
const RUNNER = resolve(process.cwd(), "supabase/functions/padova-agency-enrich-run/index.ts");
const WRAPPER = resolve(process.cwd(), "supabase/functions/cron-padova-agency-enrich/index.ts");

const shared = readFileSync(SHARED, "utf8");
const runner = readFileSync(RUNNER, "utf8");
const wrapper = readFileSync(WRAPPER, "utf8");

// ── Mirror locale delle primitive Deno ──
function interleaveByPortal<T>(order: string[], byPortal: Record<string, T[]>) {
  const out: { portal: string; item: T }[] = [];
  const max = order.reduce((m, p) => Math.max(m, byPortal[p]?.length ?? 0), 0);
  for (let i = 0; i < max; i++) {
    for (const p of order) {
      const list = byPortal[p];
      if (list && i < list.length) out.push({ portal: p, item: list[i] });
    }
  }
  return out;
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

const mk = (p: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ url: `${p}-${i}`, id: i, state: "never_tried" as const, enriched_at: null }));

describe("5C fairness cross-portale — interleaving", () => {
  it("alterna round-robin casa/immobiliare", () => {
    const q = interleaveByPortal(["casa", "immobiliare"], { casa: mk("casa", 3), immobiliare: mk("imm", 3) });
    expect(q.map((x) => x.item.url)).toEqual(["casa-0", "imm-0", "casa-1", "imm-1", "casa-2", "imm-2"]);
  });

  it("un solo portale continua a funzionare", () => {
    const q = interleaveByPortal(["casa", "immobiliare"], { casa: mk("casa", 3), immobiliare: [] });
    expect(q.map((x) => x.portal)).toEqual(["casa", "casa", "casa"]);
  });

  it("liste asimmetriche: coda dell'altro portale in fondo, nessuna perdita", () => {
    const q = interleaveByPortal(["casa", "immobiliare"], { casa: mk("casa", 1), immobiliare: mk("imm", 3) });
    expect(q.map((x) => x.item.url)).toEqual(["casa-0", "imm-0", "imm-1", "imm-2"]);
  });

  it("nessun URL duplicato nella coda globale", () => {
    const q = interleaveByPortal(["casa", "immobiliare"], { casa: mk("casa", 5), immobiliare: mk("imm", 5) });
    expect(new Set(q.map((x) => x.item.url)).size).toBe(q.length);
  });

  it("deterministico su piu' invocazioni", () => {
    const a = interleaveByPortal(["casa", "immobiliare"], { casa: mk("casa", 4), immobiliare: mk("imm", 2) });
    const b = interleaveByPortal(["casa", "immobiliare"], { casa: mk("casa", 4), immobiliare: mk("imm", 2) });
    expect(a.map((x) => x.item.url)).toEqual(b.map((x) => x.item.url));
  });
});

describe("5C fairness cross-portale — esecuzione bounded", () => {
  it("con deadline corta entrambi i portali ottengono un avvio prima del secondo turno di uno dei due", async () => {
    const q = interleaveByPortal(["casa", "immobiliare"], { casa: mk("casa", 5), immobiliare: mk("imm", 5) });
    const started: string[] = [];
    await runBounded(q, async ({ portal }) => { started.push(portal); }, {
      concurrency: 1,
      shouldStart: () => started.length < 2,
    });
    expect(new Set(started)).toEqual(new Set(["casa", "immobiliare"]));
  });

  it("un primo portale lento non impedisce l'avvio del secondo", async () => {
    const q = interleaveByPortal(["casa", "immobiliare"], { casa: mk("casa", 4), immobiliare: mk("imm", 4) });
    let now = 0;
    const deadlineAt = 100;
    const started: string[] = [];
    const deferred = await runBounded(q, async ({ portal }) => {
      started.push(portal);
      now += portal === "casa" ? 60 : 5; // casa lentissimo
    }, { concurrency: 1, shouldStart: () => now + 10 <= deadlineAt });
    expect(started).toContain("immobiliare");
    expect(started.indexOf("immobiliare")).toBe(1);
    expect(deferred.length).toBeGreaterThan(0);
  });

  it("concorrenza totale globale: 2 di default, 3 come massimo hard", async () => {
    for (const [req, cap] of [[2, 2], [9, 3]] as const) {
      const q = interleaveByPortal(["casa", "immobiliare"], { casa: mk("casa", 6), immobiliare: mk("imm", 6) });
      let inFlight = 0, peak = 0;
      await runBounded(q, async () => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
      }, { concurrency: req, shouldStart: () => true });
      expect(peak).toBe(cap);
    }
  });

  it("tutti i candidati non avviati sono attribuiti al portale corretto e il totale coincide", async () => {
    const q = interleaveByPortal(["casa", "immobiliare"], { casa: mk("casa", 5), immobiliare: mk("imm", 5) });
    let started = 0;
    const deferred = await runBounded(q, async () => { started++; }, {
      concurrency: 1,
      shouldStart: () => started < 3,
    });
    const perPortal: Record<string, number> = { casa: 0, immobiliare: 0 };
    for (const d of deferred) perPortal[d.portal]++;
    expect(perPortal.casa + perPortal.immobiliare).toBe(deferred.length);
    expect(started + deferred.length).toBe(10);
    expect(perPortal.casa).toBeGreaterThan(0);
    expect(perPortal.immobiliare).toBeGreaterThan(0);
  });
});

describe("5C fairness cross-portale — contratto runner", () => {
  it("una sola runBounded sulla coda globale", () => {
    expect(runner.match(/await runBounded</g)?.length).toBe(1);
    expect(runner).toMatch(/interleaveByPortal<RankedCandidate>\(portals, rankedByPortal\)/);
  });

  it("nessun ciclo di enrichment per portale prima della coda", () => {
    expect(runner).not.toMatch(/for \(const portal of portals\)[\s\S]{0,400}runBounded/);
  });

  it("deferred attribuiti per portale e deadline_reached coerente", () => {
    expect(runner).toMatch(/for \(const d of deferredItems\)[\s\S]{0,80}perPortal\[d\.portal\]\.deferred\+\+/);
    expect(runner).toMatch(/if \(deferredItems\.length > 0\) deadlineReached = true;/);
    expect(runner).toMatch(/else if \(totals\.deferred > 0\) runStatus = "partial_deadline";/);
  });

  it("deduplica URL cross-portale", () => {
    expect(runner).toMatch(/seenUrls/);
  });

  it("invarianti 5C/5B non modificate", () => {
    expect(runner).toMatch(/rankCandidates\([\s\S]*?\.slice\(0, limit\)/);
    expect(runner).toMatch(/Math\.min\(3, body\.concurrency \?\? DEFAULT_CONCURRENCY\)/);
    expect(runner).toMatch(/const RESERVE_MS = 8_000;/);
    expect(runner).toMatch(/recompute && !dryRun && !cacheOnly && anyPromoted/);
    expect(runner).toMatch(/cacheOnly/);
    expect(shared).toMatch(/export const CACHE_TTL_MS = 72 \* 3600 \* 1000;/);
    expect(shared).toMatch(/DEFAULT_URL_TIMEOUT_MS = 20_000/);
    expect(wrapper).toMatch(/AbortSignal\.timeout\(100_000\)/);
  });

  it("cache_only non esegue chiamate provider", () => {
    expect(shared).toMatch(/if \(opts\?\.cacheOnly\)[\s\S]{0,300}cache_only_miss/);
    expect(shared.indexOf("if (opts?.cacheOnly)")).toBeLessThan(shared.indexOf("canSpendFirecrawl(1)"));
  });
});
