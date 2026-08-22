// ═══════════════════════════════════════════════════════════════
// Sottra — Edge Function (Central Core V3)
// Dual-engine: Motore Scan + Motore Forecast
// All routes independent — if one fails, others continue
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

// ── Scan handlers ──
import {
  handleScanIdentify,
  handleScanCadastral,
  handleScanPricing,
  handleScanListings,
  handleScanEnergy,
  handleScanCondominio,
  handleScanStoricoTransazioni,
  handleScanMarket,
  handleScanOffmarket,
  handleScanZoneIntelligence,
  handleScanPoiEnrichment,
  handleScanSave,
} from "./scan.ts";
import { handlePhotoWow } from "./photo-wow.ts";

// ── Forecast handlers ──
import {
  handleForecastMoodScore,
  handleForecastTimeView,
  handleForecastOpportunity,
  handleForecastInfrastrutture,
  handleForecastRischioZona,
  handleForecastTrendDemografico,
  handleForecastNeighborhood,
} from "./forecast.ts";

// ── Sviluppo Area handler ──
import { handleForecastSviluppoArea } from "./sviluppo-area.ts";

// ── ICTV Convergenza Territoriale handler ──
import { handleForecastConvergenzaTerritoriale } from "./convergenza-territoriale.ts";

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════
const FUNCTION_NAME = "sottra";
const EXPECTED_BASE_PATH = "/functions/v1/sottra";

// ═══════════════════════════════════════════════════════════════
// IDENTITY HELPER — consistent with ecosystem-gateway, viral-core
// ═══════════════════════════════════════════════════════════════
function withIdentity(res: Response, route: string): Response {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

// ═══════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════

const ROUTES: Record<string, (req: Request, body: Record<string, unknown>, debugId: string) => Promise<Response>> = {
  // Motore Scan (7)
  "scan/identify":             handleScanIdentify,
  "scan/photo-wow":            handlePhotoWow,
  "photo-wow":                 handlePhotoWow,
  "photoWow":                  handlePhotoWow,
  "scan/cadastral":            handleScanCadastral,
  "scan/pricing":              handleScanPricing,
  "scan/listings":             handleScanListings,
  "scan/energy":               handleScanEnergy,
  "scan/condominio":           handleScanCondominio,
  "scan/storico-transazioni":  handleScanStoricoTransazioni,
  "scan/market":               handleScanMarket,
  "scan/market-context":       handleScanMarket, // backward-compat alias
  "scan/offmarket":            handleScanOffmarket,
  "scan/zone-intelligence":    handleScanZoneIntelligence,
  "scan/poi-enrichment":         handleScanPoiEnrichment,
  "scan/save":                 handleScanSave,
  // Motore Forecast (7)
  "forecast/moodscore":        handleForecastMoodScore,
  "forecast/timeview":         handleForecastTimeView,
  "forecast/opportunity":      handleForecastOpportunity,
  "forecast/infrastrutture":   handleForecastInfrastrutture,
  "forecast/rischio-zona":     handleForecastRischioZona,
  "forecast/trend-demografico": handleForecastTrendDemografico,
  "forecast/neighborhood":     handleForecastNeighborhood,
  "forecast/sviluppo-area":    handleForecastSviluppoArea,
  // Motore ICTV (1)
  "forecast/convergenza-territoriale": handleForecastConvergenzaTerritoriale,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  const debugId = makeDebugId();
  const pathname = new URL(req.url).pathname;
  console.log(`[sottra] method=${req.method} pathname=${pathname} debug_id=${debugId}`);

  try {
    // Origin policy — consistent with ecosystem-gateway, viral-core
    const originBlock = enforceOriginPolicy(req, debugId);
    if (originBlock) return withIdentity(originBlock, "origin-blocked");

    // Manifest endpoint — public, no auth
    if (req.method === "GET" && pathname.endsWith("/manifest")) {
      const manifest = buildManifest({
        functionName: FUNCTION_NAME,
        serviceKind: "sottra-service",
        expectedBasePath: EXPECTED_BASE_PATH,
        routes: [
          "GET /health",
          "GET /manifest",
          ...Object.keys(ROUTES).map(r => `POST /${r}`),
        ],
        callingMode: "direct",
      });
      return withIdentity(ok(req, manifest, [], debugId), "manifest");
    }

    // Health check — no auth
    if (req.method === "GET" && (pathname.endsWith("/health") || pathname === "/")) {
      return withIdentity(ok(req, {
        status: "healthy",
        engine: "sottra",
        version: CORE_VERSION,
        contract: CORE_CONTRACT,
        function: FUNCTION_NAME,
        expectedBasePath: EXPECTED_BASE_PATH,
        routes: Object.keys(ROUTES),
        time: new Date().toISOString(),
      }, [], debugId), "health");
    }

    // Auth
    const authErr = requireSecret(req, debugId);
    if (authErr) return withIdentity(authErr, "auth-rejected");

    if (req.method !== "POST") {
      return withIdentity(fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId), "error");
    }

    // Parse body
    const rawBody = await req.text();
    if (rawBody.length > 500_000) {
      return withIdentity(fail(req, 413, "PAYLOAD_TOO_LARGE", "Request body exceeds 500KB", debugId), "error");
    }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(rawBody); } catch {
      return withIdentity(fail(req, 400, "INVALID_JSON", "Body must be valid JSON", debugId), "error");
    }

    // Route matching: find the matching suffix
    for (const [route, handler] of Object.entries(ROUTES)) {
      if (pathname.endsWith(`/${route}`) || pathname.endsWith(`/${route}/`)) {
        console.log(`[sottra] route=${route} debug_id=${debugId}`);
        const res = await handler(req, body, debugId);
        return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
      }
    }

    return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `No handler for ${pathname}. Available: ${Object.keys(ROUTES).join(", ")}`, debugId), "error");

  } catch (err) {
    // Security: never leak stack traces or internal details to user-facing payload
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[sottra] Error debug_id=${debugId}:`, errMsg);
    return withIdentity(fail(req, 500, "INTERNAL_ERROR", `An internal error occurred. Reference: ${debugId}`, debugId), "error");
  }
});
