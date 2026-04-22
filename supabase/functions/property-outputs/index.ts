// ═══════════════════════════════════════════════════════════════
// Property Outputs — Edge Function (Central Core V3)
// POST /generate
// Body: { audience, families[], detail: PropertyDetailIn }
// Returns: { propertyId, audience, documents[], generatedAt }
//
// Pure transformation over property-detail data. No external calls.
// All overclaim guards live in language.ts; this file only routes.
// ═══════════════════════════════════════════════════════════════

import {
  CORE_CONTRACT,
  addIdentityHeaders,
  buildManifest,
  enforceOriginPolicy,
  fail,
  handleOptions,
  json,
  makeDebugId,
  ok,
  requireSecret,
} from "../_shared/http.ts";

import { generateDocument } from "./generators.ts";
import {
  ALL_FAMILIES,
  type Audience,
  type GenerateOutputsRequest,
  type GenerateOutputsResponse,
  type OutputFamily,
} from "./types.ts";

const FUNCTION_NAME = "property-outputs";
const EXPECTED_BASE_PATH = "/functions/v1/property-outputs";
const MAX_BODY_BYTES = 500_000;

const ALL_ROUTES = ["GET /health", "GET /manifest", "POST /generate"];

function withIdentity(res: Response, route: string): Response {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

function isAudience(x: unknown): x is Audience {
  return x === "agency" || x === "client";
}
function isFamily(x: unknown): x is OutputFamily {
  return typeof x === "string" && (ALL_FAMILIES as string[]).includes(x);
}

function validate(body: unknown): { ok: true; req: GenerateOutputsRequest } | { ok: false; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, reason: "body must be an object" };
  const b = body as Record<string, unknown>;
  if (!isAudience(b.audience)) return { ok: false, reason: "audience must be 'agency' or 'client'" };
  if (!Array.isArray(b.families) || b.families.length === 0) {
    return { ok: false, reason: "families must be a non-empty array" };
  }
  for (const f of b.families) {
    if (!isFamily(f)) return { ok: false, reason: `unknown family: ${String(f)}` };
  }
  if (!b.detail || typeof b.detail !== "object") return { ok: false, reason: "detail is required" };
  const d = b.detail as Record<string, unknown>;
  if (typeof d.id !== "string" || d.id.length === 0) return { ok: false, reason: "detail.id is required" };
  return { ok: true, req: body as GenerateOutputsRequest };
}

export function handleGenerate(req: GenerateOutputsRequest): GenerateOutputsResponse {
  const documents = req.families.map((f) => generateDocument(f, req.audience, req.detail));
  return {
    propertyId: req.detail.id,
    audience: req.audience,
    documents,
    generatedAt: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = makeDebugId();
  const pathname = new URL(req.url).pathname;
  console.log(`[property-outputs] method=${req.method} pathname=${pathname} debug_id=${debugId}`);

  try {
    const originBlock = enforceOriginPolicy(req, debugId);
    if (originBlock) return withIdentity(originBlock, "origin-blocked");

    if (req.method === "GET") {
      if (pathname.endsWith("/manifest")) {
        const manifest = buildManifest({
          functionName: FUNCTION_NAME,
          serviceKind: "property-output-orchestrator",
          expectedBasePath: EXPECTED_BASE_PATH,
          routes: ALL_ROUTES,
          callingMode: "direct",
        });
        return withIdentity(json(req, 200, manifest, debugId), "manifest");
      }
      if (
        pathname.endsWith("/health") || pathname === "/" ||
        pathname.endsWith(EXPECTED_BASE_PATH)
      ) {
        return withIdentity(
          json(req, 200, {
            status: "healthy",
            function: FUNCTION_NAME,
            contract: CORE_CONTRACT,
            families: ALL_FAMILIES,
          }, debugId),
          "health",
        );
      }
      return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `GET ${pathname} not found`, debugId), "error");
    }

    if (req.method !== "POST") {
      return withIdentity(fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId), "error");
    }

    const authErr = requireSecret(req, debugId);
    if (authErr) return withIdentity(authErr, "auth-rejected");

    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) {
      return withIdentity(fail(req, 413, "PAYLOAD_TOO_LARGE", "Request body exceeds 500KB", debugId), "error");
    }
    let body: unknown = {};
    if (raw) {
      try { body = JSON.parse(raw); } catch {
        return withIdentity(fail(req, 400, "INVALID_JSON", "Body must be valid JSON", debugId), "error");
      }
    }

    if (!pathname.endsWith("/generate")) {
      return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `POST ${pathname} not found`, debugId), "error");
    }

    const v = validate(body);
    if (!v.ok) {
      return withIdentity(fail(req, 400, "VALIDATION_ERROR", v.reason, debugId), "error");
    }

    const out = handleGenerate(v.req);
    return withIdentity(ok(req, out, [], debugId), "generate");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[property-outputs] Error debug_id=${debugId}: ${msg}`);
    return withIdentity(fail(req, 500, "INTERNAL_ERROR", `An internal error occurred. Reference: ${debugId}`, debugId), "error");
  }
});
