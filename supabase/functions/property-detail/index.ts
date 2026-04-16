// ═══════════════════════════════════════════════════════════════
// Property Detail — Edge Function (Central Core V3)
// GET /api/v3/properties/{id}
// Veneto-scoped, identity-gated, honest partial responses
// Returns PropertyDetailResponse directly — NO ok/data wrapper
// ═══════════════════════════════════════════════════════════════

import {
  makeDebugId,
  handleOptions,
  json,
  fail,
  requireSecret,
  CORE_VERSION,
  CORE_CONTRACT,
  addIdentityHeaders,
  buildManifest,
  enforceOriginPolicy,
} from "../_shared/http.ts";

import { parsePropertyUrn, assemblePropertyDetail } from "./assembler.ts";

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════
const FUNCTION_NAME = "property-detail";
const EXPECTED_BASE_PATH = "/functions/v1/property-detail";

const ALL_ROUTES = [
  "GET /health",
  "GET /manifest",
  "GET /properties/:id",
];

// ═══════════════════════════════════════════════════════════════
// IDENTITY HELPER
// ═══════════════════════════════════════════════════════════════
function withIdentity(res: Response, route: string): Response {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

// ═══════════════════════════════════════════════════════════════
// DIRECT JSON (no ok/data wrapper) — for property detail responses
// ═══════════════════════════════════════════════════════════════
function directJson(req: Request, status: number, body: unknown, debugId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "x-debug-id": debugId,
    },
  });
}

// ═══════════════════════════════════════════════════════════════
// ERROR RESPONSES (property-detail specific, no ok/data wrapper)
// ═══════════════════════════════════════════════════════════════
function propertyError(req: Request, status: number, code: string, message: string, debugId: string): Response {
  return directJson(req, status, { error: { code, message }, debug_id: debugId }, debugId);
}

// ═══════════════════════════════════════════════════════════════
// ROUTE HELPERS
// ═══════════════════════════════════════════════════════════════

function handleHealth(req: Request, debugId: string): Response {
  // Health uses standard envelope (not property-detail contract)
  return withIdentity(
    json(req, 200, {
      status: "healthy",
      function: FUNCTION_NAME,
      version: CORE_VERSION,
      contract: CORE_CONTRACT,
      expectedBasePath: EXPECTED_BASE_PATH,
      time: new Date().toISOString(),
    }, debugId),
    "health",
  );
}

function handleManifest(req: Request, debugId: string): Response {
  const manifest = buildManifest({
    functionName: FUNCTION_NAME,
    serviceKind: "property-detail-assembler",
    expectedBasePath: EXPECTED_BASE_PATH,
    routes: ALL_ROUTES,
    callingMode: "direct",
  });
  return withIdentity(json(req, 200, manifest, debugId), "manifest");
}

/**
 * Extract property ID from pathname.
 * Supports: .../properties/{id} where id is URL-encoded
 */
function extractPropertyId(pathname: string): string | null {
  const match = pathname.match(/\/properties\/(.+?)\/?$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  const debugId = makeDebugId();
  const pathname = new URL(req.url).pathname;
  console.log(`[property-detail] method=${req.method} pathname=${pathname} debug_id=${debugId}`);

  try {
    // Origin policy
    const originBlock = enforceOriginPolicy(req, debugId);
    if (originBlock) return withIdentity(originBlock, "origin-blocked");

    // Only GET allowed
    if (req.method !== "GET") {
      return withIdentity(fail(req, 405, "METHOD_NOT_ALLOWED", "Use GET", debugId), "error");
    }

    // ── Public routes (no auth) ──
    if (pathname.endsWith("/health") || pathname === "/" || pathname === EXPECTED_BASE_PATH) {
      return handleHealth(req, debugId);
    }
    if (pathname.endsWith("/manifest")) {
      return handleManifest(req, debugId);
    }

    // ── Authenticated routes ──
    const authErr = requireSecret(req, debugId);
    if (authErr) return withIdentity(authErr, "auth-rejected");

    // ── GET /properties/{id} ──
    const propertyId = extractPropertyId(pathname);
    if (!propertyId) {
      return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `GET ${pathname} not found`, debugId), "error");
    }

    // Validate property URN
    const parseResult = parsePropertyUrn(propertyId);
    if (!parseResult.ok) {
      if (parseResult.error === "invalid_format") {
        return withIdentity(
          propertyError(req, 400, "VALIDATION_ERROR", `Invalid property id format. Expected: urn:ccv3:property:veneto:<lat>:<lng>`, debugId),
          "properties",
        );
      }
      // out_of_bounds
      return withIdentity(
        propertyError(req, 404, "PROPERTY_NOT_FOUND", `Coordinates are outside Veneto region`, debugId),
        "properties",
      );
    }

    // Assemble property detail
    const result = await assemblePropertyDetail(parseResult.coords, debugId);

    // If identity failed/unavailable, property not found
    if (!result.identity) {
      const isFailure = result.meta.failedBlocks.includes("identity");
      if (isFailure) {
        return withIdentity(
          propertyError(req, 502, "TEMPORARY_BACKEND_FAILURE", `Identity resolution failed. Reference: ${debugId}`, debugId),
          "properties",
        );
      }
      return withIdentity(
        propertyError(req, 404, "PROPERTY_NOT_FOUND", `No property data found for this location in Veneto`, debugId),
        "properties",
      );
    }

    // Return PropertyDetailResponse DIRECTLY — no ok/data wrapper
    return withIdentity(directJson(req, 200, result, debugId), "properties");

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[property-detail] Error debug_id=${debugId}: ${errMsg}`);
    return withIdentity(
      propertyError(req, 500, "INTERNAL_ERROR", `An internal error occurred. Reference: ${debugId}`, debugId),
      "error",
    );
  }
});
