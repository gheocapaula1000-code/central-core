// Sottra — Motore Scan handlers (8 endpoints)
// POLICY: Only real data from official sources. No AI-invented results.
// DATA RIGOR: No fake mediaZona, no hardcoded trend5Anni, confidence-gated pricing.
// Uses unified PUBLICATION_POLICY from shared.ts.

import { ok, fail } from "../_shared/http.ts";
import { callAIVision, parseJSON, reverseGeocode, classifyOMIPricing, PUBLICATION_POLICY } from "./shared.ts";
import { lookupOMI, lookupOMIByCoordinates, type OMIResult } from "./omi-lookup.ts";
import { resolveGeo } from "./geo-resolution.ts";
import { collectStreetEvidence, type StreetEvidenceMergeResult } from "./street-evidence.ts";
import { collectMarketData } from "./market-data.ts";

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

/** POST /sottra/scan/pricing — coordinates-first OMI pricing (polygon match > address fallback) */
export async function handleScanPricing(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const address = (body.address as string) ?? "";
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  if (!address && (lat == null || lng == null)) return fail(req, 400, "MISSING_ADDRESS", "Provide address or lat/lng", debugId);

  try {
    let omi: OMIResult;

    // COORDINATES-FIRST: polygon match is the primary path
    if (lat != null && lng != null) {
      console.log(`[scan/pricing] Coordinates-first path: (${lat}, ${lng}), debug_id=${debugId}`);
      omi = await lookupOMIByCoordinates(lat, lng);

      // If polygon match failed, fallback to address-based (demoted)
      if (!omi.found && address) {
        console.log(`[scan/pricing] Polygon miss — fallback to address lookup, debug_id=${debugId}`);
        omi = await lookupOMI(address);
      }
    } else {
      // No coordinates — address-only fallback
      console.log(`[scan/pricing] No coordinates — address-only path, debug_id=${debugId}`);
      omi = await lookupOMI(address);
    }

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
          polygonMatch: omi.polygonMatch,
          omiGeoLevel: omi.omiGeoLevel,
          pricingPrecisionLabel: omi.pricingPrecisionLabel,
          sourceCoverageLevel: omi.sourceCoverageLevel,
          tutteZone: omi.tutteZone,
          sourceLabel: "Agenzia delle Entrate — Osservatorio Mercato Immobiliare",
          sourceType: "unavailable",
          sourcePeriod: "1° semestre 2025",
          confidenceReason: omi.confidenceReason,
          limitations: [
            ...omi.limitations,
            `Zona OMI determinata con confidenza ${(omi.matchConfidence * 100).toFixed(0)}% (soglia minima: ${(PUBLICATION_POLICY.OMI_PUBLISH_THRESHOLD * 100).toFixed(0)}%)`,
            `Metodo di match: ${omi.matchMethod} — non sufficientemente affidabile per pubblicazione`,
          ],
        }, [`Match zona OMI debole (${(omi.matchConfidence * 100).toFixed(0)}%) — prezzi non pubblicati`], debugId);
      }

      // Publishable
      const confidenceLabel = omi.polygonMatch
        ? `Prezzi ufficiali OMI — zona ${omi.zona} (${omi.zona_descr}), match spaziale poligono, confidence: ${(omi.matchConfidence * 100).toFixed(0)}%`
        : sourceType === "official"
          ? `Prezzi ufficiali OMI — zona ${omi.zona} (${omi.zona_descr}), match confidence: ${(omi.matchConfidence * 100).toFixed(0)}%`
          : `Prezzi OMI elaborati — zona ${omi.zona} (${omi.zona_descr}), match ${omi.matchMethod} con confidence ${(omi.matchConfidence * 100).toFixed(0)}% — non verificato spazialmente`;

      const limitationsBase = [
        ...omi.limitations,
        "Prezzi espressi come range min/max per tipologia e stato conservativo",
        `Match zona basato su ${omi.polygonMatch ? "match spaziale poligono OMI" : omi.matchMethod === "single_zone" ? "zona unica nel comune" : "identificazione AI dell'indirizzo"}`,
        "Dati riferiti a valori normali di mercato (non valori di realizzo o giudiziari)",
        "mediaZona e trend5Anni non disponibili — nessuna fonte reale per queste metriche",
      ];
      if (sourceType === "elaborated" && !omi.polygonMatch) {
        limitationsBase.push("sourceType=elaborated: la zona OMI è stata determinata tramite AI, non con match spaziale");
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
        polygonMatch: omi.polygonMatch,
        omiGeoLevel: omi.omiGeoLevel,
        pricingPrecisionLabel: omi.pricingPrecisionLabel,
        sourceCoverageLevel: omi.sourceCoverageLevel,
        tutteZone: omi.tutteZone,
        sourceLabel: "Agenzia delle Entrate — Osservatorio Mercato Immobiliare",
        sourceType,
        sourcePeriod: "1° semestre 2025",
        confidenceReason: confidenceLabel,
        limitations: limitationsBase,
      }, [`Prezzi OMI (${sourceType}, ${omi.matchMethod}) — 1° semestre 2025`], debugId);
    }

    // Fallback: OMI data not found
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
      fonte: FONTE,
      omiMatchConfidence: 0,
      omiMatchMethod: omi.matchMethod,
      polygonMatch: false,
      omiGeoLevel: "none",
      pricingPrecisionLabel: "Nessun dato OMI disponibile",
      sourceCoverageLevel: "none",
      tutteZone: null,
      sourceLabel: "Agenzia delle Entrate — Osservatorio Mercato Immobiliare",
      sourceType: "unavailable",
      sourcePeriod: "1° semestre 2025",
      confidenceReason: omi.confidenceReason,
      limitations: omi.limitations,
    }, [`Dati OMI non disponibili per questo indirizzo`], debugId);
  } catch (e) {
    console.error(`[scan/pricing] Error debug_id=${debugId}: ${String(e).slice(0, 200)}`);
    return fail(req, 502, "PROVIDER_ERROR", `Pricing analysis failed. Reference: ${debugId}`, debugId);
  }
}

/** POST /sottra/scan/listings — Perplexity web search for recent real estate listings */
export async function handleScanListings(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const address = (body.address as string) ?? "";
  if (!address) return fail(req, 400, "MISSING_ADDRESS", "Provide address", debugId);

  const PERPLEXITY_KEY = Deno.env.get("PERPLEXITY_API_KEY");
  if (!PERPLEXITY_KEY) return ok(req, { annunci: [], sourceType: "unavailable", limitations: ["API non configurata"] }, [], debugId);

  const comune = ((body.comune as string) ?? "").trim();
  if (!comune) return fail(req, 400, "MISSING_COMUNE", "Provide comune", debugId);

  const query = `annunci vendita immobili ${address} ${comune} prezzi recenti 2025 2026`;
  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${PERPLEXITY_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "sonar",
      messages: [{ role: "user", content: `Trovami 3-5 annunci immobiliari reali vicino a ${address}, ${comune}. Per ognuno indica: prezzo, mq se disponibile, link fonte. Rispondi in italiano in formato JSON array con campi: prezzo_eur, superficie_mq, descrizione, url. Query: ${query}` }],
      max_tokens: 500,
      search_recency_filter: "month",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json();
  const testo = data.choices?.[0]?.message?.content ?? "";
  let annunci: unknown[] = [];
  try {
    const match = testo.match(/\[[\s\S]*\]/);
    if (match) annunci = JSON.parse(match[0]);
  } catch { annunci = []; }

  return ok(req, {
    annunci,
    sourceLabel: "Perplexity — ricerca web annunci recenti",
    sourceType: annunci.length > 0 ? "real" : "empty",
    sourcePeriod: "ultimi 30 giorni",
    limitations: annunci.length === 0 ? ["Nessun annuncio recente trovato"] : [],
  }, [], debugId);
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

/** POST /sottra/scan/condominio — Firecrawl + OpenAI web analysis */
export async function handleScanCondominio(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const FIRECRAWL_KEY = Deno.env.get("FIRECRAWL_API_KEY");
  const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
  const address = ((body.address as string) ?? "").trim();
  const comune = ((body.comune as string) ?? "").trim();
  if (!FIRECRAWL_KEY || !address) return ok(req, { statoConservazione: null, sourceType: "unavailable", limitations: ["API non configurata"] }, [], debugId);

  const searchRes = await fetch("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: { "Authorization": `Bearer ${FIRECRAWL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `condominio "${address}" ${comune} stato conservazione ascensore riscaldamento spese`,
      limit: 3,
      scrapeOptions: { formats: ["markdown"] },
    }),
    signal: AbortSignal.timeout(25_000),
  }).catch(() => null);

  let snippets = "";
  if (searchRes?.ok) {
    const d = await searchRes.json().catch(() => ({ data: [] }));
    snippets = (d.data ?? []).map((r: { markdown?: string }) => r.markdown ?? "").join("\n").slice(0, 1000);
  }

  let parsed: Record<string, unknown> = {};
  if (OPENAI_KEY && snippets.length > 30) {
    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: `Dal testo estrai info sul condominio in ${address}, ${comune}. Rispondi SOLO JSON: {"statoConservazione":"buono|discreto|da_ristrutturare|non_disponibile","ascensore":true|false|null,"tipoRiscaldamento":"autonomo|centralizzato|non_disponibile","note":"breve"}. Testo: ${snippets}` }],
        max_tokens: 150,
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (aiRes?.ok) {
      const aiData = await aiRes.json().catch(() => ({}));
      try { parsed = JSON.parse(aiData.choices?.[0]?.message?.content ?? "{}"); } catch { parsed = {}; }
    }
  }

  return ok(req, {
    tipoRiscaldamento: parsed.tipoRiscaldamento ?? null,
    ascensore: parsed.ascensore ?? null,
    statoConservazione: parsed.statoConservazione ?? null,
    annoUltimaRistrutturazione: null,
    note: parsed.note ?? null,
    sourceLabel: "Firecrawl + OpenAI",
    sourceType: Object.keys(parsed).length > 1 ? "real" : "empty",
    limitations: [],
  }, [], debugId);
}

/** POST /sottra/scan/storico-transazioni — Perplexity web search for recent transactions */
export async function handleScanStoricoTransazioni(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const PERPLEXITY_KEY = Deno.env.get("PERPLEXITY_API_KEY");
  const address = ((body.address as string) ?? "").trim();
  const comune = ((body.comune as string) ?? "").trim();
  if (!PERPLEXITY_KEY || !address) return ok(req, { transazioni: [], sourceType: "unavailable", limitations: ["API non configurata"] }, [], debugId);

  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${PERPLEXITY_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "sonar",
      messages: [{ role: "user", content: `Cerca transazioni immobiliari recenti (compravendite) vicino a ${address}, ${comune}, Italia. Prezzi al mq, date, tipologie. Rispondi in italiano conciso.` }],
      max_tokens: 400,
      search_recency_filter: "year",
      return_citations: true,
    }),
    signal: AbortSignal.timeout(12_000),
  }).catch(() => null);

  let testo = "";
  let fonti: string[] = [];
  if (res?.ok) {
    const data = await res.json().catch(() => ({}));
    testo = data.choices?.[0]?.message?.content ?? "";
    fonti = (data.citations ?? []).slice(0, 3);
  }

  return ok(req, {
    transazioni: testo ? [{ descrizione: testo, fonti }] : [],
    mediaZona12Mesi: null,
    variazione12Mesi: null,
    sourceLabel: "Perplexity — ricerca transazioni recenti",
    sourceType: testo.length > 30 ? "real" : "empty",
    sourcePeriod: "ultimi 12 mesi",
    limitations: testo.length === 0 ? ["Nessuna transazione recente trovata"] : [],
  }, [], debugId);
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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

/** POST /sottra/scan/offmarket — radar signals + early off-market candidates for a comune */
export async function handleScanOffmarket(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  const comune = body.comune as string | undefined;
  const provincia = body.provincia as string | undefined;
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const [radarRes, candidatesRes] = await Promise.all([
    supabase
      .from("radar_signals")
      .select("signal_type, title, description, source, evidence_url, confidence, urgency, municipality, province, lat, lng, payload")
      .eq("is_active", true)
      .ilike("municipality", comune ?? "")
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("early_offmarket_signal_candidates")
      .select("signal_type, title, why_it_matters, possible_agent_action, source_url, confidence_score, quality, comune, provincia")
      .in("status", ["promoted", "needs_review"])
      .ilike("comune", comune ?? "")
      .order("priority_score", { ascending: false })
      .limit(5),
  ]);

  const signals = (radarRes.data ?? []).map((s: any) => ({
    tipo: s.signal_type,
    titolo: s.title ?? s.description,
    fonte: s.source,
    url: s.evidence_url,
    confidenza: s.confidence,
    urgenza: s.urgency,
    comune: s.municipality,
  }));

  const opportunities = (candidatesRes.data ?? []).map((c: any) => ({
    tipo: c.signal_type,
    titolo: c.title,
    perchéOra: c.why_it_matters,
    azioneAgente: c.possible_agent_action,
    url: c.source_url,
    qualità: c.quality,
  }));

  return ok(req, {
    segnali: signals,
    opportunita: opportunities,
    comune: comune ?? null,
    provincia: provincia ?? null,
    totale: signals.length + opportunities.length,
    sourceType: signals.length > 0 ? "real" : "empty",
    limitations: signals.length === 0 ? ["Nessun segnale off-market disponibile per questa zona"] : [],
  }, [], debugId);
}

/** POST /sottra/scan/zone-intelligence — Perplexity-powered zone intelligence for a comune */
export async function handleScanZoneIntelligence(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  const comune = (body.comune as string | undefined)?.trim();
  const provincia = (body.provincia as string | undefined)?.trim();
  const indirizzo = (body.indirizzo as string | undefined)?.trim();

  if (!comune) return fail(req, 400, "MISSING_COMUNE", "Provide comune", debugId);

  const key = Deno.env.get("PERPLEXITY_API_KEY");
  if (!key) return ok(req, { notizie: [], segnali: [], sourceType: "unavailable", limitations: ["PERPLEXITY_API_KEY mancante"] }, [], debugId);

  const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";

  const queries = [
    `notizie recenti ${comune} ${provincia ?? ""} immobili urbanistica sviluppo quartiere 2025 2026`,
    `aste giudiziarie immobili ${comune} ${provincia ?? ""} tribunale 2025 2026`,
    `variante urbanistica piano interventi ${comune} 2025 2026`,
  ];

  const results: Array<{ query: string; risposta: string; fonti: string[] }> = [];

  for (const q of queries) {
    try {
      const res = await fetch(PERPLEXITY_URL, {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "sonar",
          messages: [{ role: "user", content: `Rispondimi in italiano in modo conciso (max 3 frasi). ${q}` }],
          max_tokens: 300,
          search_recency_filter: "month",
          return_citations: true,
        }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const testo = data.choices?.[0]?.message?.content ?? "";
      const citazioni = (data.citations ?? []).slice(0, 3);
      if (testo && testo.length > 20) {
        results.push({ query: q, risposta: testo, fonti: citazioni });
      }
    } catch { /* continua */ }
  }

  return ok(req, {
    comune,
    provincia: provincia ?? null,
    indirizzo: indirizzo ?? null,
    risultati: results,
    totale: results.length,
    sourceType: results.length > 0 ? "real" : "empty",
    limitations: results.length === 0 ? ["Nessuna notizia recente trovata per questa zona"] : [],
  }, [], debugId);
}
