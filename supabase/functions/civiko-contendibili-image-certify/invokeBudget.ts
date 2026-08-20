// Budget di invocazione per la certificazione fotografica.
// Limit 20 andava in WORKER_RESOURCE_LIMIT e perdeva le impronte in RAM.
// Si smette di prendere NUOVI candidati a 100s; i non lavorati non diventano
// terminali fasulli. chain:true concatena lotti da 4 con cooldown 2s.

export const TOTAL_LISTINGS_PER_INVOCATION = 4;
export const INVOKE_WALL_MS = 100_000;
export const CHAIN_COOLDOWN_MS = 2_000;
export const CHAIN_MAX_HOPS = 24;

export function wallClockExceeded(
  startedAtMs: number,
  nowMs: number = Date.now(),
  wallMs: number = INVOKE_WALL_MS,
): boolean {
  return nowMs - startedAtMs >= wallMs;
}

export function shouldChainNext(input: {
  chain: boolean;
  hop: number;
  remaining: number;
  pairsOnly: boolean;
  dryRun: boolean;
  maxHops?: number;
}): boolean {
  if (!input.chain || input.dryRun || input.pairsOnly) return false;
  if (input.remaining <= 0) return false;
  return input.hop < (input.maxHops ?? CHAIN_MAX_HOPS);
}
