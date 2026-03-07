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
} from "./scan.ts";

// ── Forecast handlers ──
import {
  handleForecastMoodScore,
  handleForecastTimeView,
  handleForecastOpportunity,
  handleForecastInfrastrutture,
  handleForecastRischioZona,
  handleForecastTrendDemografico,
} from "./forecast.ts";

// ═══════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════

const ROUTES: Record<string, (req: Request, body: Record<string, unknown>, debugId: string) => Promise<Response>> = {
  // Motore Scan (7)
  "scan/identify":             handleScanIdentify,
  "scan/cadastral":            handleScanCadastral,
  "scan/pricing":              handleScanPricing,
  "scan/listings":             handleScanListings,
  "scan/energy":               handleScanEnergy,
  "scan/condominio":           handleScanCondominio,
  "scan/storico-transazioni":  handleScanStoricoTransazioni,
  // Motore Forecast (6)
  "forecast/moodscore":        handleForecastMoodScore,
  "forecast/timeview":         handleForecastTimeView,
  "forecast/opportunity":      handleForecastOpportunity,
  "forecast/infrastrutture":   handleForecastInfrastrutture,
  "forecast/rischio-zona":     handleForecastRischioZona,
  "forecast/trend-demografico": handleForecastTrendDemografico,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  const debugId = makeDebugId();
  const pathname = new URL(req.url).pathname;
  console.log(`[sottra] method=${req.method} pathname=${pathname} debug_id=${debugId}`);

  try {
    // Health check — no auth
    if (req.method === "GET" && (pathname.endsWith("/health") || pathname === "/")) {
      return ok(req, {
        status: "healthy",
        engine: "sottra",
        version: CORE_VERSION,
        routes: Object.keys(ROUTES),
        time: new Date().toISOString(),
      }, [], debugId);
    }

    // Auth
    const authErr = requireSecret(req, debugId);
    if (authErr) return authErr;

    if (req.method !== "POST") {
      return fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId);
    }

    // Parse body
    const rawBody = await req.text();
    if (rawBody.length > 500_000) {
      return fail(req, 413, "PAYLOAD_TOO_LARGE", "Request body exceeds 500KB", debugId);
    }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(rawBody); } catch {
      return fail(req, 400, "INVALID_JSON", "Body must be valid JSON", debugId);
    }

    // Route matching: find the matching suffix
    for (const [route, handler] of Object.entries(ROUTES)) {
      if (pathname.endsWith(`/${route}`) || pathname.endsWith(`/${route}/`)) {
        console.log(`[sottra] route=${route} debug_id=${debugId}`);
        return await handler(req, body, debugId);
      }
    }

    return fail(req, 404, "ROUTE_NOT_FOUND", `No handler for ${pathname}. Available: ${Object.keys(ROUTES).join(", ")}`, debugId);

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[sottra] Error debug_id=${debugId}:`, errMsg);
    return fail(req, 500, "INTERNAL_ERROR", `An internal error occurred. Reference: ${debugId}`, debugId);
  }
});
