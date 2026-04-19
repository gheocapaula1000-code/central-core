// ═══════════════════════════════════════════════════════════════
// Property Detail — Assembler / Orchestrator
// Identity-gated fan-out with honest partial response assembly
// Public ID: urn:ccv3:property:veneto:<stable-id>
// Response: direct payload, no ok/data wrapper
// ═══════════════════════════════════════════════════════════════

import type { InternalCoordinates } from "./types.ts";
import {
  buildPropertyDetailResponse,
  makeUnavailableResult,
  parsePropertyUrn,
} from "./contract.ts";
import {
  resolveIdentity,
  resolveValuation,
  resolveTerritory,
  resolveSignals,
} from "./providers.ts";

export { parsePropertyUrn } from "./contract.ts";

// ── Main Assembler ────────────────────────────────────────────

export async function assemblePropertyDetail(
  coords: InternalCoordinates,
  debugId: string,
) {
  const requestedAt = new Date().toISOString();

  console.log(`[property-detail:assembler] start lat=${coords.lat} lng=${coords.lng} debug_id=${debugId}`);

  // ── Step 1: Identity is the gate ────────────────────────────
  const identityResult = await resolveIdentity(coords.lat, coords.lng, debugId);

  // If identity is not resolved, return immediately — no fan-out
  if (identityResult.outcome !== "resolved" || !identityResult.data) {
    console.log(`[property-detail:assembler] identity ${identityResult.outcome} — no fan-out debug_id=${debugId}`);

    const response = buildPropertyDetailResponse({
      coords,
      requestedAt,
      emittedAt: requestedAt,
      identityResult,
      territoryResult: makeUnavailableResult(),
      valuationResult: makeUnavailableResult(),
      signalsResult: makeUnavailableResult(),
    });

    console.log(
      `[property-detail:assembler] done resolved=[${response.meta.resolvedBlocks.join(",")}] failed=[${response.meta.failedBlocks.join(",")}] debug_id=${debugId}`,
    );

    return response;
  }

  const { comune } = identityResult.data;

  // ── Step 2: Fan-out for remaining blocks (parallel) ─────────
  const [valuationResult, territoryResult, signalsResult] = await Promise.all([
    resolveValuation(coords.lat, coords.lng, comune, debugId),
    resolveTerritory(coords.lat, coords.lng, comune, debugId),
    resolveSignals(coords.lat, coords.lng, comune, debugId),
  ]);

  const response = buildPropertyDetailResponse({
    coords,
    requestedAt,
    identityResult,
    territoryResult,
    valuationResult,
    signalsResult,
  });

  console.log(
    `[property-detail:assembler] done resolved=[${response.meta.resolvedBlocks.join(",")}] failed=[${response.meta.failedBlocks.join(",")}] debug_id=${debugId}`,
  );

  return response;
}
