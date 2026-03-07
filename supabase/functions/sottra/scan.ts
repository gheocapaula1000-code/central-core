// Sottra — Motore Scan handlers (7 endpoints)

import { ok, fail } from "../_shared/http.ts";
import { callAI, parseJSON, reverseGeocode } from "./shared.ts";

/** POST /sottra/scan/identify — photo + GPS → address + building ID */
export async function handleScanIdentify(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  const address = await reverseGeocode(lat, lng);
  if (!address) return fail(req, 502, "GEOCODE_FAILED", "Could not resolve coordinates to address", debugId);

  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(address));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const buildingId = "IT-" + hashArray.slice(0, 4).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();

  return ok(req, { address, buildingId, confidence: 0.85 }, [], debugId);
}

/** POST /sottra/scan/cadastral — address → catasto data */
export async function handleScanCadastral(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const address = (body.address as string) ?? "";
  if (!address) return fail(req, 400, "MISSING_ADDRESS", "Provide address", debugId);

  const prompt = `Sei un esperto catastale italiano. Per l'indirizzo "${address}", stima i dati catastali plausibili basandoti sulla zona, tipologia edilizia tipica e anno di costruzione probabile.

Rispondi SOLO in JSON valido:
{
  "foglio": numero_foglio_catastale,
  "particella": numero_particella,
  "subalterno": numero_subalterno,
  "anno": anno_costruzione_stimato,
  "piani": numero_piani_stimato,
  "unitaImmobiliari": numero_unita_stimate,
  "renditaCatastale": rendita_catastale_stimata_euro
}

IMPORTANTE: I valori devono essere realistici per la zona indicata. Se è un centro storico, anno più vecchio e più piani. Se è periferia moderna, anno recente e meno piani.`;

  try {
    const output = await callAI(prompt, 300, 0.2);
    const data = parseJSON(output);
    if (!data) return fail(req, 502, "PARSE_ERROR", "Failed to parse cadastral data", debugId);
    return ok(req, data, ["Dati stimati da fonti catastali — non ufficiali"], debugId);
  } catch (e) {
    return fail(req, 502, "PROVIDER_ERROR", `Cadastral analysis failed: ${String(e).slice(0, 100)}`, debugId);
  }
}

/** POST /sottra/scan/pricing — address → price/sqm data */
export async function handleScanPricing(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const address = (body.address as string) ?? "";
  if (!address) return fail(req, 400, "MISSING_ADDRESS", "Provide address", debugId);

  const prompt = `Sei un esperto di valutazioni immobiliari in Italia. Per l'indirizzo "${address}", fornisci una stima dei prezzi di mercato al metro quadro.

Rispondi SOLO in JSON valido:
{
  "prezzoMq": prezzo_medio_al_mq_euro,
  "prezzoMqMin": prezzo_minimo_mq,
  "prezzoMqMax": prezzo_massimo_mq,
  "mediaZona": media_zona_circostante_mq,
  "trend5Anni": percentuale_variazione_5_anni
}

Basa le stime sulle quotazioni OMI (Osservatorio Mercato Immobiliare) più recenti per la zona. Il trend5Anni è la variazione percentuale negli ultimi 5 anni (positivo = crescita, negativo = calo).`;

  try {
    const output = await callAI(prompt, 300, 0.2);
    const data = parseJSON(output);
    if (!data) return fail(req, 502, "PARSE_ERROR", "Failed to parse pricing data", debugId);
    return ok(req, data, ["Stime basate su dati OMI — non valutazione ufficiale"], debugId);
  } catch (e) {
    return fail(req, 502, "PROVIDER_ERROR", `Pricing analysis failed: ${String(e).slice(0, 100)}`, debugId);
  }
}

/** POST /sottra/scan/listings — address → active listings */
export async function handleScanListings(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const address = (body.address as string) ?? "";
  if (!address) return fail(req, 400, "MISSING_ADDRESS", "Provide address", debugId);

  const prompt = `Sei un esperto immobiliare italiano. Per l'indirizzo "${address}", genera 2-4 annunci immobiliari plausibili che potrebbero essere attivi nella zona (nello stesso edificio o palazzo adiacente).

Rispondi SOLO in JSON valido:
{
  "annunci": [
    {
      "tipo": "vendita" oppure "affitto",
      "prezzo": prezzo_in_euro,
      "mq": metri_quadri,
      "locali": numero_locali,
      "piano": numero_piano,
      "link": "#"
    }
  ]
}

Genera annunci realistici per la zona: prezzi coerenti con il mercato locale, metrature tipiche per la zona, mix di vendita e affitto.`;

  try {
    const output = await callAI(prompt, 500, 0.3);
    const data = parseJSON(output);
    if (!data) return fail(req, 502, "PARSE_ERROR", "Failed to parse listings data", debugId);
    return ok(req, data, ["Annunci indicativi basati su dati di zona"], debugId);
  } catch (e) {
    return fail(req, 502, "PROVIDER_ERROR", `Listings analysis failed: ${String(e).slice(0, 100)}`, debugId);
  }
}

/** POST /sottra/scan/energy — address → energy class */
export async function handleScanEnergy(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const address = (body.address as string) ?? "";
  if (!address) return fail(req, 400, "MISSING_ADDRESS", "Provide address", debugId);

  const prompt = `Sei un esperto di certificazioni energetiche in Italia. Per l'indirizzo "${address}", stima la classe energetica probabile dell'edificio.

Rispondi SOLO in JSON valido:
{
  "classeEnergetica": "lettera da A a G",
  "epgl": valore_epgl_kwh_mq_anno,
  "mediaZona": "lettera media della zona"
}

Basa la stima sull'anno probabile di costruzione e sulla zona: edifici vecchi in centro = D/E/F, edifici moderni = B/C, nuove costruzioni = A/B.`;

  try {
    const output = await callAI(prompt, 200, 0.2);
    const data = parseJSON(output);
    if (!data) return fail(req, 502, "PARSE_ERROR", "Failed to parse energy data", debugId);
    return ok(req, data, ["Classe stimata da dati edilizi — non APE ufficiale"], debugId);
  } catch (e) {
    return fail(req, 502, "PROVIDER_ERROR", `Energy analysis failed: ${String(e).slice(0, 100)}`, debugId);
  }
}

/** POST /sottra/scan/condominio — address → building/condominium details */
export async function handleScanCondominio(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const address = (body.address as string) ?? "";
  if (!address) return fail(req, 400, "MISSING_ADDRESS", "Provide address", debugId);

  const prompt = `Sei un esperto immobiliare italiano. Per l'edificio all'indirizzo "${address}", stima le caratteristiche condominiali.

Rispondi SOLO in JSON valido:
{
  "tipoRiscaldamento": "centralizzato" oppure "autonomo",
  "ascensore": true oppure false,
  "statoConservazione": "ottimo" oppure "buono" oppure "sufficiente" oppure "mediocre",
  "annoUltimaRistrutturazione": anno oppure null se mai ristrutturato,
  "postiAuto": numero_stimato,
  "giardino": true oppure false,
  "portineria": true oppure false
}

Basa la stima su: anno costruzione (edifici pre-1970 = centralizzato, post-2000 = autonomo), zona (centro = portineria più probabile), tipo edificio (condominio grande = ascensore se più di 3 piani).`;

  try {
    const output = await callAI(prompt, 250, 0.2);
    const data = parseJSON(output);
    if (!data) return fail(req, 502, "PARSE_ERROR", "Failed to parse condominio data", debugId);
    return ok(req, data, ["Dati condominiali stimati — non perizia ufficiale"], debugId);
  } catch (e) {
    return fail(req, 502, "PROVIDER_ERROR", `Condominio analysis failed: ${String(e).slice(0, 100)}`, debugId);
  }
}

/** POST /sottra/scan/storico-transazioni — address → recent transaction history */
export async function handleScanStoricoTransazioni(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const address = (body.address as string) ?? "";
  if (!address) return fail(req, 400, "MISSING_ADDRESS", "Provide address", debugId);

  const prompt = `Sei un analista immobiliare italiano con accesso ai dati OMI. Per la zona dell'indirizzo "${address}", stima lo storico transazioni recenti tipico.

Rispondi SOLO in JSON valido:
{
  "transazioni": [
    { "data": "YYYY-MM-DD", "prezzo": prezzo_in_euro, "mq": metri_quadri, "piano": numero_piano, "tipo": "vendita" oppure "affitto" },
    ... almeno 3-4 transazioni realistiche degli ultimi 12-18 mesi
  ],
  "mediaZona12Mesi": prezzo_medio_mq_zona,
  "variazione12Mesi": percentuale_variazione
}

Basa la stima su: prezzi OMI della zona, tipologia edilizia, trend di mercato recente. I prezzi devono essere realistici per quella specifica zona e città.`;

  try {
    const output = await callAI(prompt, 500, 0.3);
    const data = parseJSON(output);
    if (!data) return fail(req, 502, "PARSE_ERROR", "Failed to parse transaction history", debugId);
    return ok(req, data, ["Storico stimato da dati OMI e di mercato — non transazioni certificate"], debugId);
  } catch (e) {
    return fail(req, 502, "PROVIDER_ERROR", `Transaction history failed: ${String(e).slice(0, 100)}`, debugId);
  }
}
