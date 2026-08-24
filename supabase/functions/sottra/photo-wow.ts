// Sottra — photoWow / photo+GPS official report
//
// Live Sottra PWA calls Core core-proxy with endpoint /civiko-property-from-photo.
// This handler is the Sottra-specific path: official OMI / ISTAT / OSM
// (Nominatim address + Overpass named POIs) where sources respond,
// otherwise honest unavailable. Never invents civic truth, names, or scores.
// Energy / catasto / listings are not promoted to official.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { json, fail } from "../_shared/http.ts";
import { handleScanIdentify, handleScanPricing } from "./scan.ts";
import { lookupOsmNeighborhoodPois, type OsmPoiResult } from "./osm-poi.ts";

const POLYGON_COVERAGE_NOTE =
  "omi_zone_geometry su Central Core è un campione (decine di poligoni), non il set nazionale (~27k). " +
  "Il match poligono è usato solo quando esiste. Altrimenti si usano omi_zone + omi_valori a livello comune/zona, senza overclaim.";

type Qualita = "ottima" | "buona" | "minima";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function parsePhotoWowInput(body: Record<string, unknown>): {
  lat: number | null;
  lng: number | null;
  photo: string;
  address: string;
} {
  const geo = asRecord(body.geo);
  const photoObj = asRecord(body.photo);
  const photos = Array.isArray(body.photos) ? body.photos : [];
  const firstPhoto = photos.length > 0 ? asRecord(photos[0]) : null;

  const lat = num(body.lat) ?? num(geo?.latitude);
  const lng = num(body.lng) ?? num(geo?.longitude);

  let photo = "";
  if (typeof body.photo === "string") photo = body.photo;
  else if (photoObj && typeof photoObj.dataUrl === "string") photo = photoObj.dataUrl;
  else if (firstPhoto && typeof firstPhoto.dataUrl === "string") photo = firstPhoto.dataUrl;

  const address = str(body.address) || str(geo?.manualAddress);
  return { lat, lng, photo, address };
}

async function readEnvelope(res: Response): Promise<Record<string, unknown> | null> {
  const raw = await res.json().catch(() => null);
  const parsed = asRecord(raw);
  if (!parsed) return null;
  const inner = asRecord(parsed.data);
  return inner ?? parsed;
}

async function lookupIstat(comune: string): Promise<Record<string, unknown>> {
  const empty = {
    found: false,
    sourceType: "unavailable" as const,
    sourceLabel: "ISTAT — Popolazione residente",
    popolazione: null,
    etaMedia: null,
    percentualeOver65: null,
    percentualeUnder35: null,
    anno: null,
    limitations: ["Dato ISTAT non interrogato: comune mancante"],
  };
  if (!comune) return empty;

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) {
    return { ...empty, limitations: ["ISTAT non interrogabile: configurazione servizio incompleta"] };
  }

  try {
    const supabase = createClient(url, key);
    const { data, error } = await supabase
      .from("istat_comuni")
      .select("comune, popolazione, eta_media, percentuale_over65, percentuale_under35, anno")
      .ilike("comune", comune)
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      return {
        ...empty,
        limitations: [`Comune "${comune}" non presente nel dataset ISTAT importato`],
      };
    }
    return {
      found: true,
      sourceType: "official",
      sourceLabel: "ISTAT — Popolazione residente al 1° gennaio 2025",
      sourcePeriod: data.anno != null ? `Anno ${data.anno}` : "2025",
      comune: data.comune ?? comune,
      popolazione: data.popolazione ?? null,
      etaMedia: data.eta_media ?? null,
      percentualeOver65: data.percentuale_over65 ?? null,
      percentualeUnder35: data.percentuale_under35 ?? null,
      anno: data.anno ?? null,
      limitations: ["Dati ISTAT a livello comunale (non di quartiere)"],
    };
  } catch {
    return { ...empty, limitations: ["Errore nella lettura ISTAT"] };
  }
}

function unavailableModule(label: string, reason: string): Record<string, unknown> {
  return {
    sourceType: "unavailable",
    sourceLabel: label,
    limitations: [reason],
  };
}

function contestoFromPois(poi: OsmPoiResult): Record<string, unknown> {
  if (!poi.found || poi.totalPois === 0) {
    return {
      sourceType: "unavailable",
      sourceLabel: poi.sourceLabel,
      elencoServiziRilevati: [],
      presenzaServiziRilevati: false,
      limitations: poi.limitations,
    };
  }
  return {
    sourceType: "official",
    sourceLabel: poi.sourceLabel,
    presenzaServiziRilevati: true,
    elencoServiziRilevati: poi.elencoServiziRilevati,
    categorie: poi.categories,
    byTipo: poi.byTipo,
    searchRadius: poi.searchRadius,
    totalPois: poi.totalPois,
    limitations: poi.limitations,
  };
}

function qualitaFromPricing(sourceType: unknown, matchMethod: unknown, polygonMatch: unknown): Qualita {
  if (sourceType === "official" && (polygonMatch === true || matchMethod === "single_zone")) return "ottima";
  if (sourceType === "official" || sourceType === "elaborated") return "buona";
  return "minima";
}

/** POST /sottra/scan/photo-wow — photo + GPS → official-backed report */
export async function handlePhotoWow(
  req: Request,
  body: Record<string, unknown>,
  debugId: string,
): Promise<Response> {
  const started = Date.now();
  const input = parsePhotoWowInput(body);
  if (input.lat == null || input.lng == null) {
    return fail(req, 400, "MISSING_COORDS", "Provide lat/lng or geo.latitude/geo.longitude", debugId);
  }

  const identifyRes = await handleScanIdentify(req, {
    lat: input.lat,
    lng: input.lng,
    photo: input.photo,
    address: input.address || undefined,
  }, debugId);
  const identify = await readEnvelope(identifyRes);
  const geo = asRecord(identify?.geoResolution);
  const photoAnalysis = asRecord(asRecord(identify?.streetEvidence)?.photoAnalysis);

  const resolvedAddress = str(identify?.address) || input.address;
  const resolvedComune = str(geo?.resolvedComune);
  const resolvedProvincia = str(geo?.resolvedProvincia);

  const pricingRes = await handleScanPricing(req, {
    lat: input.lat,
    lng: input.lng,
    address: resolvedAddress,
    comune: resolvedComune || undefined,
  }, debugId);
  const pricing = await readEnvelope(pricingRes) ?? {
    prezzoMq: null,
    prezzoMqMin: null,
    prezzoMqMax: null,
    sourceType: "unavailable",
    omiMatchMethod: "none",
    polygonMatch: false,
    limitations: ["Pricing non disponibile"],
  };

  const [istat, poiEnrichment] = await Promise.all([
    lookupIstat(resolvedComune || extractComuneLoose(resolvedAddress)),
    lookupOsmNeighborhoodPois(input.lat, input.lng), // Overpass primary; Nominatim search fallback
  ]);

  const osmAvailable = Boolean(resolvedAddress);
  const osm = {
    found: osmAvailable || poiEnrichment.found,
    sourceType: osmAvailable || poiEnrichment.found ? "official" : "unavailable",
    sourceLabel: "OpenStreetMap / Nominatim — reverse geocoding",
    address: resolvedAddress || null,
    comune: resolvedComune || null,
    provincia: resolvedProvincia || null,
    street: str(geo?.resolvedStreet) || null,
    houseNumber: str(geo?.resolvedHouseNumber) || null,
    postalCode: str(geo?.resolvedPostalCode) || null,
    poi: poiEnrichment,
    limitations: [
      ...(osmAvailable
        ? ["Indirizzo da geocoding OSM — non è un identificativo catastale"]
        : ["Indirizzo OSM non risolto"]),
      ...poiEnrichment.limitations,
    ],
  };

  const energy = unavailableModule(
    "APE / prestazione energetica",
    "Classe energetica non ufficiale su questo path — resta estimated/unavailable, mai official",
  );
  const cadastral = unavailableModule(
    "Catasto / ANNCSU",
    "Catasto e ANNCSU non sono inventati e non sono collegati su questo path",
  );
  const listings = unavailableModule(
    "Annunci immobiliari",
    "Annunci (AI/Apify) non sono promossi a official — non interrogati sul path photoWow",
  );

  const sourceType = str(pricing.sourceType) || "unavailable";
  const fontiUsate: string[] = [];
  if (sourceType === "official" || sourceType === "elaborated") {
    fontiUsate.push("Agenzia delle Entrate — OMI");
  }
  if (osmAvailable) fontiUsate.push("OpenStreetMap / Nominatim");
  if (poiEnrichment.found) {
    fontiUsate.push(
      poiEnrichment.sourceProvider === "nominatim"
        ? "OpenStreetMap / Nominatim — servizi di prossimità (fallback)"
        : "OpenStreetMap / Overpass",
    );
  }
  if (istat.found) fontiUsate.push("ISTAT");

  const warnings: string[] = [];
  if (sourceType !== "official") {
    warnings.push("Prezzo OMI non etichettato official: match spaziale assente o zona non unica.");
  }
  if (!pricing.polygonMatch) {
    warnings.push(POLYGON_COVERAGE_NOTE);
  }
  if (!istat.found) warnings.push("ISTAT comunale non disponibile per questo punto.");
  if (!osmAvailable) warnings.push("Indirizzo OSM non risolto.");
  if (!poiEnrichment.found) {
    warnings.push("Servizi di vicinato OSM non disponibili — elenco non inventato.");
  }

  const officialQuotes = Array.isArray(pricing.quotes) ? pricing.quotes : [];
  const officialLinkZona = str(pricing.link_zona) || null;
  const officialSemestre = str(pricing.semestre) || str(pricing.sourcePeriod) || null;

  const zona = {
    nomeComune: str(pricing.comune) || resolvedComune || null,
    provincia: resolvedProvincia || null,
    nomeZonaOmi: str(pricing.zona) || str(pricing.areaName) || null,
    fascia: str(pricing.zonaDescrizione) || null,
    officialMicrozona: str(pricing.officialMicrozona) || null,
    areaId: str(pricing.areaId) || null,
    valoreMinOmi: num(pricing.prezzoMqMin),
    valoreMaxOmi: num(pricing.prezzoMqMax),
    tendenzaMercato: null,
    classificazioneZona: str(pricing.pricingPrecisionLabel) || null,
    sentimentResidenti: null,
    livelloSentiment: null,
    sourceType,
    omiMatchMethod: str(pricing.omiMatchMethod) || "none",
    polygonMatch: pricing.polygonMatch === true,
    omiGeoLevel: str(pricing.omiGeoLevel) || "none",
    sourceCoverageLevel: str(pricing.sourceCoverageLevel) || "none",
    sourceLabel: str(pricing.sourceLabel) || "Agenzia delle Entrate — Osservatorio Mercato Immobiliare",
    sourcePeriod: str(pricing.sourcePeriod) || "1° semestre 2025",
    quotes: officialQuotes,
    link_zona: officialLinkZona,
    semestre: officialSemestre,
  };

  const immobile = {
    address: resolvedAddress || null,
    buildingId: identify?.buildingId ?? null,
    confidence: identify?.confidence ?? null,
    tipologiaProbabile: str(photoAnalysis?.buildingType) || null,
    pianoStimato: photoAnalysis?.visibleFloors ?? null,
    statoApparente: null,
    puntiDiForzaVisivi: [] as string[],
    materialePresunto: null,
    annoPresunto: null,
  };

  const wowProjection = {
    immobile,
    zona,
    quotes: officialQuotes,
    link_zona: officialLinkZona,
    semestre: officialSemestre,
    scores: {
      vendibilita: null,
      opportunitaInvestimento: null,
      pressioneEreditaria: null,
      sourceType: "unavailable",
      limitations: ["Nessun punteggio inventato — scores non sono dati ufficiali"],
    },
    liveSignals: [] as unknown[],
    territorialDocuments: [] as unknown[],
    poiEnrichment,
    elencoServiziRilevati: poiEnrichment.elencoServiziRilevati,
    contestoVicinato: contestoFromPois(poiEnrichment),
    zonaIntelligence: {
      notizieRecenti: [] as unknown[],
      puntiDiForzaNascosti: [] as string[],
      criticitaEmergenti: [] as string[],
      tendenzaMercato: null,
      sourceType: "unavailable",
      limitations: ["Intelligence di zona non ufficiale su questo path"],
    },
    vendutoRecente: [] as unknown[],
    mappaCaloreUrl: null,
    pianoEsclusiva: null,
    qualita: qualitaFromPricing(sourceType, pricing.omiMatchMethod, pricing.polygonMatch),
    tempoElaborazione: Date.now() - started,
    fontiUsate,
  };

  const report = {
    identify,
    pricing,
    istat,
    osm,
    poi: poiEnrichment,
    poiEnrichment,
    elencoServiziRilevati: poiEnrichment.elencoServiziRilevati,
    energy,
    cadastral,
    listings,
    polygonCoverage: {
      available: pricing.polygonMatch === true,
      note: POLYGON_COVERAGE_NOTE,
    },
    ...wowProjection,
  };

  // Dual contract: standard Sottra envelope in `data`, plus top-level PhotoWow
  // aliases so the live PWA that does not unwrap `{ ok, data }` still reads zona.
  return json(req, 200, {
    ok: true,
    data: report,
    warnings,
    debug_id: debugId,
    ...wowProjection,
  }, debugId);
}

function extractComuneLoose(address: string): string {
  if (!address) return "";
  const cleaned = address.replace(/\b\d{5}\b/g, "").trim();
  const parts = cleaned.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && /^ital/i.test(parts[parts.length - 1])) parts.pop();
  const last = parts[parts.length - 1] ?? "";
  return last.replace(/\s+[A-Z]{2}$/, "").trim();
}
