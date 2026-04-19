// ═══════════════════════════════════════════════════════════════
// Property Detail — Public contract helpers
// Reusable public ID encoding/decoding + response assembly
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

export type ParseResult =
  | {
    ok: true;
    coords: InternalCoordinates;
    publicId: string;
    inputKind: "public_id" | "legacy_coordinates";
  }
  | { ok: false; error: "invalid_format" | "out_of_bounds" };

const PROPERTY_URN_PREFIX = "urn:ccv3:property:veneto:";
const STABLE_ID_VERSION = "v1";
const COORDINATE_SCALE = 100000;

function isWithinVeneto(coords: InternalCoordinates): boolean {
  return coords.lat >= VENETO_BOUNDS.latMin &&
    coords.lat <= VENETO_BOUNDS.latMax &&
    coords.lng >= VENETO_BOUNDS.lngMin &&
    coords.lng <= VENETO_BOUNDS.lngMax;
}

function checksumFor(latScaled: number, lngScaled: number): string {
  const input = `${STABLE_ID_VERSION}:${latScaled}:${lngScaled}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0").slice(0, 7);
}

function encodeStableTail(coords: InternalCoordinates): string {
  const latScaled = Math.round(coords.lat * COORDINATE_SCALE);
  const lngScaled = Math.round(coords.lng * COORDINATE_SCALE);
  const checksum = checksumFor(latScaled, lngScaled);
  return `${STABLE_ID_VERSION}_${latScaled.toString(36)}_${lngScaled.toString(36)}_${checksum}`;
}

function decodeStableTail(stableTail: string): ParseResult {
  const match = /^v1_([0-9a-z]+)_([0-9a-z]+)_([0-9a-z]+)$/i.exec(stableTail);
  if (!match) return { ok: false, error: "invalid_format" };

  const latScaled = Number.parseInt(match[1], 36);
  const lngScaled = Number.parseInt(match[2], 36);
  const checksum = match[3].toLowerCase();
  if (!Number.isFinite(latScaled) || !Number.isFinite(lngScaled)) {
    return { ok: false, error: "invalid_format" };
  }

  if (checksumFor(latScaled, lngScaled) != checksum) {
    return { ok: false, error: "invalid_format" };
  }

  const coords = {
    lat: latScaled / COORDINATE_SCALE,
    lng: lngScaled / COORDINATE_SCALE,
  };

  if (!isWithinVeneto(coords)) {
    return { ok: false, error: "out_of_bounds" };
  }

  return {
    ok: true,
    coords,
    publicId: encodePublicPropertyId(coords),
    inputKind: "public_id",
  };
}

function parseLegacyCoordinateUrn(parts: string[]): ParseResult {
  if (parts.length !== 6) return { ok: false, error: "invalid_format" };

  const lat = Number.parseFloat(parts[4]);
  const lng = Number.parseFloat(parts[5]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: "invalid_format" };
  }

  const coords = { lat, lng };
  if (!isWithinVeneto(coords)) {
    return { ok: false, error: "out_of_bounds" };
  }

  return {
    ok: true,
    coords,
    publicId: encodePublicPropertyId(coords),
    inputKind: "legacy_coordinates",
  };
}

export function encodePublicPropertyId(coords: InternalCoordinates): string {
  if (!isWithinVeneto(coords)) {
    throw new Error("Cannot encode property id outside Veneto bounds");
  }
  return `${PROPERTY_URN_PREFIX}${encodeStableTail(coords)}`;
}

export function parsePropertyUrn(urn: string): ParseResult {
  const parts = urn.split(":");
  if (parts.length < 5 || parts[0] !== "urn" || parts[1] !== "ccv3" || parts[2] !== "property" || parts[3] !== "veneto") {
    return { ok: false, error: "invalid_format" };
  }

  if (parts.length === 5) {
    return decodeStableTail(parts[4]);
  }

  return parseLegacyCoordinateUrn(parts);
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
  coords: InternalCoordinates;
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
    id: encodePublicPropertyId(params.coords),
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
