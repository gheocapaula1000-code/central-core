// ═══════════════════════════════════════════════════════════════
// Property Detail — Edge Function (Central Core V3)
// GET /api/v3/properties/{id}
// Veneto-scoped, identity-gated, honest partial responses
// ═══════════════════════════════════════════════════════════════

import {
  makeDebugId,
  handleOptions,
  ok,
  fail,
  requireSecret,
  CORE_VERSION,
  CORE_CONTRACT,
  addIdentityHeaders,
  buildManifest,
  enforceOriginPolicy,
} from "../_shared/http.ts";

import { parsePropertyId } from "./assembler.ts";
import { assemblePropertyDetail } from "./assembler.ts";

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
// ROUTE HELPERS
// ═══════════════════════════════════════════════════════════════

function handleHealth(req: Request, debugId: string): Response {
  return withIdentity(
    ok(req, {
      status: "healthy",
      function: FUNCTION_NAME,
      version: CORE_VERSION,
      contract: CORE_CONTRACT,
      expectedBasePath: EXPECTED_BASE_PATH,
      time: new Date().toISOString(),
    }, [], debugId),
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
  return withIdentity(ok(req, manifest, [], debugId), "manifest");
}

/**
 * Extract property ID from pathname.
 * Supports: .../properties/{id} where id is URL-encoded
 */
function extractPropertyId(pathname: string): string | null {
  // Match /properties/{id} at the end of the path
  const match = pathname.match(/\/properties\/([^/]+)\/?$/);
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

    // Validate property ID
    const parseResult = parsePropertyId(propertyId);
    if (!parseResult.ok) {
      if (parseResult.error === "invalid_format") {
        return withIdentity(
          fail(req, 400, "VALIDATION_ERROR", `Invalid property id format. Expected: veneto:<lat>:<lng>`, debugId),
          "properties",
        );
      }
      // out_of_bounds → coordinates outside Veneto
      return withIdentity(
        fail(req, 404, "PROPERTY_NOT_FOUND", `Coordinates are outside Veneto region`, debugId),
        "properties",
      );
    }

    // Assemble property detail
    const result = await assemblePropertyDetail(propertyId, parseResult.parsed, debugId);

    // If identity failed/unavailable after assembly, it means property not found in our data
    if (!result.identity) {
      const isFailure = result.meta.failedBlocks.includes("identity");
      if (isFailure) {
        return withIdentity(
          fail(req, 502, "TEMPORARY_BACKEND_FAILURE", `Identity resolution failed. Reference: ${debugId}`, debugId),
          "properties",
        );
      }
      return withIdentity(
        fail(req, 404, "PROPERTY_NOT_FOUND", `No property data found for this location in Veneto`, debugId),
        "properties",
      );
    }

    // Determine warnings from unavailable/failed blocks
    const warnings: string[] = [];
    for (const block of ["valuation", "territory", "signals"] as const) {
      if (result.meta.failedBlocks.includes(block)) {
        warnings.push(`${block} block failed`);
      } else if (!result.meta.resolvedBlocks.includes(block)) {
        warnings.push(`${block} block unavailable`);
      }
    }

    return withIdentity(ok(req, result, warnings, debugId), "properties");

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[property-detail] Error debug_id=${debugId}: ${errMsg}`);
    return withIdentity(
      fail(req, 500, "INTERNAL_ERROR", `An internal error occurred. Reference: ${debugId}`, debugId),
      "error",
    );
  }
});
