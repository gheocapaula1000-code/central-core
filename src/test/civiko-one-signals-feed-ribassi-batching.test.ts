// Contract + behavioural test: ribassi RPC batching a concorrenza 2.
// Il fanout simultaneo su 8 zone saturava il DB (statement_timeout 57014).
// Il batching deve mantenere ordine, aggregazione, timeout 12000 e fail-closed.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "supabase/functions/civiko-one-signals-feed/index.ts"),
  "utf8",
);

const ZONES = [
  "centro-storico",
  "nord-arcella",
  "est-brenta",
  "nord-est",
  "sud-est-sant-osvaldo",
  "sud-voltabarozzo-guizza",
  "sud-ovest-mandria",
  "ovest-chiesanuova-brentelle",
];

// Replica esatta del loop di batching presente nella funzione.
async function runBatched(
  zoneFilter: string[],
  rpc: (slug: string) => Promise<{ data?: unknown; error?: { message: string } | null }>,
) {
  const RIBASSI_RPC_CONCURRENCY = 2;
  const rpcCalls: Array<{ data?: unknown; error?: { message: string } | null }> = [];
  for (let i = 0; i < zoneFilter.length; i += RIBASSI_RPC_CONCURRENCY) {
    const batch = zoneFilter.slice(i, i + RIBASSI_RPC_CONCURRENCY);
    const settled = await Promise.all(batch.map((slug) => rpc(slug)));
    for (const r of settled) rpcCalls.push(r);
  }
  return rpcCalls;
}

describe("civiko-one-signals-feed — ribassi batching", () => {
  it("il sorgente usa batching deterministico a concorrenza 2 (niente fanout su tutte le zone)", () => {
    expect(SRC).toContain("const RIBASSI_RPC_CONCURRENCY = 2;");
    expect(SRC).toContain("zoneFilter.slice(i, i + RIBASSI_RPC_CONCURRENCY)");
    expect(SRC).not.toMatch(/Promise\.all\(\s*zoneFilter\.map\(/);
  });

  it("max 2 chiamate RPC contemporanee", async () => {
    let inFlight = 0;
    let peak = 0;
    await runBatched(ZONES, async (slug) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { data: [{ slug }], error: null };
    });
    expect(peak).toBe(2);
  });

  it("ordine e aggregazione invariati rispetto a zoneFilter", async () => {
    const calls = await runBatched(ZONES, async (slug) => {
      await new Promise((r) => setTimeout(r, slug.length % 7));
      return { data: [{ commercial_zone_slug: slug }], error: null };
    });
    const flat = calls.flatMap((r) => (Array.isArray(r.data) ? r.data : []));
    expect(
      flat.map((row: { commercial_zone_slug: string }) => row.commercial_zone_slug),
    ).toEqual(ZONES);
    expect(calls).toHaveLength(ZONES.length);
  });

  it("un errore in qualsiasi batch resta fail-closed a zero", async () => {
    for (const failing of [0, 3, 7]) {
      const calls = await runBatched(ZONES, async (slug) =>
        ZONES[failing] === slug
          ? { data: null, error: { message: "canceling statement due to statement timeout" } }
          : { data: [{ commercial_zone_slug: slug }], error: null },
      );
      const firstErr = calls.find((r) => r.error);
      expect(firstErr?.error).toBeTruthy();
      // fail-closed: nessuna riga viene emessa se esiste un errore
      const emitted = firstErr?.error ? [] : calls.flatMap((r) => (Array.isArray(r.data) ? r.data : []));
      expect(emitted).toHaveLength(0);
    }
    // e il sorgente mantiene la stessa logica fail-closed
    expect(SRC).toContain("const firstErr = rpcCalls.find((r) => r.error);");
    expect(SRC).toContain("rpc_missing_no_fallback");
  });

  it("timeout 12000 e parametri v2 invariati", () => {
    expect(SRC).toContain("const RIBASSI_RPC_TIMEOUT_MS = 12000;");
    expect(SRC).toContain('supabase.rpc("get_padova_verified_price_drops_by_zone_v2"');
    expect(SRC).toContain("const RIBASSI_PER_ZONE_LIMIT = Math.min(20, limit);");
    expect(SRC).toContain("p_min_drop_pct: 5");
    expect(SRC).toContain("p_max_age_days: 14");
  });
});
