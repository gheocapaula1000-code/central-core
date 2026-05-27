// civiko-tram-padova — Edge Function
// POST /functions/v1/civiko-tram-padova
// Calcola fermate tram più vicine a un punto geografico di Padova.
// Dataset statico SIR1/SIR2/SIR3. Nessuna API esterna.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  makeDebugId, handleOptions, ok, fail,
  CORE_VERSION, addIdentityHeaders, buildManifest,
} from "../_shared/http.ts";
import { sanitizeOutgoing, isPadovaCoord, haversineMeters } from "../_shared/civiko.ts";

const FUNCTION_NAME = "civiko-tram-padova";
const BASE_PATH = "/functions/v1/civiko-tram-padova";

interface TramStop {
  stopId: string;
  stopName: string;
  lat: number;
  lng: number;
  line: "SIR1" | "SIR2" | "SIR3";
  status: "operativo" | "pre_esercizio" | "in_costruzione";
  expectedOpening?: string;
}

// Dataset statico — coordinate approssimate da trampadova.it
// TODO: sostituire con coordinate ufficiali prima della produzione
const TRAM_STOPS: TramStop[] = [
  { stopId: "sir1-guizza", stopName: "Guizza", lat: 45.3728, lng: 11.8701, line: "SIR1", status: "operativo" },
  { stopId: "sir1-pontevigodarzere", stopName: "Ponte di Vigodarzere", lat: 45.3762, lng: 11.8693, line: "SIR1", status: "operativo" },
  { stopId: "sir1-bassanello", stopName: "Bassanello", lat: 45.3801, lng: 11.8688, line: "SIR1", status: "operativo" },
  { stopId: "sir1-stazione", stopName: "Stazione FS", lat: 45.3860, lng: 11.8693, line: "SIR1", status: "operativo" },
  { stopId: "sir1-tito-livio", stopName: "Tito Livio", lat: 45.3944, lng: 11.8700, line: "SIR1", status: "operativo" },
  { stopId: "sir1-pd-nord", stopName: "Padova Nord", lat: 45.4033, lng: 11.8707, line: "SIR1", status: "operativo" },
  { stopId: "sir1-arcella", stopName: "Arcella", lat: 45.4109, lng: 11.8697, line: "SIR1", status: "operativo" },
  { stopId: "sir1-cimitero", stopName: "Cimitero", lat: 45.4178, lng: 11.8688, line: "SIR1", status: "operativo" },
  { stopId: "sir1-pontevigodarzere-n", stopName: "Pontevigodarzere Nord", lat: 45.4231, lng: 11.8679, line: "SIR1", status: "operativo" },
  { stopId: "sir1-rubano", stopName: "Rubano", lat: 45.4012, lng: 11.8370, line: "SIR1", status: "operativo" },
  { stopId: "sir3-poianella", stopName: "Poianella", lat: 45.4226, lng: 11.9150, line: "SIR3", status: "pre_esercizio", expectedOpening: "2026-fine" },
  { stopId: "sir3-mandria", stopName: "Mandria", lat: 45.4198, lng: 11.9005, line: "SIR3", status: "pre_esercizio", expectedOpening: "2026-fine" },
  { stopId: "sir3-stanga", stopName: "Stanga", lat: 45.4124, lng: 11.8890, line: "SIR3", status: "pre_esercizio", expectedOpening: "2026-fine" },
  { stopId: "sir3-centro", stopName: "Centro Est", lat: 45.4064, lng: 11.8810, line: "SIR3", status: "pre_esercizio", expectedOpening: "2026-fine" },
  { stopId: "sir3-stazione-est", stopName: "Stazione Est", lat: 45.3942, lng: 11.8794, line: "SIR3", status: "pre_esercizio", expectedOpening: "2026-fine" },
  { stopId: "sir3-torre", stopName: "Torre", lat: 45.3878, lng: 11.8756, line: "SIR3", status: "pre_esercizio", expectedOpening: "2026-fine" },
  { stopId: "sir3-brenta", stopName: "Brenta", lat: 45.3812, lng: 11.8720, line: "SIR3", status: "pre_esercizio", expectedOpening: "2026-fine" },
  { stopId: "sir3-voltabarozzo", stopName: "Voltabarozzo", lat: 45.3748, lng: 11.8650, line: "SIR3", status: "pre_esercizio", expectedOpening: "2026-fine" },
  { stopId: "sir2-albignasego", stopName: "Albignasego", lat: 45.3512, lng: 11.8680, line: "SIR2", status: "in_costruzione", expectedOpening: "2027" },
  { stopId: "sir2-pontecorvo", stopName: "Pontecorvo", lat: 45.3680, lng: 11.8670, line: "SIR2", status: "in_costruzione", expectedOpening: "2027" },
  { stopId: "sir2-stadio", stopName: "Stadio", lat: 45.3784, lng: 11.8656, line: "SIR2", status: "in_costruzione", expectedOpening: "2027" },
  { stopId: "sir2-prato-della-valle", stopName: "Prato della Valle", lat: 45.3970, lng: 11.8720, line: "SIR2", status: "in_costruzione", expectedOpening: "2027" },
  { stopId: "sir2-ospedale", stopName: "Ospedale", lat: 45.4012, lng: 11.8740, line: "SIR2", status: "in_costruzione", expectedOpening: "2027" },
  { stopId: "sir2-forcellini", stopName: "Forcellini", lat: 45.4056, lng: 11.9020, line: "SIR2", status: "in_costruzione", expectedOpening: "2027" },
  { stopId: "sir2-tencarola", stopName: "Tencarola", lat: 45.4089, lng: 11.9180, line: "SIR2", status: "in_costruzione", expectedOpening: "2027" },
  { stopId: "sir2-selvazzano", stopName: "Selvazzano", lat: 45.4020, lng: 11.7980, line: "SIR2", status: "in_costruzione", expectedOpening: "2027" },
];

const LINE_META = {
  SIR1: { status: "operativo", operationalSince: "2009" },
  SIR2: { status: "in_costruzione", expectedOpening: "2027" },
  SIR3: { status: "pre_esercizio", expectedOpening: "2026-fine" },
};

serve(async (req) => {
  const debugId = makeDebugId();
  if (req.method === "OPTIONS") return handleOptions(req);

  const url = new URL(req.url);
  const path = url.pathname.replace(BASE_PATH, "") || "/";

  if (path === "/health" && req.method === "GET") {
    return addIdentityHeaders(
      ok(req, { status: "ok", function: FUNCTION_NAME, version: CORE_VERSION }, [], debugId),
      { function: FUNCTION_NAME, route: "/health" }
    );
  }

  if (path === "/manifest" && req.method === "GET") {
    return addIdentityHeaders(
      ok(req, buildManifest({
        functionName: FUNCTION_NAME,
        serviceKind: "padova-data",
        expectedBasePath: BASE_PATH,
        routes: ["GET /health", "GET /manifest", "POST /"],
      }), [], debugId),
      { function: FUNCTION_NAME, route: "/manifest" }
    );
  }

  if (req.method !== "POST") {
    return fail(req, 405, "METHOD_NOT_ALLOWED", "Usa POST", debugId);
  }

  let body: { lat?: number; lng?: number; radiusMeters?: number } = {};
  try {
    body = await req.json();
  } catch {
    return fail(req, 400, "INVALID_JSON", "Body JSON non valido", debugId);
  }

  const { lat, lng, radiusMeters = 1500 } = body;

  if (typeof lat !== "number" || typeof lng !== "number") {
    return fail(req, 400, "MISSING_COORDS", "lat e lng sono obbligatori", debugId);
  }

  if (!isPadovaCoord(lat, lng)) {
    return fail(req, 400, "OUT_OF_PADOVA", "Coordinate fuori dal Comune di Padova", debugId);
  }

  const stopsWithDistance = TRAM_STOPS.map((stop) => ({
    ...stop,
    distanceMeters: Math.round(haversineMeters(lat, lng, stop.lat, stop.lng)),
  })).filter((s) => s.distanceMeters <= radiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  const nearestByLine: Record<string, number> = {};
  for (const stop of stopsWithDistance) {
    if (!(stop.line in nearestByLine)) nearestByLine[stop.line] = stop.distanceMeters;
  }

  const warnings: string[] = [];
  if (stopsWithDistance.length === 0) {
    warnings.push("Nessuna fermata tram nel raggio indicato.");
  }
  if (nearestByLine["SIR3"]) {
    warnings.push("SIR3 in pre-esercizio nel 2026, con servizio previsto entro fine anno.");
  }
  if (nearestByLine["SIR2"]) {
    warnings.push("SIR2 in costruzione, con servizio previsto nel 2027.");
  }

  const result = sanitizeOutgoing({
    status: stopsWithDistance.length > 0 ? "ok" : "empty",
    nearestStops: stopsWithDistance.slice(0, 5),
    linesSummary: {
      SIR1: { ...LINE_META.SIR1, stopsCount: TRAM_STOPS.filter(s => s.line === "SIR1").length, nearestDistanceMeters: nearestByLine["SIR1"] ?? null },
      SIR2: { ...LINE_META.SIR2, stopsCount: TRAM_STOPS.filter(s => s.line === "SIR2").length, nearestDistanceMeters: nearestByLine["SIR2"] ?? null },
      SIR3: { ...LINE_META.SIR3, stopsCount: TRAM_STOPS.filter(s => s.line === "SIR3").length, nearestDistanceMeters: nearestByLine["SIR3"] ?? null },
    },
    warnings,
    sources: [
      { name: "Tram Padova", url: "https://www.trampadova.it" },
      { name: "Tram Padova - FAQ SIR2", url: "https://www.trampadova.it/faq/quanto-durano-i-lavori-del-sir2/" },
    ],
  });

  return addIdentityHeaders(
    ok(req, result, warnings, debugId),
    { function: FUNCTION_NAME, route: "/" }
  );
});
