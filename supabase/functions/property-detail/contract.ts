// ═══════════════════════════════════════════════════════════════
// Property Detail — Public contract helpers
// Opaque public ID encoding + response assembly
// The public ID is NOT derivable from coordinates.
// ═══════════════════════════════════════════════════════════════

import type {
  BlockName,
  IdentityBlock,
  InternalCoordinates,
  PropertyDetailResponse,
  ProviderResult,
  SignalsBlock,
  TerritoryBlock,
  ValuationBlock,
} from "./types.ts";
import { VENETO_BOUNDS } from "./types.ts";
import {
  OPAQUE_TOKEN_PATTERN,
  type PropertyIdRegistry,
} from "./registry.ts";

const PROPERTY_URN_PREFIX = "urn:ccv3:property:veneto:";

export type ParseError = "invalid_format" | "unknown_id" | "out_of_bounds";

export type ParseResult =
  | {
    ok: true;
    coords: InternalCoordinates;
    publicId: string;
    inputKind: "opaque_id" | "legacy_coordinates";
  }
  | { ok: false; error: ParseError };

function isWithinVeneto(coords: InternalCoordinates): boolean {
  return coords.lat >= VENETO_BOUNDS.latMin &&
    coords.lat <= VENETO_BOUNDS.latMax &&
    coords.lng >= VENETO_BOUNDS.lngMin &&
    coords.lng <= VENETO_BOUNDS.lngMax;
}

function buildPublicUrn(opaqueId: string): string {
  return `${PROPERTY_URN_PREFIX}${opaqueId}`;
}

/**
 * Mint or look up the opaque public URN for a coordinate pair.
 * Coordinates must be inside Veneto bounds.
 */
export async function encodePublicPropertyId(
  coords: InternalCoordinates,
  registry: PropertyIdRegistry,
): Promise<string> {
  if (!isWithinVeneto(coords)) {
    throw new Error("Cannot encode property id outside Veneto bounds");
  }
  const opaqueId = await registry.getOrCreateOpaqueId(coords);
  return buildPublicUrn(opaqueId);
}

/**
 * Parse a property URN.
 * Primary contract: opaque token (`urn:ccv3:property:veneto:<16-char-token>`).
 * Compatibility-only: legacy coordinate URN (`urn:ccv3:property:veneto:<lat>:<lng>`).
 */
export async function parsePropertyUrn(
  urn: string,
  registry: PropertyIdRegistry,
): Promise<ParseResult> {
  const parts = urn.split(":");
  if (
    parts.length < 5 ||
    parts[0] !== "urn" ||
    parts[1] !== "ccv3" ||
    parts[2] !== "property" ||
    parts[3] !== "veneto"
  ) {
    return { ok: false, error: "invalid_format" };
  }

  // Opaque public ID — primary contract.
  if (parts.length === 5) {
    const token = parts[4];
    if (!OPAQUE_TOKEN_PATTERN.test(token)) {
      return { ok: false, error: "invalid_format" };
    }
    const coords = await registry.resolveOpaqueId(token);
    if (!coords) return { ok: false, error: "unknown_id" };
    if (!isWithinVeneto(coords)) return { ok: false, error: "out_of_bounds" };
    return {
      ok: true,
      coords,
      publicId: buildPublicUrn(token),
      inputKind: "opaque_id",
    };
  }

  // Legacy coordinate URN — compatibility-only input path.
  // Public output is still the opaque URN (minted from coordinates).
  if (parts.length === 6) {
    const lat = Number.parseFloat(parts[4]);
    const lng = Number.parseFloat(parts[5]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { ok: false, error: "invalid_format" };
    }
    const coords = { lat, lng };
    if (!isWithinVeneto(coords)) return { ok: false, error: "out_of_bounds" };
    const publicId = await encodePublicPropertyId(coords, registry);
    return { ok: true, coords, publicId, inputKind: "legacy_coordinates" };
  }

  return { ok: false, error: "invalid_format" };
}

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
      break;
  }
}

export function buildPropertyDetailResponse(params: {
  publicId: string;
  requestedAt: string;
  emittedAt?: string;
  identityResult: ProviderResult<IdentityBlock>;
  territoryResult: ProviderResult<TerritoryBlock>;
  valuationResult: ProviderResult<ValuationBlock>;
  signalsResult: ProviderResult<SignalsBlock>;
}): PropertyDetailResponse {
  const resolvedBlocks: string[] = [];
  const failedBlocks: string[] = [];

  classifyBlock("identity", params.identityResult, resolvedBlocks, failedBlocks);
  classifyBlock("territory", params.territoryResult, resolvedBlocks, failedBlocks);
  classifyBlock("valuation", params.valuationResult, resolvedBlocks, failedBlocks);
  classifyBlock("signals", params.signalsResult, resolvedBlocks, failedBlocks);

  const emittedAt = params.emittedAt ?? new Date().toISOString();

  return {
    id: params.publicId,
    meta: {
      requestedAt: params.requestedAt,
      resolvedBlocks,
      failedBlocks,
    },
    identity: params.identityResult.data,
    territory: params.territoryResult.data,
    valuation: params.valuationResult.data,
    signals: params.signalsResult.data,
    createdAt: emittedAt,
    updatedAt: emittedAt,
  };
}

export function makeUnavailableResult<T>(): ProviderResult<T> {
  return { outcome: "unavailable", data: null, provenance: null };
}
