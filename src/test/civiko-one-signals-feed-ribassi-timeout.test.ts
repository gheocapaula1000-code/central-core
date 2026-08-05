// Static contract test: ribassi RPC client-side timeout.
// La RPC v2 reale completa in ~9s: il timeout deve essere 12000ms,
// il comportamento fail-closed deve restare invariato.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "supabase/functions/civiko-one-signals-feed/index.ts"),
  "utf8",
);

describe("civiko-one-signals-feed — ribassi RPC timeout", () => {
  it("RIBASSI_RPC_TIMEOUT_MS è 12000", () => {
    expect(SRC).toContain("const RIBASSI_RPC_TIMEOUT_MS = 12000;");
    expect(SRC).not.toContain("const RIBASSI_RPC_TIMEOUT_MS = 6000;");
  });

  it("il timeout è applicato via Promise.race alla RPC v2", () => {
    expect(SRC).toMatch(/setTimeout\([\s\S]{0,160}RIBASSI_RPC_TIMEOUT_MS\)/);
    expect(SRC).toContain("Promise.race([");
    expect(SRC).toContain("get_padova_verified_price_drops_by_zone_v2");
  });

  it("fail-closed invariato: client_timeout produce errore, nessun fallback v1", () => {
    expect(SRC).toContain('message: "client_timeout", code: "TIMEOUT"');
    expect(SRC).toContain("rpc_missing_no_fallback");
    expect(SRC).not.toMatch(/rpc\(\s*"get_padova_verified_price_drops_by_zone"\s*,/);
    expect(SRC).not.toMatch(/fallback_collect_v2/);
  });

  it("parametri e cap della query ribassi invariati", () => {
    expect(SRC).toContain("const RIBASSI_PER_ZONE_LIMIT = Math.min(20, limit);");
    expect(SRC).toContain("p_min_drop_pct: 5");
    expect(SRC).toContain("p_max_age_days: 14");
  });
});
