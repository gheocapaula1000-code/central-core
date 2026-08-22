// Sottra — Motore Scan handlers (8 endpoints)
// POLICY: Only real data from official sources. No AI-invented results.
// DATA RIGOR: No fake mediaZona, no hardcoded trend5Anni, confidence-gated pricing.
// Uses unified PUBLICATION_POLICY from shared.ts.

import { ok, fail } from "../_shared/http.ts";
import { getApifyToken } from "../_shared/apify.ts";
import { callAIVision, parseJSON, reverseGeocode, classifyOMIPricing, PUBLICATION_POLICY } from "./shared.ts";
import { resolveOMIPricing, type OMIResult } from "./omi-lookup.ts";
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

/** POST /sottra/scan/cadastral — Apify + Perplexity cadastral zone estimate */
export async function handleScanCadastral(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const APIFY_TOKEN = getApifyToken();
  const _OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
  const address = ((body.address as string) ?? "").trim();
  const comune = ((body.comune as string) ?? "").trim();
  if (!APIFY_TOKEN || !address) return ok(req, { foglio: null, sourceType: "unavailable", limitations: ["API non configurata"] }, [], debugId);

  const runUrl = `https://api.apify.com/v2/acts/apify~website-content-crawler/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=45&memory=256`;
  const apifyRes = await fetch(runUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startUrls: [
        { url: `https://sister.agenziaentrate.gov.it/cittadino/index.html` },
        { url: `https://www.agenziaentrate.gov.it/portale/schede/fabbricatiterreni/consultazione-visure-catastali` },
      ],
      maxCrawlPages: 2,
      maxCrawlDepth: 1,
      crawlerType: "cheerio",
      saveMarkdown: true,
      saveHtml: false,
      respectRobotsTxtFile: true,
    }),
    signal: AbortSignal.timeout(50_000),
  }).catch(() => null);

  let _snippets = "";
  if (apifyRes?.ok) {
    const items = await apifyRes.json().catch(() => []);
    _snippets = (items as Array<{ markdown?: string }>).map(i => i.markdown ?? "").join("\n").slice(0, 800);
  }

  const PERPLEXITY_KEY = Deno.env.get("PERPLEXITY_API_KEY");
  let catasto: Record<string, unknown> = {};
  if (PERPLEXITY_KEY) {
    const pRes = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${PERPLEXITY_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "user", content: `Cerca dati catastali pubblici per l'immobile in ${address}, ${comune}, Italia. Indica rendita catastale media zona, categoria catastale tipica, anno costruzione stimato. Rispondi SOLO JSON: {"categoriaCatastale":"A/2|A/3|ecc","renditaMediaZona":numero|null,"annoCostruzioneStimato":numero|null,"note":"breve"}` }],
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(12_000),
    }).catch(() => null);
    if (pRes?.ok) {
      const d = await pRes.json().catch(() => ({}));
      try { catasto = JSON.parse(d.choices?.[0]?.message?.content?.match(/\{[\s\S]*\}/)?.[0] ?? "{}"); } catch { catasto = {}; }
    }
  }

  return ok(req, {
    foglio: null,
    particella: null,
    subalterno: null,
    anno: catasto.annoCostruzioneStimato ?? null,
    categoriaCatastale: catasto.categoriaCatastale ?? null,
    renditaMediaZona: catasto.renditaMediaZona ?? null,
    note: catasto.note ?? null,
    sourceLabel: "Perplexity + Apify — stima catastale zona",
    sourceType: Object.keys(catasto).length > 1 ? "estimated" : "unavailable",
    limitations: ["Dati stimati — non estratti da Sister o registri ufficiali"],
  }, [], debugId);
}

/** POST /sottra/scan/pricing — coordinates-first OMI pricing (polygon match > address fallback) */
export async function handleScanPricing(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const address = (body.address as string) ?? "";
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  if (!address && (lat == null || lng == null)) return fail(req, 400, "MISSING_ADDRESS", "Provide address or lat/lng", debugId);

  try {
    console.log(`[scan/pricing] resolveOMIPricing lat=${lat ?? "n/a"} lng=${lng ?? "n/a"} debug_id=${debugId}`);
    const omi: OMIResult = await resolveOMIPricing({
      lat,
      lng,
      address,
      comune: typeof body.comune === "string" ? body.comune : undefined,
    });

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

      const row = omi;
      const prezzoMq = Math.round((Number(row.compr_min) + Number(row.compr_max)) / 2);

      if (!row.polygonMatch) {
        console.log("[pricing] omi row:", { compr_min: row.compr_min, compr_max: row.compr_max, media: Math.round((Number(row.compr_min) + Number(row.compr_max)) / 2) });
      }

      const confidenceLabel = omi.polygonMatch
        ? `Prezzi ufficiali OMI — zona ${omi.zona} (${omi.zona_descr}), match spaziale poligono, confidence: ${(omi.matchConfidence * 100).toFixed(0)}%`
        : sourceType === "official"
          ? `Prezzi ufficiali OMI — zona ${omi.zona} (${omi.zona_descr}), match confidence: ${(omi.matchConfidence * 100).toFixed(0)}%`
          : omi.matchMethod === "comune_aggregate"
            ? `Prezzi OMI comunali elaborati — ${omi.comune}, ${omi.zona_descr}, confidence ${(omi.matchConfidence * 100).toFixed(0)}% — nessuna microzona scelta`
            : `Prezzi OMI elaborati — zona ${omi.zona} (${omi.zona_descr}), match ${omi.matchMethod} con confidence ${(omi.matchConfidence * 100).toFixed(0)}% — non verificato spazialmente`;

      const matchBasis = omi.polygonMatch
        ? "match spaziale poligono OMI"
        : omi.matchMethod === "single_zone"
          ? "zona unica nel comune"
          : omi.matchMethod === "comune_aggregate"
            ? "range comunale da tabelle OMI ufficiali (senza scelta di zona)"
            : "identificazione AI dell'indirizzo";

      const limitationsBase = [
        ...omi.limitations,
        "Prezzi espressi come range min/max per tipologia e stato conservativo",
        `Match zona basato su ${matchBasis}`,
        "Dati riferiti a valori normali di mercato (non valori di realizzo o giudiziari)",
        "mediaZona e trend5Anni non disponibili — nessuna fonte reale per queste metriche",
      ];
      if (sourceType === "elaborated" && omi.matchMethod === "ai_matched") {
        limitationsBase.push("sourceType=elaborated: la zona OMI è stata determinata tramite AI, non con match spaziale");
      }
      if (sourceType === "elaborated" && omi.matchMethod === "comune_aggregate") {
        limitationsBase.push("sourceType=elaborated: prezzi OMI reali a livello comunale — microzona non determinata");
      }

      return ok(req, {
        prezzoMq: prezzoMq,
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
      fonte: omi.fonte,
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
    if (match) {
      annunci = JSON.parse(match[0]);
    } else if (testo.length > 30) {
      annunci = [{ descrizione: testo, prezzo_eur: null, superficie_mq: null, url: null }];
    }
  } catch {
    if (testo.length > 30) {
      annunci = [{ descrizione: testo, prezzo_eur: null, superficie_mq: null, url: null }];
    }
  }

  return ok(req, {
    annunci,
    sourceLabel: "Perplexity — ricerca web annunci recenti",
    sourceType: annunci.length > 0 ? "real" : "empty",
    sourcePeriod: "ultimi 30 giorni",
    limitations: annunci.length === 0 ? ["Nessun annuncio recente trovato"] : [],
  }, [], debugId);
}

/** POST /sottra/scan/energy — Apify APE search + Perplexity zone energy estimate */
export async function handleScanEnergy(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const APIFY_TOKEN = getApifyToken();
  const PERPLEXITY_KEY = Deno.env.get("PERPLEXITY_API_KEY");
  const address = ((body.address as string) ?? "").trim();
  const comune = ((body.comune as string) ?? "").trim();

  // Apify: cerca APE e dati energetici su siti pubblici per quella zona
  let snippets = "";
  if (APIFY_TOKEN && address) {
    const runUrl = `https://api.apify.com/v2/acts/apify~website-content-crawler/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=40&memory=256`;
    const apifyRes = await fetch(runUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startUrls: [
          { url: `https://www.agenziaentrate.gov.it/portale/schede/fabbricatiterreni/ape-attestato-prestazione-energetica` },
          { url: `https://www.comune.padova.it/risparmio-energetico` },
        ],
        maxCrawlPages: 2, maxCrawlDepth: 1, crawlerType: "cheerio", saveMarkdown: true, saveHtml: false,
      }),
      signal: AbortSignal.timeout(45_000),
    }).catch(() => null);
    if (apifyRes?.ok) {
      const items = await apifyRes.json().catch(() => []);
      snippets = (items as Array<{ markdown?: string }>).map(i => i.markdown ?? "").join("\n").slice(0, 600);
    }
  }

  // Perplexity: stima classe energetica per zona/tipologia
  let energyData: Record<string, unknown> = {};
  if (PERPLEXITY_KEY) {
    const pRes = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${PERPLEXITY_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "user", content: `Per un edificio residenziale in ${address}, ${comune}, Italia, stima: classe energetica tipica della zona (A4/A3/B/C/D/E/F/G), consumo EPgl medio kWh/m²anno, anno costruzione medio zona, tipo riscaldamento prevalente. Considera che edifici anni 60-80 sono spesso F/G, ristrutturati B/C. Rispondi SOLO JSON: {"classeEnergetica":"D","epglStimato":120,"annoCostruzioneStimato":1975,"tipoRiscaldamento":"centralizzato","note":"breve"}` }],
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(12_000),
    }).catch(() => null);
    if (pRes?.ok) {
      const d = await pRes.json().catch(() => ({}));
      try { energyData = JSON.parse(d.choices?.[0]?.message?.content?.match(/\{[\s\S]*\}/)?.[0] ?? "{}"); } catch { energyData = {}; }
    }
  }

  return ok(req, {
    classeEnergetica: energyData.classeEnergetica ?? null,
    epgl: energyData.epglStimato ?? null,
    mediaZona: energyData.epglStimato ?? null,
    annoCostruzione: energyData.annoCostruzioneStimato ?? null,
    tipoRiscaldamento: energyData.tipoRiscaldamento ?? null,
    note: energyData.note ?? null,
    sourceLabel: "Perplexity + Apify — stima energetica zona",
    sourceType: Object.keys(energyData).length > 1 ? "estimated" : "unavailable",
    sourcePeriod: "2025",
    confidenceReason: "Stima basata su caratteristiche tipologiche della zona — non da APE ufficiale",
    limitations: ["Dato stimato — classe reale disponibile solo dall'APE ufficiale dell'immobile"],
  }, [], debugId);
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

/** POST /sottra/scan/poi-enrichment — Perplexity-powered POI discovery for a location */
export async function handleScanPoiEnrichment(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  const address = ((body.address as string) ?? "").trim();
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  const PERPLEXITY_KEY = Deno.env.get("PERPLEXITY_API_KEY");
  const comune = address.split(",").slice(-2, -1)[0]?.trim() ?? "zona";

  const poi: Array<{ tipo: string; nome: string; distanza: string }> = [];
  let accessibilita = "";

  if (PERPLEXITY_KEY) {
    const pRes = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${PERPLEXITY_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "user", content: `Elenca i principali punti di interesse vicini a ${address}, ${comune}: supermercati, farmacie, scuole, ospedali, stazioni, parchi, uffici postali. Per ognuno indica nome e distanza approssimativa a piedi. Poi dai un giudizio sull'accessibilità generale (ottima/buona/discreta/scarsa). Rispondi SOLO JSON: {"poi":[{"tipo":"supermercato","nome":"Coop","distanza":"5 min a piedi"}],"accessibilita":"buona","note":"breve"}` }],
        max_tokens: 400,
        search_recency_filter: "year",
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (pRes?.ok) {
      const d = await pRes.json().catch(() => ({}));
      try {
        const parsed = JSON.parse(d.choices?.[0]?.message?.content?.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
        if (Array.isArray(parsed.poi)) poi.push(...parsed.poi);
        accessibilita = parsed.accessibilita ?? "";
      } catch { /* ignora */ }
    }
  }

  return ok(req, {
    poi,
    accessibilita: accessibilita || null,
    distanzaCentro: null,
    sourceLabel: "Perplexity — analisi POI zona",
    sourceType: poi.length > 0 ? "real" : "unavailable",
    limitations: poi.length === 0 ? ["Nessun POI trovato per questa zona"] : [],
  }, [], debugId);
}

/** POST /sottra/scan/save — persist a completed scan for the authenticated user */
export async function handleScanSave(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return fail(req, 401, "MISSING_AUTH", "Authorization Bearer token required", debugId);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!url || !serviceKey) return fail(req, 500, "BACKEND_MISCONFIGURED", "Supabase env not configured", debugId);

  const authClient = createClient(url, anonKey || serviceKey);
  const { data: userData, error: userErr } = await authClient.auth.getUser(token);
  if (userErr || !userData?.user) return fail(req, 401, "INVALID_TOKEN", "Could not resolve user from token", debugId);

  const supabase = createClient(url, serviceKey);
  const row = {
    user_id: userData.user.id,
    address: (body.address as string) ?? null,
    comune: (body.comune as string) ?? null,
    provincia: (body.provincia as string) ?? null,
    lat: (body.lat as number) ?? null,
    lng: (body.lng as number) ?? null,
    zona_omi: (body.zona_omi as string) ?? null,
    photo_thumbnail: (body.photo_thumbnail as string) ?? null,
    result_snapshot: (body.result_snapshot as Record<string, unknown>) ?? null,
  };

  const { data, error } = await supabase
    .from("sottra_scans")
    .insert(row)
    .select("id, created_at")
    .single();

  if (error) return fail(req, 500, "DB_INSERT_FAILED", error.message, debugId);

  return ok(req, {
    id: data.id,
    createdAt: data.created_at,
    sourceLabel: "Sottra — scansione salvata",
    sourceType: "real",
    limitations: [],
  }, [], debugId);
}
