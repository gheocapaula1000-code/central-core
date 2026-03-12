// Sottra — Motore Scan handlers (7 endpoints)
// POLICY: Only real data from official sources. No AI-invented results.
// DATA RIGOR: No fake mediaZona, no hardcoded trend5Anni, confidence-gated pricing.
// Uses unified PUBLICATION_POLICY from shared.ts.

import { ok, fail } from "../_shared/http.ts";
import { callAI, callAIVision, parseJSON, reverseGeocode, classifyOMIPricing, PUBLICATION_POLICY } from "./shared.ts";
import { lookupOMI } from "./omi-lookup.ts";

/** POST /sottra/scan/identify — photo + GPS → address + building ID */
export async function handleScanIdentify(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  const photo = (body.photo as string) ?? "";
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  const address = await reverseGeocode(lat, lng);
  if (!address) return fail(req, 502, "GEOCODE_FAILED", "Could not resolve coordinates to address", debugId);

  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(address));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const buildingId = "IT-" + hashArray.slice(0, 4).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();

  // If photo provided, analyze it for confidence and visible details
  let confidence = 0.75;
  if (photo && photo.startsWith("data:image")) {
    try {
      const output = await callAIVision(
        `Stai guardando la foto di un edificio. L'indirizzo rilevato dal GPS è "${address}". Rispondi SOLO in JSON: { "confidence": numero_da_0_a_1 che indica quanto l'edificio nella foto corrisponde all'indirizzo indicato, "visibleFloors": numero_piani_visibili_nella_foto, "buildingType": "residenziale" o "commerciale" o "misto" o "industriale" }`,
        photo, 150, 0.1
      );
      const parsed = parseJSON(output);
      if (parsed?.confidence) confidence = parsed.confidence as number;
    } catch { /* use default confidence */ }
  }

  return ok(req, { address, buildingId, confidence }, [], debugId);
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
      // Check confidence gate — refuse to publish weak matches as official
      if (omi.matchConfidence < OMI_PUBLISH_THRESHOLD) {
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
            `Zona OMI determinata con confidenza ${(omi.matchConfidence * 100).toFixed(0)}% (soglia minima: ${(OMI_PUBLISH_THRESHOLD * 100).toFixed(0)}%)`,
            `Metodo di match: ${omi.matchMethod} — non sufficientemente affidabile per pubblicazione`,
            "I dati OMI esistono per il comune ma il match indirizzo→zona non è abbastanza solido",
            "Consultare direttamente le quotazioni OMI per tutte le zone nel campo tutteZone",
          ],
        }, [`Match zona OMI debole (${(omi.matchConfidence * 100).toFixed(0)}%) — prezzi non pubblicati`], debugId);
      }

      // Real OMI data found with sufficient confidence — return actual prices
      return ok(req, {
        prezzoMq: omi.prezzoMedio,
        prezzoMqMin: omi.compr_min,
        prezzoMqMax: omi.compr_max,
        // mediaZona: null — not a distinct metric, would just duplicate prezzoMq
        mediaZona: null,
        // trend5Anni: null — no real multi-year calculation implemented
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
        sourceType: "official",
        sourcePeriod: "1° semestre 2025",
        confidenceReason: `Prezzi ufficiali OMI — zona ${omi.zona} (${omi.zona_descr}), match confidence: ${(omi.matchConfidence * 100).toFixed(0)}%`,
        limitations: [
          "Prezzi espressi come range min/max per tipologia e stato conservativo",
          `Match zona basato su ${omi.matchMethod === "single_zone" ? "zona unica nel comune" : "identificazione AI dell'indirizzo"}`,
          "Dati riferiti a valori normali di mercato (non valori di realizzo o giudiziari)",
          "mediaZona e trend5Anni non disponibili — nessuna fonte reale per queste metriche",
        ],
      }, ["Prezzi ufficiali Agenzia Entrate — OMI, 1° semestre 2025"], debugId);
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
    return fail(req, 502, "PROVIDER_ERROR", `Pricing analysis failed: ${String(e).slice(0, 100)}`, debugId);
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
