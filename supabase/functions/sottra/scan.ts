// Sottra — Motore Scan handlers (8 endpoints)
// POLICY: Only real data from official sources. No AI-invented results.
// DATA RIGOR: No fake mediaZona, no hardcoded trend5Anni, confidence-gated pricing.
// Uses unified PUBLICATION_POLICY from shared.ts.

import { ok, fail } from "../_shared/http.ts";
import { callAI, callAIVision, parseJSON, reverseGeocode, classifyOMIPricing, PUBLICATION_POLICY } from "./shared.ts";
import { lookupOMI, lookupOMIByCoordinates, type OMIResult } from "./omi-lookup.ts";
import { resolveGeo, type GeoResolutionResult } from "./geo-resolution.ts";
import { collectStreetEvidence, type StreetEvidenceMergeResult } from "./street-evidence.ts";
import { collectMarketData, MARKET_DATA_POLICY, type MarketContextResult } from "./market-data.ts";

/** POST /sottra/scan/identify — photo + GPS → address + building ID + street evidence */
export async function handleScanIdentify(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  const photo = (body.photo as string) ?? "";
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  // Phase 1: Multi-provider geo resolution (with basic photo hint for civico)
  let basicPhotoEvidence: { visibleHouseNumber?: string; visibleStreetName?: string; confidence?: number } | undefined;
  if (photo && photo.startsWith("data:image")) {
    try {
      const output = await callAIVision(
        `Stai guardando la foto di un edificio. Rispondi SOLO in JSON: { "confidence": numero_da_0_a_1, "visibleHouseNumber": civico_visibile_o_null, "visibleStreetName": nome_via_visibile_o_null }`,
        photo, 100, 0.1
      );
      const parsed = parseJSON(output);
      if (parsed) {
        basicPhotoEvidence = {
          visibleHouseNumber: (parsed.visibleHouseNumber as string) ?? undefined,
          visibleStreetName: (parsed.visibleStreetName as string) ?? undefined,
          confidence: (parsed.confidence as number) ?? undefined,
        };
      }
    } catch { /* photo hint optional */ }
  }

  const geo = await resolveGeo(lat, lng, basicPhotoEvidence);

  if (!geo.resolvedAddress) {
    // Fallback to legacy reverseGeocode if all providers fail
    const legacyAddress = await reverseGeocode(lat, lng);
    if (!legacyAddress) return fail(req, 502, "GEOCODE_FAILED", "Could not resolve coordinates to address", debugId);

    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(legacyAddress));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const buildingId = "IT-" + hashArray.slice(0, 4).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();

    return ok(req, {
      address: legacyAddress,
      buildingId,
      confidence: 0.50,
      geoResolution: null,
      streetEvidence: null,
    }, ["Geo resolution fallback — solo Nominatim legacy"], debugId);
  }

  // Phase 2: Street Evidence — deep photo analysis + provider signals
  let streetEvidence: StreetEvidenceMergeResult | null = null;
  try {
    streetEvidence = await collectStreetEvidence(
      lat, lng,
      photo || null,
      geo.geoConfidence,
      geo.geoMatchLevel,
      geo.resolvedStreet,
      geo.resolvedHouseNumber,
    );
  } catch (e) {
    console.warn(`[scan/identify] Street evidence collection failed: ${String(e).slice(0, 80)}`);
    // Non-fatal — continue without street evidence
  }

  // Use final identity confidence if street evidence available, otherwise geo confidence
  const finalConfidence = streetEvidence?.finalIdentityConfidence ?? geo.geoConfidence;

  // Build stable buildingId from resolved address
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(geo.resolvedAddress));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const buildingId = "IT-" + hashArray.slice(0, 4).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();

  return ok(req, {
    address: geo.resolvedAddress,
    buildingId,
    confidence: finalConfidence,
    // Enriched geo resolution payload (audit-ready)
    geoResolution: {
      resolvedComune: geo.resolvedComune,
      resolvedProvincia: geo.resolvedProvincia,
      resolvedStreet: geo.resolvedStreet,
      resolvedHouseNumber: geo.resolvedHouseNumber,
      resolvedPostalCode: geo.resolvedPostalCode,
      resolvedLat: geo.resolvedLat,
      resolvedLng: geo.resolvedLng,
      geoConfidence: geo.geoConfidence,
      geoConfidenceReason: geo.geoConfidenceReason,
      geoMatchLevel: geo.geoMatchLevel,
      providerConsensus: geo.providerConsensus,
      providerBreakdown: geo.providerBreakdown,
      publicationEligible: geo.publicationEligible,
      eligibleModuleClasses: geo.eligibleModuleClasses,
    },
    // Street evidence payload (audit-ready, no raw images)
    streetEvidence: streetEvidence ? {
      streetEvidenceConfidence: streetEvidence.streetEvidenceConfidence,
      streetEvidenceReason: streetEvidence.streetEvidenceReason,
      houseNumberConfirmed: streetEvidence.houseNumberConfirmed,
      streetConfirmed: streetEvidence.streetConfirmed,
      facadeConsistencyLevel: streetEvidence.facadeConsistencyLevel,
      finalIdentityConfidence: streetEvidence.finalIdentityConfidence,
      finalIdentityReason: streetEvidence.finalIdentityReason,
      identityVerificationLevel: streetEvidence.identityVerificationLevel,
      // Photo evidence summary (no raw base64)
      photoAnalysis: streetEvidence.photoEvidence ? {
        visibleHouseNumber: streetEvidence.photoEvidence.visibleHouseNumber,
        visibleStreetName: streetEvidence.photoEvidence.visibleStreetName,
        buildingType: streetEvidence.photoEvidence.buildingType,
        visibleFloors: streetEvidence.photoEvidence.visibleFloors,
        facadeConfidence: streetEvidence.photoEvidence.facadeConfidence,
        photoReadability: streetEvidence.photoEvidence.photoReadability,
      } : null,
      streetSignalCount: streetEvidence.streetSignals.length,
    } : null,
  }, [], debugId);
}

/** POST /sottra/scan/cadastral — UNAVAILABLE: no real cadastral data source integrated */
export async function handleScanCadastral(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const address = (body.address as string) ?? "";
  if (!address) return fail(req, 400, "MISSING_ADDRESS", "Provide address", debugId);

  return ok(req, {
    foglio: null,
    particella: null,
    subalterno: null,
    anno: null,
    piani: null,
    unitaImmobiliari: null,
    renditaCatastale: null,
    sourceLabel: "Catasto — Agenzia delle Entrate (non integrato)",
    sourceType: "unavailable",
    sourcePeriod: null,
    confidenceReason: "Dati catastali non disponibili — integrazione con Sister/Agenzia Entrate non attiva",
    limitations: [
      "Servizio non collegato a Sister o Agenzia delle Entrate",
      "Foglio, particella, subalterno e rendita catastale richiedono accesso ai registri ufficiali",
      "Funzionalità predisposta per futura integrazione con fonti reali",
    ],
  }, ["Dati catastali non disponibili — fonte reale non integrata"], debugId);
}

/** POST /sottra/scan/pricing — address → price/sqm data (OMI real data, confidence-gated) */
export async function handleScanPricing(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const address = (body.address as string) ?? "";
  if (!address) return fail(req, 400, "MISSING_ADDRESS", "Provide address", debugId);

  try {
    const omi = await lookupOMI(address);

    if (omi.found && omi.compr_min != null && omi.compr_max != null) {
      // Unified publication policy — determines sourceType from match quality
      const sourceType = classifyOMIPricing(omi.matchConfidence, omi.matchMethod);

      if (sourceType === "unavailable") {
        // Match too weak — refuse to publish prices
        return ok(req, {
          prezzoMq: null,
          prezzoMqMin: null,
          prezzoMqMax: null,
          mediaZona: null,
          trend5Anni: null,
          locazioneMqMin: omi.loc_min ?? null,
          locazioneMqMax: omi.loc_max ?? null,
          zona: omi.zona,
          zonaDescrizione: omi.zona_descr,
          comune: omi.comune,
          tipologia: omi.tipologia,
          fonte: omi.fonte,
          omiMatchConfidence: omi.matchConfidence,
          omiMatchMethod: omi.matchMethod,
          tutteZone: omi.tutteZone,
          sourceLabel: "Agenzia delle Entrate — Osservatorio Mercato Immobiliare",
          sourceType: "unavailable",
          sourcePeriod: "1° semestre 2025",
          confidenceReason: `Match zona OMI insufficiente (confidence: ${(omi.matchConfidence * 100).toFixed(0)}%, metodo: ${omi.matchMethod}) — prezzi non pubblicabili`,
          limitations: [
            `Zona OMI determinata con confidenza ${(omi.matchConfidence * 100).toFixed(0)}% (soglia minima: ${(PUBLICATION_POLICY.OMI_PUBLISH_THRESHOLD * 100).toFixed(0)}%)`,
            `Metodo di match: ${omi.matchMethod} — non sufficientemente affidabile per pubblicazione`,
            "I dati OMI esistono per il comune ma il match indirizzo→zona non è abbastanza solido",
            "Consultare direttamente le quotazioni OMI per tutte le zone nel campo tutteZone",
          ],
        }, [`Match zona OMI debole (${(omi.matchConfidence * 100).toFixed(0)}%) — prezzi non pubblicati`], debugId);
      }

      // Publishable — sourceType is "official" (single_zone, high confidence) or "elaborated" (ai_matched)
      const confidenceLabel = sourceType === "official"
        ? `Prezzi ufficiali OMI — zona ${omi.zona} (${omi.zona_descr}), match confidence: ${(omi.matchConfidence * 100).toFixed(0)}%`
        : `Prezzi OMI elaborati — zona ${omi.zona} (${omi.zona_descr}), match AI con confidence ${(omi.matchConfidence * 100).toFixed(0)}% — non verificato manualmente`;

      const limitationsBase = [
        "Prezzi espressi come range min/max per tipologia e stato conservativo",
        `Match zona basato su ${omi.matchMethod === "single_zone" ? "zona unica nel comune" : "identificazione AI dell'indirizzo"}`,
        "Dati riferiti a valori normali di mercato (non valori di realizzo o giudiziari)",
        "mediaZona e trend5Anni non disponibili — nessuna fonte reale per queste metriche",
      ];
      if (sourceType === "elaborated") {
        limitationsBase.push("sourceType=elaborated: la zona OMI è stata determinata tramite AI, non con certezza assoluta");
      }

      return ok(req, {
        prezzoMq: omi.prezzoMedio,
        prezzoMqMin: omi.compr_min,
        prezzoMqMax: omi.compr_max,
        mediaZona: null,
        trend5Anni: null,
        locazioneMqMin: omi.loc_min ?? null,
        locazioneMqMax: omi.loc_max ?? null,
        zona: omi.zona,
        zonaDescrizione: omi.zona_descr,
        comune: omi.comune,
        tipologia: omi.tipologia,
        fonte: omi.fonte,
        omiMatchConfidence: omi.matchConfidence,
        omiMatchMethod: omi.matchMethod,
        tutteZone: omi.tutteZone,
        sourceLabel: "Agenzia delle Entrate — Osservatorio Mercato Immobiliare",
        sourceType,
        sourcePeriod: "1° semestre 2025",
        confidenceReason: confidenceLabel,
        limitations: limitationsBase,
      }, [`Prezzi OMI (${sourceType}) — 1° semestre 2025`], debugId);
    }

    // Fallback: OMI data not found — return structured "unavailable", no AI invention
    return ok(req, {
      prezzoMq: null,
      prezzoMqMin: null,
      prezzoMqMax: null,
      mediaZona: null,
      trend5Anni: null,
      locazioneMqMin: null,
      locazioneMqMax: null,
      zona: null,
      zonaDescrizione: null,
      comune: omi.comune ?? null,
      tipologia: null,
      fonte: "Agenzia Entrate — OMI, 1° semestre 2025",
      omiMatchConfidence: 0,
      omiMatchMethod: omi.matchMethod,
      tutteZone: null,
      sourceLabel: "Agenzia delle Entrate — Osservatorio Mercato Immobiliare",
      sourceType: "unavailable",
      sourcePeriod: "1° semestre 2025",
      confidenceReason: `Nessun dato OMI trovato per il comune "${omi.comune ?? address}"`,
      limitations: [`Comune non presente nel dataset OMI importato`, "Nessun fallback: il dato non è disponibile"],
    }, [`Dati OMI non disponibili per questo indirizzo`], debugId);
  } catch (e) {
    // Security: never leak stack traces — only generic message + debug_id
    console.error(`[scan/pricing] Error debug_id=${debugId}: ${String(e).slice(0, 200)}`);
    return fail(req, 502, "PROVIDER_ERROR", `Pricing analysis failed. Reference: ${debugId}`, debugId);
  }
}

/** POST /sottra/scan/listings — UNAVAILABLE: no real listings data source integrated */
export async function handleScanListings(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const address = (body.address as string) ?? "";
  if (!address) return fail(req, 400, "MISSING_ADDRESS", "Provide address", debugId);

  return ok(req, {
    annunci: [],
    sourceLabel: "Portali immobiliari (non integrato)",
    sourceType: "unavailable",
    sourcePeriod: null,
    confidenceReason: "Annunci immobiliari non disponibili — nessun portale reale integrato",
    limitations: [
      "Servizio non collegato a portali immobiliari reali (Idealista, Immobiliare.it, ecc.)",
      "Nessun annuncio inventato o simulato viene restituito",
      "Funzionalità predisposta per futura integrazione con feed reali",
    ],
  }, ["Annunci immobiliari non disponibili — fonte reale non integrata"], debugId);
}

/** POST /sottra/scan/energy — UNAVAILABLE: no real APE/ENEA data source integrated */
export async function handleScanEnergy(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const address = (body.address as string) ?? "";
  if (!address) return fail(req, 400, "MISSING_ADDRESS", "Provide address", debugId);

  return ok(req, {
    classeEnergetica: null,
    epgl: null,
    mediaZona: null,
    sourceLabel: "ENEA / APE (non integrato)",
    sourceType: "unavailable",
    sourcePeriod: null,
    confidenceReason: "Classe energetica non disponibile — integrazione con ENEA/SIAPE non attiva",
    limitations: [
      "Servizio non collegato a ENEA, SIAPE o registri APE regionali",
      "La classe energetica reale è reperibile solo dall'Attestato di Prestazione Energetica ufficiale",
      "Funzionalità predisposta per futura integrazione con fonti reali",
    ],
  }, ["Dati energetici non disponibili — fonte reale non integrata"], debugId);
}

/** POST /sottra/scan/condominio — UNAVAILABLE: no real condominium registry data source */
export async function handleScanCondominio(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const address = (body.address as string) ?? "";
  if (!address) return fail(req, 400, "MISSING_ADDRESS", "Provide address", debugId);

  return ok(req, {
    tipoRiscaldamento: null,
    ascensore: null,
    statoConservazione: null,
    annoUltimaRistrutturazione: null,
    postiAuto: null,
    giardino: null,
    portineria: null,
    sourceLabel: "Registri condominiali (non integrato)",
    sourceType: "unavailable",
    sourcePeriod: null,
    confidenceReason: "Dati condominiali non disponibili — nessun registro reale integrato",
    limitations: [
      "Servizio non collegato a registri condominiali, verbali o visure",
      "Le informazioni condominiali reali richiedono accesso a documentazione specifica dell'edificio",
      "Funzionalità predisposta per futura integrazione con fonti reali",
    ],
  }, ["Dati condominiali non disponibili — fonte reale non integrata"], debugId);
}

/** POST /sottra/scan/storico-transazioni — UNAVAILABLE: no real transaction registry integrated */
export async function handleScanStoricoTransazioni(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const address = (body.address as string) ?? "";
  if (!address) return fail(req, 400, "MISSING_ADDRESS", "Provide address", debugId);

  return ok(req, {
    transazioni: [],
    mediaZona12Mesi: null,
    variazione12Mesi: null,
    sourceLabel: "Agenzia delle Entrate — Registro transazioni (non integrato)",
    sourceType: "unavailable",
    sourcePeriod: null,
    confidenceReason: "Storico transazioni non disponibile — integrazione con Agenzia Entrate non attiva",
    limitations: [
      "Servizio non collegato alla banca dati delle transazioni immobiliari dell'Agenzia delle Entrate",
      "Lo storico reale delle compravendite richiede accesso a atti notarili o database ufficiali",
      "Nessuna transazione inventata o simulata viene restituita",
      "Funzionalità predisposta per futura integrazione con fonti reali",
    ],
  }, ["Storico transazioni non disponibile — fonte reale non integrata"], debugId);
}

/** POST /sottra/scan/market — Market data comparables + signals (confidence-gated) */
export async function handleScanMarket(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const address = (body.address as string) ?? "";
  const comune = (body.comune as string) ?? "";
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  const provincia = (body.provincia as string) ?? null;
  const street = (body.street as string) ?? null;
  const houseNumber = (body.houseNumber as string) ?? null;
  const propertyType = (body.propertyType as string) ?? undefined;
  const areaSqm = typeof body.areaSqm === "number" ? body.areaSqm : undefined;
  const finalIdentityConfidence = typeof body.finalIdentityConfidence === "number" ? body.finalIdentityConfidence : 0;
  const geoMatchLevel = (body.geoMatchLevel as string) ?? "unknown";

  if (!address && !comune) return fail(req, 400, "MISSING_ADDRESS", "Provide address or comune", debugId);
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  try {
    const result = await collectMarketData(
      { address, comune, provincia, street, houseNumber, lat, lng, propertyType, areaSqm },
      finalIdentityConfidence,
      geoMatchLevel,
    );

    // Sanitize: never expose raw provider API details
    const warnings: string[] = [];
    if (result.marketContext === "unavailable") {
      warnings.push("Dati di mercato non disponibili");
    } else if (result.marketContext === "partial") {
      warnings.push("Dati di mercato parziali — copertura limitata");
    }

    return ok(req, result, warnings, debugId);
  } catch (e) {
    console.error(`[scan/market] Error debug_id=${debugId}: ${String(e).slice(0, 200)}`);
    return fail(req, 502, "PROVIDER_ERROR", `Market data analysis failed. Reference: ${debugId}`, debugId);
  }
}
