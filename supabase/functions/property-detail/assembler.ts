// ═══════════════════════════════════════════════════════════════
// Property Detail — Assembler / Orchestrator
// Identity-gated fan-out with honest partial response assembly.
// Receives the already-resolved opaque public ID from the handler.
// Response: direct payload, no ok/data wrapper.
// ═══════════════════════════════════════════════════════════════

import type { InternalCoordinates, PropertyDetailResponse } from "./types.ts";
import {
  buildPropertyDetailResponse,
  makeUnavailableResult,
} from "./contract.ts";
import {
  resolveIdentity,
  resolveValuation,
  resolveTerritory,
  resolveSignals,
} from "./providers.ts";

export { parsePropertyUrn } from "./contract.ts";

export async function assemblePropertyDetail(
  coords: InternalCoordinates,
  publicId: string,
  debugId: string,
): Promise<PropertyDetailResponse> {
  const requestedAt = new Date().toISOString();

  console.log(`[property-detail:assembler] start id=${publicId} debug_id=${debugId}`);

  const { result: identityResult, context: identityContext } = await resolveIdentity(coords.lat, coords.lng, debugId);

  if (identityResult.outcome !== "resolved" || !identityContext) {
    console.log(`[property-detail:assembler] identity ${identityResult.outcome} — no fan-out debug_id=${debugId}`);
    const response = buildPropertyDetailResponse({
      publicId,
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

  const [valuationResult, territoryResult, signalsResult] = await Promise.all([
    resolveValuation(identityContext, debugId),
    resolveTerritory(identityContext, debugId),
    resolveSignals(identityContext, debugId),
  ]);

  const response = buildPropertyDetailResponse({
    publicId,
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
