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

import { assemblePropertyDetail } from "./assembler.ts";
import { handlePropertyDetailLookup } from "./handler.ts";

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
    const originBlock = enforceOriginPolicy(req, debugId);
    if (originBlock) return withIdentity(originBlock, "origin-blocked");

    if (req.method !== "GET") {
      return withIdentity(fail(req, 405, "METHOD_NOT_ALLOWED", "Use GET", debugId), "error");
    }

    if (pathname.endsWith("/health") || pathname === "/" || pathname === EXPECTED_BASE_PATH) {
      return handleHealth(req, debugId);
    }
    if (pathname.endsWith("/manifest")) {
      return handleManifest(req, debugId);
    }

    const authErr = requireSecret(req, debugId);
    if (authErr) return withIdentity(authErr, "auth-rejected");

    const propertyId = extractPropertyId(pathname);
    if (!propertyId) {
      return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `GET ${pathname} not found`, debugId), "error");
    }

    const response = await handlePropertyDetailLookup(propertyId, debugId, assemblePropertyDetail);
    return withIdentity(response, "properties");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[property-detail] Error debug_id=${debugId}: ${errMsg}`);
    return withIdentity(
      new Response(JSON.stringify({
        error: { code: "INTERNAL_ERROR", message: `An internal error occurred. Reference: ${debugId}` },
        debug_id: debugId,
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "x-debug-id": debugId,
        },
      }),
      "error",
    );
  }
});
