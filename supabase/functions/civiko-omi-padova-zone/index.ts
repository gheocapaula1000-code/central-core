// civiko-omi-padova-zone — Edge Function
// POST /functions/v1/civiko-omi-padova-zone  (modalità A: trova zona da lat/lng)
// POST /functions/v1/civiko-omi-padova-zone  body: { listAll: true } (modalità B)
// GET  /functions/v1/civiko-omi-padova-zone/geojson?zoneCode=B1
// Fonte dati: Agenzia delle Entrate - OMI

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  makeDebugId, handleOptions, ok, fail,
  CORE_VERSION, addIdentityHeaders, buildManifest,
} from "../_shared/http.ts";
import { sanitizeOutgoing, isPadovaCoord, haversineMeters } from "../_shared/civiko.ts";

const FUNCTION_NAME = "civiko-omi-padova-zone";
const BASE_PATH = "/functions/v1/civiko-omi-padova-zone";
const SOURCE_OWNER = "Agenzia delle Entrate - OMI";

interface OmiZone {
  zoneCode: string;
  zoneName: string;
  centroid: { lat: number; lng: number };
  polygon: null;
  tipologie: string[];
  lastSemestre: string | null;
  quotazioniRange: { min: number; max: number; unita: "€/mq" } | null;
  sourceOwner: string;
}

// TODO: completare tutte le zone e aggiungere poligoni GeoJSON da Geopoi OMI
const OMI_ZONES: OmiZone[] = [
  { zoneCode: "B1", zoneName: "Centro Storico", centroid: { lat: 45.4064, lng: 11.8768 }, polygon: null, tipologie: ["Abitazioni civili", "Abitazioni di tipo economico", "Negozi"], lastSemestre: "2024-2", quotazioniRange: { min: 2200, max: 3800, unita: "€/mq" }, sourceOwner: SOURCE_OWNER },
  { zoneCode: "B2", zoneName: "Prato della Valle", centroid: { lat: 45.3978, lng: 11.8720 }, polygon: null, tipologie: ["Abitazioni civili", "Abitazioni di tipo economico"], lastSemestre: "2024-2", quotazioniRange: { min: 1800, max: 3000, unita: "€/mq" }, sourceOwner: SOURCE_OWNER },
  { zoneCode: "C1", zoneName: "Arcella", centroid: { lat: 45.4170, lng: 11.8680 }, polygon: null, tipologie: ["Abitazioni civili", "Abitazioni di tipo economico"], lastSemestre: "2024-2", quotazioniRange: { min: 1200, max: 2000, unita: "€/mq" }, sourceOwner: SOURCE_OWNER },
  { zoneCode: "C2", zoneName: "Stazione", centroid: { lat: 45.3855, lng: 11.8700 }, polygon: null, tipologie: ["Abitazioni civili", "Abitazioni di tipo economico", "Uffici"], lastSemestre: "2024-2", quotazioniRange: { min: 1500, max: 2500, unita: "€/mq" }, sourceOwner: SOURCE_OWNER },
  { zoneCode: "C3", zoneName: "Portello", centroid: { lat: 45.4090, lng: 11.8830 }, polygon: null, tipologie: ["Abitazioni civili", "Uffici"], lastSemestre: "2024-2", quotazioniRange: { min: 1600, max: 2600, unita: "€/mq" }, sourceOwner: SOURCE_OWNER },
  { zoneCode: "C4", zoneName: "Voltabarozzo", centroid: { lat: 45.3750, lng: 11.8820 }, polygon: null, tipologie: ["Abitazioni civili", "Abitazioni di tipo economico"], lastSemestre: "2024-2", quotazioniRange: { min: 1100, max: 1800, unita: "€/mq" }, sourceOwner: SOURCE_OWNER },
  { zoneCode: "D1", zoneName: "Forcellini", centroid: { lat: 45.4010, lng: 11.9030 }, polygon: null, tipologie: ["Abitazioni civili", "Abitazioni di tipo economico"], lastSemestre: "2024-2", quotazioniRange: { min: 1300, max: 2100, unita: "€/mq" }, sourceOwner: SOURCE_OWNER },
  { zoneCode: "D2", zoneName: "Pontevigodarzere", centroid: { lat: 45.4240, lng: 11.8690 }, polygon: null, tipologie: ["Abitazioni civili", "Abitazioni di tipo economico"], lastSemestre: "2024-2", quotazioniRange: { min: 1000, max: 1700, unita: "€/mq" }, sourceOwner: SOURCE_OWNER },
  { zoneCode: "E1", zoneName: "Guizza", centroid: { lat: 45.3730, lng: 11.8700 }, polygon: null, tipologie: ["Abitazioni civili", "Abitazioni di tipo economico"], lastSemestre: "2024-2", quotazioniRange: { min: 1100, max: 1900, unita: "€/mq" }, sourceOwner: SOURCE_OWNER },
  { zoneCode: "E2", zoneName: "Ovest / Rubano", centroid: { lat: 45.4010, lng: 11.8380 }, polygon: null, tipologie: ["Abitazioni civili", "Ville e Villini"], lastSemestre: "2024-2", quotazioniRange: { min: 1400, max: 2200, unita: "€/mq" }, sourceOwner: SOURCE_OWNER },
];

serve(async (req) => {
  const debugId = makeDebugId();
  if (req.method === "OPTIONS") return handleOptions(req);

  const url = new URL(req.url);
  const rawPath = url.pathname.replace(BASE_PATH, "") || "/";

  if (rawPath === "/health" && req.method === "GET") {
    return addIdentityHeaders(ok(req, { status: "ok", function: FUNCTION_NAME, version: CORE_VERSION }, [], debugId), { function: FUNCTION_NAME, route: "/health" });
  }
  if (rawPath === "/manifest" && req.method === "GET") {
    return addIdentityHeaders(ok(req, buildManifest({
      functionName: FUNCTION_NAME,
      serviceKind: "padova-data",
      expectedBasePath: BASE_PATH,
      routes: ["GET /health", "GET /manifest", "GET /geojson", "POST /"],
    }), [], debugId), { function: FUNCTION_NAME, route: "/manifest" });
  }

  if (rawPath === "/geojson" && req.method === "GET") {
    const zoneCode = url.searchParams.get("zoneCode");
    const zone = OMI_ZONES.find(z => z.zoneCode === zoneCode);
    if (!zone) return fail(req, 404, "ZONE_NOT_FOUND", `Zona ${zoneCode} non trovata`, debugId);
    return addIdentityHeaders(
      ok(req, { zoneCode: zone.zoneCode, zoneName: zone.zoneName, polygon: zone.polygon, note: zone.polygon ? null : "Poligono non ancora disponibile. TODO: caricare da Geopoi OMI." }, [], debugId),
      { function: FUNCTION_NAME, route: "/geojson" }
    );
  }

  if (req.method !== "POST") return fail(req, 405, "METHOD_NOT_ALLOWED", "Usa POST", debugId);

  let body: { lat?: number; lng?: number; listAll?: boolean } = {};
  try { body = await req.json(); } catch { return fail(req, 400, "INVALID_JSON", "Body JSON non valido", debugId); }

  if (body.listAll === true) {
    return addIdentityHeaders(
      ok(req, sanitizeOutgoing({
        status: "ok",
        zones: OMI_ZONES.map(z => ({ zoneCode: z.zoneCode, zoneName: z.zoneName, centroid: z.centroid, hasPolygon: false, hasOmiRange: z.quotazioniRange !== null })),
        availableZonesCount: OMI_ZONES.length,
        officialTotalCount: null,
        warnings: ["Dataset scheletro con 10 zone principali. TODO: completare le zone mancanti e aggiungere poligoni GeoJSON."],
      }), [], debugId),
      { function: FUNCTION_NAME, route: "/" }
    );
  }

  const { lat, lng } = body;
  if (typeof lat !== "number" || typeof lng !== "number") {
    return fail(req, 400, "MISSING_COORDS", "lat e lng sono obbligatori (o usa listAll: true)", debugId);
  }
  if (!isPadovaCoord(lat, lng)) {
    return fail(req, 400, "OUT_OF_PADOVA", "Coordinate fuori dal Comune di Padova", debugId);
  }

  const withDist = OMI_ZONES.map(z => ({ ...z, distMeters: haversineMeters(lat, lng, z.centroid.lat, z.centroid.lng) }));
  withDist.sort((a, b) => a.distMeters - b.distMeters);
  const nearest = withDist[0];
  const neighboring = withDist.slice(1, 4).map(z => ({ zoneCode: z.zoneCode, zoneName: z.zoneName, distanceMeters: Math.round(z.distMeters) }));

  const warnings = ["Zona identificata per prossimità al centroide. I poligoni ufficiali OMI sono in attesa di integrazione da Geopoi Agenzia delle Entrate."];

  return addIdentityHeaders(
    ok(req, sanitizeOutgoing({
      status: "partial",
      zona: {
        zoneCode: nearest.zoneCode,
        zoneName: nearest.zoneName,
        centroid: nearest.centroid,
        tipologie: nearest.tipologie,
        lastSemestre: nearest.lastSemestre,
        quotazioniRange: nearest.quotazioniRange,
        sourceOwner: nearest.sourceOwner,
      },
      neighboringZones: neighboring,
      warnings,
      sources: [
        { name: "Agenzia delle Entrate - OMI Geopoi", url: "https://www1.agenziaentrate.gov.it/servizi/geopoi_omi/index.php" },
        { name: "Dataset storico OMI onData", url: "https://github.com/ondata/quotazioni-immobiliari-agenzia-entrate" },
      ],
    }), warnings, debugId),
    { function: FUNCTION_NAME, route: "/" }
  );
});
