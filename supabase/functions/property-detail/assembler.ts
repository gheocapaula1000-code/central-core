// ═══════════════════════════════════════════════════════════════
// Property Detail — Assembler / Orchestrator
// Identity-gated fan-out with honest partial response assembly
// Public ID: urn:ccv3:property:veneto:<stable-id>
// Response: direct payload, no ok/data wrapper
// ═══════════════════════════════════════════════════════════════

import type {
  InternalCoordinates,
  PropertyDetailResponse,
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

// ── Internal Coordinate Parsing ───────────────────────────────

export type ParseResult =
  | { ok: true; coords: InternalCoordinates }
  | { ok: false; error: "invalid_format" | "out_of_bounds" };

/**
 * Parse internal coordinate lookup from the URN tail.
 * Accepts: urn:ccv3:property:veneto:<lat>:<lng>  (coordinate-based lookup)
 * Also accepts shorter stable IDs — but for Phase 1 only coordinate lookup is supported.
 */
export function parsePropertyUrn(urn: string): ParseResult {
  // Expected: urn:ccv3:property:veneto:<lat>:<lng>
  const parts = urn.split(":");
  if (parts.length < 4 || parts[0] !== "urn" || parts[1] !== "ccv3" || parts[2] !== "property" || parts[3] !== "veneto") {
    return { ok: false, error: "invalid_format" };
  }

  // Coordinate lookup: urn:ccv3:property:veneto:<lat>:<lng>
  if (parts.length === 6) {
    const lat = parseFloat(parts[4]);
    const lng = parseFloat(parts[5]);
    if (isNaN(lat) || isNaN(lng)) {
      return { ok: false, error: "invalid_format" };
    }
    if (
      lat < VENETO_BOUNDS.latMin || lat > VENETO_BOUNDS.latMax ||
      lng < VENETO_BOUNDS.lngMin || lng > VENETO_BOUNDS.lngMax
    ) {
      return { ok: false, error: "out_of_bounds" };
    }
    return { ok: true, coords: { lat, lng } };
  }

  return { ok: false, error: "invalid_format" };
}

// ── Stable Public ID Generation ───────────────────────────────

async function generateStableId(comune: string, lat: number, lng: number): Promise<string> {
  const seed = `${comune.toLowerCase()}:${lat.toFixed(6)}:${lng.toFixed(6)}`;
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(seed));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
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
  coords: InternalCoordinates,
  debugId: string,
): Promise<PropertyDetailResponse> {
  const requestedAt = new Date().toISOString();
  const resolvedBlocks: string[] = [];
  const failedBlocks: string[] = [];

  console.log(`[property-detail:assembler] start lat=${coords.lat} lng=${coords.lng} debug_id=${debugId}`);

  // ── Step 1: Identity is the gate ────────────────────────────
  const identityResult = await resolveIdentity(coords.lat, coords.lng, debugId);
  classifyBlock("identity", identityResult, resolvedBlocks, failedBlocks);

  // If identity is not resolved, return immediately — no fan-out
  if (identityResult.outcome !== "resolved" || !identityResult.data) {
    console.log(`[property-detail:assembler] identity ${identityResult.outcome} — no fan-out debug_id=${debugId}`);

    // Generate a coordinate-based fallback ID
    const fallbackId = `urn:ccv3:property:veneto:${coords.lat.toFixed(6)}_${coords.lng.toFixed(6)}`;
    const now = requestedAt;
    return {
      id: fallbackId,
      meta: { requestedAt, resolvedBlocks, failedBlocks },
      identity: null,
      territory: null,
      valuation: null,
      signals: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  const { comune } = identityResult.data;

  // Generate stable public ID from resolved identity
  const stableHash = await generateStableId(comune, coords.lat, coords.lng);
  const publicId = `urn:ccv3:property:veneto:${stableHash}`;

  // ── Step 2: Fan-out for remaining blocks (parallel) ─────────
  const [valuationResult, territoryResult, signalsResult] = await Promise.all([
    resolveValuation(coords.lat, coords.lng, comune, debugId),
    resolveTerritory(coords.lat, coords.lng, comune, debugId),
    resolveSignals(coords.lat, coords.lng, comune, debugId),
  ]);

  classifyBlock("valuation", valuationResult, resolvedBlocks, failedBlocks);
  classifyBlock("territory", territoryResult, resolvedBlocks, failedBlocks);
  classifyBlock("signals", signalsResult, resolvedBlocks, failedBlocks);

  const now = new Date().toISOString();

  console.log(`[property-detail:assembler] done resolved=[${resolvedBlocks.join(",")}] failed=[${failedBlocks.join(",")}] debug_id=${debugId}`);

  return {
    id: publicId,
    meta: { requestedAt, resolvedBlocks, failedBlocks },
    identity: identityResult.data,
    territory: territoryResult.data,
    valuation: valuationResult.data,
    signals: signalsResult.data,
    createdAt: now,
    updatedAt: now,
  };
}
