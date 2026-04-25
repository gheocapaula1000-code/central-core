// ═══════════════════════════════════════════════════════════════
// Civiko One — Zona in Movimento
// POST /civiko/property-zona-in-movimento
// ═══════════════════════════════════════════════════════════════

import {
  makeDebugId, handleOptions, json, fail,
  CORE_VERSION, CORE_CONTRACT, addIdentityHeaders,
  buildManifest, enforceOriginPolicy,
} from "../_shared/http.ts";
import {
  sanitizeOutgoing, getServiceSupabase, isPadovaMunicipality, isPadovaText, isPadovaCoord,
  loadActiveSignals, rowToSignal, summarizeCoverage,
  type LocalSignalRow,
} from "../_shared/civiko.ts";

const FUNCTION_NAME = "civiko-property-zona-in-movimento";
const EXPECTED_BASE_PATH = "/functions/v1/civiko-property-zona-in-movimento";
const ROUTES = ["GET  /health", "GET  /manifest", "POST /civiko/property-zona-in-movimento"];

interface RequestBody {
  agencyId?: string;
  propertyDraft?: { address?: string; zone?: string; title?: string };
  coordinates?: { lat?: number; lng?: number } | null;
  municipality?: string;
  neighborhood?: string;
}

const STRONG_CATEGORIES = new Set(["tram", "cantiere", "mobilità", "mobilita", "viabilità", "viabilita", "riqualificazione", "lavori_pubblici", "piano_interventi"]);
const ATTENTION_CATEGORIES = new Set(["rumore", "parcheggi", "ztl", "ordinanza"]);
const FUTURE_CATEGORIES = new Set(["tram", "riqualificazione", "studentati", "area_dismessa", "lavori_pubblici", "piano_interventi"]);

function withIdentity(res: Response, route: string) {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

function classify(signals: LocalSignalRow[]) {
  const strong: LocalSignalRow[] = [];
  const attention: LocalSignalRow[] = [];
  const future: LocalSignalRow[] = [];
  for (const s of signals) {
    const cat = (s.category ?? "").toLowerCase();
    if (STRONG_CATEGORIES.has(cat) && (s.signal_tone === "positive" || s.signal_tone === "neutral" || s.signal_tone === "mixed")) strong.push(s);
    if (ATTENTION_CATEGORIES.has(cat) || s.signal_tone === "negative") attention.push(s);
    if (FUTURE_CATEGORIES.has(cat)) future.push(s);
  }
  return { strong, attention, future };
}

async function handle(body: RequestBody, debugId: string) {
  const municipality = (body.municipality ?? body.propertyDraft?.zone ?? body.propertyDraft?.address ?? "").toString();
  const isPadova =
    isPadovaMunicipality(municipality) ||
    isPadovaText(body.propertyDraft?.address, body.propertyDraft?.zone) ||
    isPadovaCoord(body.coordinates?.lat, body.coordinates?.lng);

  const baseAreaLabel = body.neighborhood ? `${body.neighborhood}, Padova` : (isPadova ? "Padova" : municipality || "Area indicata");

  if (!isPadova) {
    return sanitizeOutgoing({
      profileId: debugId,
      title: "Zona in Movimento",
      areaLabel: baseAreaLabel,
      strongSignals: [], attentionSignals: [], futureNarrative: [],
      ownerTalkingPoints: [], buyerTalkingPoints: [],
      sourceCoverage: summarizeCoverage([]),
      warnings: ["Pilot V1 limitato al Comune di Padova."],
      updatedAt: new Date().toISOString(),
    });
  }

  const sb = getServiceSupabase();
  if (!sb) {
    return sanitizeOutgoing({
      profileId: debugId, title: "Zona in Movimento", areaLabel: baseAreaLabel,
      strongSignals: [], attentionSignals: [], futureNarrative: [],
      ownerTalkingPoints: [], buyerTalkingPoints: [],
      sourceCoverage: summarizeCoverage([]),
      warnings: ["Fonti interne non configurate: risposta limitata."],
      updatedAt: new Date().toISOString(),
    });
  }

  const { signals, sources } = await loadActiveSignals(sb, "Padova");
  const filtered = body.neighborhood
    ? signals.filter((s) => !s.neighborhood || s.neighborhood.toLowerCase().includes(body.neighborhood!.toLowerCase()))
    : signals;

  const { strong, attention, future } = classify(filtered);
  const ownerHooks = [
    "Portare nella Presentazione Proprietario i Segnali di Zona documentabili.",
    "Mostrare il contesto delle Fonti Dure prima delle leve narrative.",
    "Preparare una risposta preventiva per ogni segnale di attenzione.",
  ];
  const buyerHooks = [
    "Raccontare l'accessibilità futura con prudenza, senza promettere risultati.",
    "Usare i Segnali di Zona come elementi di contesto, non come previsioni.",
  ];

  const toSig = (rows: LocalSignalRow[]) => rows.slice(0, 8).map((r) => {
    const src = r.source_id != null ? sources.get(r.source_id) : undefined;
    return rowToSignal(r, src?.source_owner ?? src?.name ?? "Fonte da Collegare");
  });

  return sanitizeOutgoing({
    profileId: debugId,
    title: "Zona in Movimento",
    areaLabel: baseAreaLabel,
    strongSignals: toSig(strong),
    attentionSignals: toSig(attention),
    futureNarrative: toSig(future),
    ownerTalkingPoints: ownerHooks,
    buyerTalkingPoints: buyerHooks,
    sourceCoverage: summarizeCoverage(filtered),
    warnings: filtered.length === 0 ? ["Nessun segnale collegato per l'area indicata."] : [],
    updatedAt: new Date().toISOString(),
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
        return withIdentity(json(req, 200, { status: "healthy", function: FUNCTION_NAME, version: CORE_VERSION, contract: CORE_CONTRACT, expectedBasePath: EXPECTED_BASE_PATH, time: new Date().toISOString() }, debugId), "health");
      }
      if (url.pathname.endsWith("/manifest")) {
        return withIdentity(json(req, 200, buildManifest({ functionName: FUNCTION_NAME, serviceKind: "civiko-zona-in-movimento", expectedBasePath: EXPECTED_BASE_PATH, routes: ROUTES, callingMode: "direct" }), debugId), "manifest");
      }
      return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `GET ${url.pathname}`, debugId), "error");
    }
    if (req.method !== "POST") return withIdentity(fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId), "error");

    let raw: unknown;
    try { raw = await req.json(); }
    catch { return withIdentity(fail(req, 400, "INVALID_JSON", "Body is not valid JSON", debugId), "error"); }
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
      return withIdentity(fail(req, 400, "INVALID_BODY", "Body must be a JSON object.", debugId), "error");
    }
    const out = await handle(raw as RequestBody, debugId);
    return withIdentity(json(req, 200, out, debugId), "zona-in-movimento");
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] error debug_id=${debugId}: ${err instanceof Error ? err.message : String(err)}`);
    return withIdentity(json(req, 500, { error: { code: "INTERNAL_ERROR", message: `An internal error occurred. Reference: ${debugId}` }, debug_id: debugId }, debugId), "error");
  }
});
