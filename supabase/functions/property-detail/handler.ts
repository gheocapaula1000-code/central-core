// ═══════════════════════════════════════════════════════════════
// Property Detail — Route handler (endpoint-specific contract)
// Wrapper-free success payload + explicit endpoint error contract
// Public ID is opaque; resolution goes through the registry.
// ═══════════════════════════════════════════════════════════════

import type { InternalCoordinates, PropertyDetailResponse } from "./types.ts";
import { parsePropertyUrn } from "./contract.ts";
import type { PropertyIdRegistry } from "./registry.ts";

export type PropertyDetailAssembler = (
  coords: InternalCoordinates,
  publicId: string,
  debugId: string,
) => Promise<PropertyDetailResponse>;

export function directJson(status: number, body: unknown, debugId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "x-debug-id": debugId,
    },
  });
}

export function propertyError(status: number, code: string, message: string, debugId: string): Response {
  return directJson(status, { error: { code, message }, debug_id: debugId }, debugId);
}

export async function handlePropertyDetailLookup(
  propertyId: string,
  debugId: string,
  assemblePropertyDetail: PropertyDetailAssembler,
  registry: PropertyIdRegistry,
): Promise<Response> {
  const parseResult = await parsePropertyUrn(propertyId, registry);
  if (!parseResult.ok) {
    if (parseResult.error === "invalid_format") {
      return propertyError(
        400,
        "VALIDATION_ERROR",
        "Invalid property id format. Expected: urn:ccv3:property:veneto:<opaque-id>",
        debugId,
      );
    }
    if (parseResult.error === "unknown_id") {
      return propertyError(
        404,
        "PROPERTY_NOT_FOUND",
        "Unknown property id",
        debugId,
      );
    }
    return propertyError(
      404,
      "PROPERTY_NOT_FOUND",
      "Coordinates are outside Veneto region",
      debugId,
    );
  }

  const result = await assemblePropertyDetail(parseResult.coords, parseResult.publicId, debugId);

  if (!result.identity) {
    const isFailure = result.meta.failedBlocks.includes("identity");
    if (isFailure) {
      return propertyError(
        502,
        "TEMPORARY_BACKEND_FAILURE",
        `Identity resolution failed. Reference: ${debugId}`,
        debugId,
      );
    }
    return propertyError(
      404,
      "PROPERTY_NOT_FOUND",
      "No property data found for this location in Veneto",
      debugId,
    );
  }

  return directJson(200, result, debugId);
}
