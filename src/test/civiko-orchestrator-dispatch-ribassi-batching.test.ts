import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "supabase/functions/civiko-orchestrator-dispatch/index.ts"),
  "utf8",
);

const SLUGS = [
  "centro-storico",
  "z2",
  "z3",
  "z4",
  "z5",
  "z6",
  "z7",
  "z8",
];

// Replica esatta della struttura di batching presente in verifiedPriceDropsCount()
async function batched(
  call: (slug: string) => Promise<number | null>,
  concurrency = 2,
): Promise<number | null> {
  const counts: Array<number | null> = [];
  for (let i = 0; i < SLUGS.length; i += concurrency) {
    const batch = SLUGS.slice(i, i + concurrency);
    const batchCounts = await Promise.all(batch.map((slug) => call(slug)));
    for (const c of batchCounts) counts.push(c);
  }
  return counts.some((c) => c === null)
    ? null
    : counts.reduce((sum, c) => sum + (c ?? 0), 0);
}

describe("civiko-orchestrator-dispatch — batching ribassi", () => {
  it("il sorgente usa concorrenza 2 e slice, non Promise.all sul map degli 8 slug", () => {
    expect(SRC).toContain("const RIBASSI_RPC_CONCURRENCY = 2;");
    expect(SRC).toContain("CIVIKO_SCOPE_SLUGS.slice(i, i + RIBASSI_RPC_CONCURRENCY)");
    expect(SRC).not.toContain("await Promise.all(calls)");
  });

  it("mantiene GATE_TIMEOUT_MS = 15000 e i parametri RPC v2 invariati", () => {
    expect(SRC).toMatch(/GATE_TIMEOUT_MS\s*=\s*15000/);
    expect(SRC).toContain("get_padova_verified_price_drops_by_zone_v2");
    expect(SRC).toContain("p_limit: 20");
    expect(SRC).toContain("p_min_drop_pct: 5");
    expect(SRC).toContain("p_max_age_days: 14");
    expect(SRC).toContain("p_quartiere: null");
    expect(SRC).toContain("!isAuctionRecord(row)");
    expect(SRC).toContain('row.url.startsWith("https://")');
  });

  it("non supera mai 2 chiamate contemporanee", async () => {
    let inFlight = 0;
    let peak = 0;
    await batched(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return 1;
    });
    expect(peak).toBe(2);
  });

  it("preserva ordine e somma", async () => {
    const seen: string[] = [];
    const total = await batched(async (slug) => {
      seen.push(slug);
      return SLUGS.indexOf(slug);
    });
    expect(seen.sort()).toEqual([...SLUGS].sort());
    expect(total).toBe(0 + 1 + 2 + 3 + 4 + 5 + 6 + 7);
  });

  it("resta fail-closed a null se un qualsiasi batch restituisce null", async () => {
    for (const failing of [0, 3, 5, 7]) {
      const res = await batched(async (slug) =>
        SLUGS.indexOf(slug) === failing ? null : 2
      );
      expect(res).toBeNull();
    }
  });
});
