// ═══════════════════════════════════════════════════════════════
// Property Detail — Assembler / Orchestrator
// Identity-gated fan-out with honest partial response assembly
// ═══════════════════════════════════════════════════════════════

import type {
  ParsedPropertyId,
  PropertyDetailResponse,
  PropertyDetailMeta,
  BlockName,
  ProviderResult,
} from "./types.ts";
import { VENETO_BOUNDS, BLOCK_NAMES } from "./types.ts";
import {
  resolveIdentity,
  resolveValuation,
  resolveTerritory,
  resolveSignals,
} from "./providers.ts";

// ── Property ID Parsing ───────────────────────────────────────

export type ParseResult =
  | { ok: true; parsed: ParsedPropertyId }
  | { ok: false; error: "invalid_format" | "out_of_bounds" };

export function parsePropertyId(id: string): ParseResult {
  // Format: veneto:<lat>:<lng>
  const parts = id.split(":");
  if (parts.length !== 3 || parts[0] !== "veneto") {
    return { ok: false, error: "invalid_format" };
  }

  const lat = parseFloat(parts[1]);
  const lng = parseFloat(parts[2]);

  if (isNaN(lat) || isNaN(lng)) {
    return { ok: false, error: "invalid_format" };
  }

  if (
    lat < VENETO_BOUNDS.latMin || lat > VENETO_BOUNDS.latMax ||
    lng < VENETO_BOUNDS.lngMin || lng > VENETO_BOUNDS.lngMax
  ) {
    return { ok: false, error: "out_of_bounds" };
  }

  return { ok: true, parsed: { region: "veneto", lat, lng } };
}

// ── Block Outcome Classification ──────────────────────────────

function classifyBlock(
  name: BlockName,
  result: ProviderResult<unknown>,
  resolvedBlocks: string[],
  failedBlocks: string[],
): void {
  switch (result.outcome) {
    case "resolved":
      resolvedBlocks.push(name);
      break;
    case "failed":
      failedBlocks.push(name);
      break;
    case "unavailable":
      // Intentionally not in either list
      break;
  }
}

// ── Main Assembler ────────────────────────────────────────────

export async function assemblePropertyDetail(
  propertyId: string,
  parsed: ParsedPropertyId,
  debugId: string,
): Promise<PropertyDetailResponse> {
  const requestedAt = new Date().toISOString();
  const resolvedBlocks: string[] = [];
  const failedBlocks: string[] = [];

  console.log(`[property-detail:assembler] start id=${propertyId} lat=${parsed.lat} lng=${parsed.lng} debug_id=${debugId}`);

  // ── Step 1: Identity is the gate ────────────────────────────
  const identityResult = await resolveIdentity(parsed.lat, parsed.lng, debugId);
  classifyBlock("identity", identityResult, resolvedBlocks, failedBlocks);

  // If identity is not resolved, return immediately — no fan-out
  if (identityResult.outcome !== "resolved" || !identityResult.data) {
    console.log(`[property-detail:assembler] identity ${identityResult.outcome} — no fan-out debug_id=${debugId}`);

    const now = requestedAt;
    return {
      id: propertyId,
      meta: { requestedAt, resolvedBlocks, failedBlocks },
      identity: null,
      territory: null,
      valuation: null,
      signals: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  const { comune, provincia } = identityResult.data;

  // ── Step 2: Fan-out for remaining blocks (parallel) ─────────
  const [valuationResult, territoryResult, signalsResult] = await Promise.all([
    resolveValuation(parsed.lat, parsed.lng, comune, debugId),
    resolveTerritory(parsed.lat, parsed.lng, comune, debugId),
    resolveSignals(parsed.lat, parsed.lng, comune, debugId),
  ]);

  classifyBlock("valuation", valuationResult, resolvedBlocks, failedBlocks);
  classifyBlock("territory", territoryResult, resolvedBlocks, failedBlocks);
  classifyBlock("signals", signalsResult, resolvedBlocks, failedBlocks);

  const now = new Date().toISOString();

  console.log(`[property-detail:assembler] done resolved=[${resolvedBlocks.join(",")}] failed=[${failedBlocks.join(",")}] debug_id=${debugId}`);

  return {
    id: propertyId,
    meta: { requestedAt, resolvedBlocks, failedBlocks },
    identity: identityResult.data,
    territory: territoryResult.data,
    valuation: valuationResult.data,
    signals: signalsResult.data,
    createdAt: now,
    updatedAt: now,
  };
}
