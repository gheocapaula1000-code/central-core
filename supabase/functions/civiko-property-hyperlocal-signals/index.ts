// ═══════════════════════════════════════════════════════════════
// Civiko One — Hyperlocal Signals
// POST /civiko/property-hyperlocal-signals
//
// Returns matched local signals (Levels 1-3) for a property,
// with strict fact / commercialUse separation. No invented data.
// ═══════════════════════════════════════════════════════════════

import {
  makeDebugId, handleOptions, json, fail,
  CORE_VERSION, CORE_CONTRACT, addIdentityHeaders,
  buildManifest, enforceOriginPolicy,
} from "../_shared/http.ts";
import {
  sanitizeOutgoing, getServiceSupabase, isPadovaMunicipality,
  isPadovaText, isPadovaCoord, haversineMeters,
  loadActiveSignals, rowToSignal, summarizeCoverage,
  type CivikoSignal,
} from "../_shared/civiko.ts";

const FUNCTION_NAME = "civiko-property-hyperlocal-signals";
const EXPECTED_BASE_PATH = "/functions/v1/civiko-property-hyperlocal-signals";
const ROUTES = ["GET  /health", "GET  /manifest", "POST /civiko/property-hyperlocal-signals"];

interface RequestBody {
  agencyId?: string;
  propertyDraft?: { address?: string; zone?: string; title?: string; propertyType?: string };
  coordinates?: { lat?: number; lng?: number } | null;
  municipality?: string;
  neighborhood?: string;
  radiusMeters?: number;
  requestedCategories?: string[];
}

function withIdentity(res: Response, route: string) {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

function validate(raw: unknown): { ok: true; body: RequestBody } | { ok: false; message: string } {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "Body must be a JSON object." };
  }
  const b = raw as RequestBody;
  if (b.coordinates != null && typeof b.coordinates !== "object") {
    return { ok: false, message: "coordinates must be an object." };
  }
  if (b.requestedCategories != null && !Array.isArray(b.requestedCategories)) {
    return { ok: false, message: "requestedCategories must be an array." };
  }
  if (b.radiusMeters != null && (typeof b.radiusMeters !== "number" || b.radiusMeters <= 0)) {
    return { ok: false, message: "radiusMeters must be a positive number." };
  }
  return { ok: true, body: b };
}

async function handle(body: RequestBody, debugId: string) {
  const municipality = (body.municipality ?? body.propertyDraft?.zone ?? body.propertyDraft?.address ?? "").toString();
  const isPadova =
    isPadovaMunicipality(municipality) ||
    isPadovaText(body.propertyDraft?.address, body.propertyDraft?.zone) ||
    isPadovaCoord(body.coordinates?.lat, body.coordinates?.lng);

  const warnings: string[] = [];
  if (!isPadova) {
    warnings.push("Pilot V1 limitato al Comune di Padova: nessun segnale disponibile per questa area.");
    return sanitizeOutgoing({
      status: "unavailable",
      propertySummary: {
        title: body.propertyDraft?.title ?? "Immobile Reale",
        address: body.propertyDraft?.address ?? "",
        zone: body.propertyDraft?.zone ?? "",
        municipality,
      },
      matchedSignals: [] as CivikoSignal[],
      sourceCoverage: summarizeCoverage([]),
      zoneSignalSummary: "",
      warnings,
      updatedAt: new Date().toISOString(),
      referenceId: debugId,
    });
  }

  const sb = getServiceSupabase();
  if (!sb) {
    warnings.push("Fonti interne non configurate: risposta limitata.");
    return sanitizeOutgoing({
      status: "partial",
      propertySummary: { municipality, address: body.propertyDraft?.address ?? "", zone: body.propertyDraft?.zone ?? "", title: body.propertyDraft?.title ?? "Immobile Reale" },
      matchedSignals: [], sourceCoverage: summarizeCoverage([]), zoneSignalSummary: "",
      warnings, updatedAt: new Date().toISOString(), referenceId: debugId,
    });
  }

  const { signals, sources } = await loadActiveSignals(sb, "Padova");

  const lat = body.coordinates?.lat;
  const lng = body.coordinates?.lng;
  const radius = body.radiusMeters ?? 1500;
  const wanted = new Set((body.requestedCategories ?? []).map((c) => c.toLowerCase()));

  const matched: CivikoSignal[] = [];
  for (const row of signals) {
    if (wanted.size > 0 && row.category && !wanted.has(row.category.toLowerCase())) continue;

    let distance: number | null = null;
    let matchReason = "Segnale del Comune di Padova rilevante per la zona.";

    if (typeof lat === "number" && typeof lng === "number" && row.lat != null && row.lng != null) {
      distance = haversineMeters(lat, lng, row.lat, row.lng);
      const effectiveRadius = (row.radius_meters && row.radius_meters > 0) ? Math.max(radius, row.radius_meters) : radius;
      if (distance > effectiveRadius) continue;
      matchReason = `Distanza stimata ${Math.round(distance)} m dal punto indicato.`;
    } else if (body.neighborhood && row.neighborhood) {
      if (!row.neighborhood.toLowerCase().includes(body.neighborhood.toLowerCase())) continue;
      matchReason = `Segnale riferito al quartiere ${row.neighborhood}.`;
    }

    const src = row.source_id != null ? sources.get(row.source_id) : undefined;
    matched.push(rowToSignal(row, src?.source_owner ?? src?.name ?? "Fonte da Collegare", distance, matchReason));
  }

  // Sort: closer first, then high confidence first.
  matched.sort((a, b) => {
    const da = a.distanceMeters ?? Number.POSITIVE_INFINITY;
    const db = b.distanceMeters ?? Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    const order = { high: 0, medium: 1, low: 2 } as const;
    return order[a.fact.confidence] - order[b.fact.confidence];
  });

  const coverage = summarizeCoverage(signals);
  const summary = matched.length === 0
    ? "Nessun Segnale di Zona collegato in questa fase per l'area indicata."
    : `${matched.length} Segnali di Zona rilevanti per l'area indicata.`;

  return sanitizeOutgoing({
    status: matched.length > 0 ? "ok" : "partial",
    propertySummary: {
      title: body.propertyDraft?.title ?? "Immobile Reale",
      address: body.propertyDraft?.address ?? "",
      zone: body.propertyDraft?.zone ?? "",
      municipality: "Padova",
    },
    matchedSignals: matched.slice(0, 25),
    sourceCoverage: coverage,
    zoneSignalSummary: summary,
    warnings,
    updatedAt: new Date().toISOString(),
    referenceId: debugId,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = makeDebugId();
  try {
    const blocked = enforceOriginPolicy(req, debugId);
    if (blocked) return withIdentity(blocked, "origin-blocked");

    const url = new URL(req.url);
    if (req.method === "GET") {
      if (url.pathname.endsWith("/health") || url.pathname === "/" || url.pathname === EXPECTED_BASE_PATH) {
        return withIdentity(json(req, 200, {
          status: "healthy", function: FUNCTION_NAME, version: CORE_VERSION,
          contract: CORE_CONTRACT, expectedBasePath: EXPECTED_BASE_PATH, time: new Date().toISOString(),
        }, debugId), "health");
      }
      if (url.pathname.endsWith("/manifest")) {
        return withIdentity(json(req, 200, buildManifest({
          functionName: FUNCTION_NAME, serviceKind: "civiko-hyperlocal",
          expectedBasePath: EXPECTED_BASE_PATH, routes: ROUTES, callingMode: "direct",
        }), debugId), "manifest");
      }
      return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `GET ${url.pathname}`, debugId), "error");
    }
    if (req.method !== "POST") {
      return withIdentity(fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId), "error");
    }

    let raw: unknown;
    try { raw = await req.json(); }
    catch { return withIdentity(fail(req, 400, "INVALID_JSON", "Body is not valid JSON", debugId), "error"); }

    const v = validate(raw);
    if (!v.ok) return withIdentity(fail(req, 400, "INVALID_BODY", v.message, debugId), "error");

    const out = await handle(v.body, debugId);
    return withIdentity(json(req, 200, out, debugId), "hyperlocal-signals");
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] error debug_id=${debugId}: ${err instanceof Error ? err.message : String(err)}`);
    return withIdentity(json(req, 500, {
      error: { code: "INTERNAL_ERROR", message: `An internal error occurred. Reference: ${debugId}` },
      debug_id: debugId,
    }, debugId), "error");
  }
});
