// civiko-places-padova — Edge Function
// POST /functions/v1/civiko-places-padova  route: "autocomplete"
// POST /functions/v1/civiko-places-padova  route: "place-details"
// Wrapper Google Places API limitato al Comune di Padova.
// Il token GOOGLE_MAPS_API_KEY non viene mai esposto alla PWA.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  makeDebugId, handleOptions, ok, fail,
  CORE_VERSION, addIdentityHeaders, buildManifest,
} from "../_shared/http.ts";
import { sanitizeOutgoing, PADOVA_BBOX } from "../_shared/civiko.ts";

const FUNCTION_NAME = "civiko-places-padova";
const BASE_PATH = "/functions/v1/civiko-places-padova";
const TIMEOUT_MS = 6000;

const PADOVA_BOUNDS = `${PADOVA_BBOX.minLat},${PADOVA_BBOX.minLng}|${PADOVA_BBOX.maxLat},${PADOVA_BBOX.maxLng}`;

serve(async (req) => {
  const debugId = makeDebugId();
  if (req.method === "OPTIONS") return handleOptions(req);

  const url = new URL(req.url);
  const path = url.pathname.replace(BASE_PATH, "") || "/";

  if (path === "/health" && req.method === "GET") {
    return addIdentityHeaders(ok(req, { status: "ok", function: FUNCTION_NAME, version: CORE_VERSION }, [], debugId), { function: FUNCTION_NAME, route: "/health" });
  }
  if (path === "/manifest" && req.method === "GET") {
    return addIdentityHeaders(ok(req, buildManifest({
      functionName: FUNCTION_NAME,
      serviceKind: "padova-places",
      expectedBasePath: BASE_PATH,
      routes: ["GET /health", "GET /manifest", "POST /"],
    }), [], debugId), { function: FUNCTION_NAME, route: "/manifest" });
  }

  if (req.method !== "POST") return fail(req, 405, "METHOD_NOT_ALLOWED", "Usa POST", debugId);

  const apiKey = Deno.env.get("GOOGLE_MAPS_API_KEY") ?? "";
  if (!apiKey || apiKey === "NOT_CONFIGURED") {
    return fail(req, 503, "PLACES_NOT_CONFIGURED", "Google Places non configurato. Aggiungi GOOGLE_MAPS_API_KEY nei segreti Supabase.", debugId);
  }

  let body: { route?: string; input?: string; placeId?: string } = {};
  try { body = await req.json(); } catch { return fail(req, 400, "INVALID_JSON", "Body JSON non valido", debugId); }

  const { route, input, placeId } = body;

  if (route === "autocomplete") {
    if (!input || input.trim().length < 3) {
      return fail(req, 400, "INPUT_TOO_SHORT", "Inserisci almeno 3 caratteri", debugId);
    }
    const params = new URLSearchParams({
      input: `${input.trim()}, Padova`,
      key: apiKey,
      language: "it",
      components: "country:it",
      bounds: PADOVA_BOUNDS,
      types: "address",
    });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const res = await fetch(`https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return fail(req, 502, "PLACES_ERROR", "Errore Google Places", debugId);
      const data = await res.json();
      const predictions = (data.predictions ?? []).map((p: Record<string, unknown>) => ({
        placeId: p.place_id,
        description: p.description,
        mainText: (p.structured_formatting as Record<string, unknown>)?.main_text ?? p.description,
        secondaryText: (p.structured_formatting as Record<string, unknown>)?.secondary_text ?? "",
      }));
      return addIdentityHeaders(ok(req, sanitizeOutgoing({ status: "ok", predictions }), [], debugId), { function: FUNCTION_NAME, route: "/autocomplete" });
    } catch {
      return fail(req, 504, "PLACES_TIMEOUT", "Google Places non risponde. Riprova tra qualche istante.", debugId);
    }
  }

  if (route === "place-details") {
    if (!placeId) return fail(req, 400, "MISSING_PLACE_ID", "placeId obbligatorio", debugId);
    const params = new URLSearchParams({
      place_id: placeId,
      key: apiKey,
      language: "it",
      fields: "place_id,name,formatted_address,geometry,address_components",
    });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const res = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?${params}`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return fail(req, 502, "PLACES_ERROR", "Errore Google Places", debugId);
      const data = await res.json();
      const r = data.result;
      if (!r) return fail(req, 404, "PLACE_NOT_FOUND", "Indirizzo non trovato", debugId);
      const loc = r.geometry?.location;
      return addIdentityHeaders(
        ok(req, sanitizeOutgoing({
          status: "ok",
          placeId: r.place_id,
          formattedAddress: r.formatted_address,
          lat: loc?.lat ?? null,
          lng: loc?.lng ?? null,
          addressComponents: r.address_components ?? [],
        }), [], debugId),
        { function: FUNCTION_NAME, route: "/place-details" }
      );
    } catch {
      return fail(req, 504, "PLACES_TIMEOUT", "Google Places non risponde. Riprova tra qualche istante.", debugId);
    }
  }

  return fail(req, 400, "UNKNOWN_ROUTE", "route deve essere 'autocomplete' o 'place-details'", debugId);
});
