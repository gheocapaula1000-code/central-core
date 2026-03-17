// ═══════════════════════════════════════════════════════════════
// EcoSystem Gateway — Edge Function (Central Core V3)
// Additive orchestrator — fail-safe, no PWA coupling
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

import { matchServices } from "./catalog.ts";
import { enrichFromSottra } from "./internal.ts";
import { buildExecutiveSummary, buildTechnicalSheet, buildTerritorialContext, buildAvailabilityFlags } from "./normalizers.ts";
import type { ListingEnrichmentRequest, ServicePackRequest, UnifiedReportRequest } from "./types.ts";

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════
const FUNCTION_NAME = "ecosystem-gateway";
const EXPECTED_BASE_PATH = "/functions/v1/ecosystem-gateway";
const MAX_BODY_BYTES = 500_000;

const ALL_ROUTES = [
  "GET /",
  "GET /health",
  "GET /__health",
  "GET /manifest",
  "GET /capabilities",
  "POST /listing-enrichment",
  "POST /service-pack",
  "POST /unified-report",
];

// ═══════════════════════════════════════════════════════════════
// IDENTITY HELPER
// ═══════════════════════════════════════════════════════════════
function withIdentity(res: Response, route: string): Response {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

// ═══════════════════════════════════════════════════════════════
// GET HANDLERS
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
    serviceKind: "ecosystem-orchestrator",
    expectedBasePath: EXPECTED_BASE_PATH,
    routes: ALL_ROUTES,
    callingMode: "direct",
  });
  return withIdentity(ok(req, manifest, [], debugId), "manifest");
}

function handleCapabilities(req: Request, debugId: string): Response {
  return withIdentity(
    ok(req, {
      status: "ok",
      function: FUNCTION_NAME,
      version: CORE_VERSION,
      modules: [
        {
          id: "listing-enrichment",
          enabled: true,
          requiresPwaChanges: false,
          hardDependencies: [],
          bestEffortDependencies: ["sottra/scan/market", "sottra/forecast/sviluppo-area"],
        },
        {
          id: "service-pack",
          enabled: true,
          requiresPwaChanges: false,
          hardDependencies: [],
          bestEffortDependencies: [],
        },
        {
          id: "unified-report",
          enabled: true,
          requiresPwaChanges: false,
          hardDependencies: [],
          bestEffortDependencies: [],
        },
      ],
      nonGoals: [
        "no direct PWA coupling",
        "no DB sharing across apps",
        "no blocking of KeyDraft fast path",
      ],
    }, [], debugId),
    "capabilities",
  );
}

// ═══════════════════════════════════════════════════════════════
// POST HANDLERS
// ═══════════════════════════════════════════════════════════════

async function handleListingEnrichment(req: Request, body: ListingEnrichmentRequest, debugId: string): Promise<Response> {
  if (!body.property || typeof body.property !== "object") {
    return withIdentity(fail(req, 400, "MISSING_PROPERTY", "property object is required", debugId), "listing-enrichment");
  }

  const prop = body.property;
  const options = body.options ?? {};
  const warnings: string[] = [];

  // Enrich via Sottra (best-effort)
  const enrichment = await enrichFromSottra(req.url, prop, options, debugId);
  warnings.push(...enrichment.warnings);

  const anyAvailable = enrichment.availability.market || enrichment.availability.areaDevelopment;
  const enrichmentStatus = anyAvailable
    ? (enrichment.availability.market && enrichment.availability.areaDevelopment ? "available" : "partial")
    : "unavailable";

  const sourceApps: string[] = [];
  if (body.source_app) sourceApps.push(body.source_app);
  if (anyAvailable) sourceApps.push("sottra");

  const data = {
    enrichment_status: enrichmentStatus,
    partial: enrichmentStatus !== "available",
    property_snapshot: prop,
    sottra_market: enrichment.sottra_market,
    sottra_area_development: enrichment.sottra_area_development,
    availability: enrichment.availability,
    source_apps: sourceApps,
    warnings_detail: warnings,
  };

  return withIdentity(ok(req, data, warnings, debugId), "listing-enrichment");
}

function handleServicePack(req: Request, body: ServicePackRequest, debugId: string): Response {
  const services = matchServices(body.context);
  const data = {
    recommended_services: services,
    count: services.length,
  };
  return withIdentity(ok(req, data, [], debugId), "service-pack");
}

function handleUnifiedReport(req: Request, body: UnifiedReportRequest, debugId: string): Response {
  const { keydraft, enrichment, servicePack, options } = body;
  const warnings: string[] = [];

  const executiveSummary = options?.includeExecutiveSummary
    ? buildExecutiveSummary(keydraft, enrichment, servicePack)
    : null;

  const technicalSheet = buildTechnicalSheet(keydraft);
  const territorialContext = buildTerritorialContext(enrichment);
  const availabilityFlags = buildAvailabilityFlags(keydraft, enrichment, servicePack);

  if (!technicalSheet) warnings.push("keydraft section unavailable");
  if (!territorialContext) warnings.push("enrichment/territorial section unavailable");
  if (!servicePack) warnings.push("service_pack section unavailable");

  const hasSomething = technicalSheet || territorialContext || servicePack;

  const data: Record<string, unknown> = {
    availability_flags: availabilityFlags,
    partial: !technicalSheet || !territorialContext || !servicePack,
  };
  if (executiveSummary) data.executive_summary = executiveSummary;
  if (technicalSheet) data.technical_sheet = technicalSheet;
  if (territorialContext) data.territorial_context = territorialContext;
  if (servicePack) data.service_pack = servicePack;

  return withIdentity(ok(req, data, warnings, debugId), "unified-report");
}

// ═══════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  const debugId = makeDebugId();
  const pathname = new URL(req.url).pathname;
  console.log(`[ecosystem-gateway] method=${req.method} pathname=${pathname} debug_id=${debugId}`);

  try {
    // Origin policy
    const originBlock = enforceOriginPolicy(req, debugId);
    if (originBlock) return withIdentity(originBlock, "origin-blocked");

    // ── GET routes (public, no auth) ──
    if (req.method === "GET") {
      if (pathname.endsWith("/manifest")) return handleManifest(req, debugId);
      if (pathname.endsWith("/capabilities")) return handleCapabilities(req, debugId);
      if (pathname.endsWith("/health") || pathname.endsWith("/__health") || pathname === "/" || pathname.endsWith(`${EXPECTED_BASE_PATH}`)) {
        return handleHealth(req, debugId);
      }
      return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `GET ${pathname} not found`, debugId), "error");
    }

    // ── POST routes (auth required) ──
    if (req.method !== "POST") {
      return withIdentity(fail(req, 405, "METHOD_NOT_ALLOWED", "Use GET or POST", debugId), "error");
    }

    const authErr = requireSecret(req, debugId);
    if (authErr) return authErr;

    // Parse body
    const rawBody = await req.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      return withIdentity(fail(req, 413, "PAYLOAD_TOO_LARGE", "Request body exceeds 500KB", debugId), "error");
    }

    let body: Record<string, unknown> = {};
    if (rawBody) {
      try { body = JSON.parse(rawBody); } catch {
        return withIdentity(fail(req, 400, "INVALID_JSON", "Body must be valid JSON", debugId), "error");
      }
    }

    // Route matching
    if (pathname.endsWith("/listing-enrichment")) {
      return await handleListingEnrichment(req, body as unknown as ListingEnrichmentRequest, debugId);
    }
    if (pathname.endsWith("/service-pack")) {
      return handleServicePack(req, body as unknown as ServicePackRequest, debugId);
    }
    if (pathname.endsWith("/unified-report")) {
      return handleUnifiedReport(req, body as unknown as UnifiedReportRequest, debugId);
    }

    return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `POST ${pathname} not found`, debugId), "error");

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[ecosystem-gateway] Error debug_id=${debugId}:`, errMsg);
    return withIdentity(fail(req, 500, "INTERNAL_ERROR", `An internal error occurred. Reference: ${debugId}`, debugId), "error");
  }
});
