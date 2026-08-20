import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CHAIN_COOLDOWN_MS,
  CHAIN_MAX_HOPS,
  INVOKE_WALL_MS,
  shouldChainNext,
  TOTAL_LISTINGS_PER_INVOCATION,
  wallClockExceeded,
} from "../../supabase/functions/civiko-contendibili-image-certify/invokeBudget";

const certify = readFileSync(
  resolve(__dirname, "../../supabase/functions/civiko-contendibili-image-certify/index.ts"),
  "utf8",
);

describe("image-certify invoke budget", () => {
  it("uses batches of 4 and stops taking new candidates at 100s", () => {
    expect(TOTAL_LISTINGS_PER_INVOCATION).toBe(4);
    expect(INVOKE_WALL_MS).toBe(100_000);
    expect(wallClockExceeded(0, 99_999)).toBe(false);
    expect(wallClockExceeded(0, 100_000)).toBe(true);
  });

  it("chains only while work remains, hops remain, and mode is not pairs_only", () => {
    expect(CHAIN_COOLDOWN_MS).toBe(2_000);
    expect(CHAIN_MAX_HOPS).toBe(24);
    expect(shouldChainNext({
      chain: true,
      hop: 0,
      remaining: 12,
      pairsOnly: false,
      dryRun: false,
    })).toBe(true);
    expect(shouldChainNext({
      chain: true,
      hop: 24,
      remaining: 12,
      pairsOnly: false,
      dryRun: false,
    })).toBe(false);
    expect(shouldChainNext({
      chain: true,
      hop: 0,
      remaining: 0,
      pairsOnly: false,
      dryRun: false,
    })).toBe(false);
    expect(shouldChainNext({
      chain: true,
      hop: 0,
      remaining: 12,
      pairsOnly: true,
      dryRun: false,
    })).toBe(false);
    expect(shouldChainNext({
      chain: false,
      hop: 0,
      remaining: 12,
      pairsOnly: false,
      dryRun: false,
    })).toBe(false);
  });

  it("does not mark unworked candidates as terminal no_photo", () => {
    expect(certify).toContain("if (!rawOutcome) continue");
    expect(certify).toContain("wallClockExceeded");
    expect(certify).not.toContain("?? \"no_photo\"");
  });
});
