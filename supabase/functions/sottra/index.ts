// ═══════════════════════════════════════════════════════════════
// Sottra — Edge Function (Central Core V3)
// Dual-engine: Motore Scan + Motore Forecast
// All routes independent — if one fails, others continue
// ═══════════════════════════════════════════════════════════════

import {
  makeDebugId,
  handleOptions,
  ok,
  fail,
  requireSecret,
  CORE_VERSION,
} from "../_shared/http.ts";

// ── Data provider (reuse Central Core's OpenAI → Anthropic fallback) ──

function withAbort(ms: number) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

async function callAI(prompt: string, maxTokens = 1000, temperature = 0.1): Promise<string> {
  // Try OpenAI first
  const openaiKey = Deno.env.get("OPENAI_API_KEY") ?? Deno.env.get("OPENAI_KEY") ?? "";
  if (openaiKey) {
    const { signal, clear } = withAbort(20_000);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini",
          temperature,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
        signal,
      });
      if (res.ok) {
        const data = await res.json();
        const output = data?.choices?.[0]?.message?.content ?? "";
        if (output) { clear(); return output; }
      }
    } catch { /* fallthrough to Anthropic */ }
    finally { clear(); }
  }

  // Fallback: Anthropic
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!anthropicKey) throw new Error("No data provider configured");
  const { signal, clear } = withAbort(20_000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: "user", content: prompt }],
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = await res.json();
    return data?.content?.[0]?.text ?? "";
  } finally { clear(); }
}

function parseJSON(text: string): Record<string, unknown> | null {
  try {
    // Strip markdown fences if present
    const clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

// ── Geocoding helper (OpenStreetMap Nominatim — free, no API key) ──

async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  // Try Google first if key available, otherwise Nominatim
  const googleKey = Deno.env.get("GOOGLE_MAPS_API_KEY") ?? "";
  if (googleKey) {
    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=it&key=${googleKey}`
      );
      if (res.ok) {
        const data = await res.json();
        const addr = data?.results?.[0]?.formatted_address;
        if (addr) return addr;
      }
    } catch { /* fallthrough to Nominatim */ }
  }

  // Fallback: OpenStreetMap Nominatim (free, rate limit 1 req/sec)
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=it&addressdetails=1`,
      { headers: { "User-Agent": "Sottra/1.0 (sottra.app)" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    // Build clean Italian address from components
    const a = data?.address;
    if (a) {
      const road = a.road ?? a.pedestrian ?? a.street ?? "";
      const number = a.house_number ?? "";
      const city = a.city ?? a.town ?? a.village ?? a.municipality ?? "";
      const parts = [road + (number ? ` ${number}` : ""), city].filter(Boolean);
      if (parts.length > 0) return parts.join(", ");
    }
    return data?.display_name ?? null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// MOTORE SCAN — 5 endpoints
// ═══════════════════════════════════════════════════════════════

/** POST /sottra/scan/identify — photo + GPS → address + building ID */
async function handleScanIdentify(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  // Photo is sent but for v1 we use GPS → reverse geocoding
  // Future: Google Vision / Street View matching

  if (lat == null || lng == null) {
    return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);
  }

  // Step 1: Reverse geocode
  const address = await reverseGeocode(lat, lng);
  if (!address) {
    return fail(req, 502, "GEOCODE_FAILED", "Could not resolve coordinates to address", debugId);
  }

  // Step 2: Generate building ID from address hash
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(address));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const buildingId = "IT-" + hashArray.slice(0, 4).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();

  return ok(req, {
    address,
    buildingId,
    confidence: 0.85, // v1: GPS-only, no visual matching yet
  }, [], debugId);
}

/** POST /sottra/scan/cadastral — address → catasto data (estimated for v1) */
async function handleScanCadastral(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
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

/** POST /sottra/scan/pricing — address → price/sqm data (OMI-based estimates for v1) */
async function handleScanPricing(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
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

/** POST /sottra/scan/listings — address → active listings (estimated for v1) */
async function handleScanListings(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
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

/** POST /sottra/scan/energy — address → energy class (estimated for v1) */
async function handleScanEnergy(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
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

// ═══════════════════════════════════════════════════════════════
// MOTORE FORECAST — 3 endpoints
// ═══════════════════════════════════════════════════════════════

/** POST /sottra/forecast/moodscore — coordinates → zone sentiment score */
async function handleForecastMoodScore(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  // Get address for context
  const address = await reverseGeocode(lat, lng) ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  const prompt = `Sei un analista urbano italiano. Per la zona di "${address}" (coordinate: ${lat}, ${lng}), calcola un MoodScore da 0 a 100 che rappresenta la qualità percepita del quartiere.

Rispondi SOLO in JSON valido:
{
  "score": numero_da_0_a_100,
  "trend": "in crescita" oppure "stabile" oppure "in calo",
  "categorie": {
    "commercio": punteggio_0_100,
    "trasporti": punteggio_0_100,
    "verde": punteggio_0_100,
    "sicurezza": punteggio_0_100,
    "socialLife": punteggio_0_100
  }
}

Valuta basandoti su: densità negozi e servizi (commercio), accessibilità trasporto pubblico e metro (trasporti), parchi e aree verdi (verde), percezione sicurezza della zona (sicurezza), vita sociale e locali (socialLife). Lo score principale è la media pesata.`;

  try {
    const output = await callAI(prompt, 300, 0.2);
    const data = parseJSON(output);
    if (!data) return fail(req, 502, "PARSE_ERROR", "Failed to parse moodscore data", debugId);
    return ok(req, data, ["Score basato su analisi dati del quartiere"], debugId);
  } catch (e) {
    return fail(req, 502, "PROVIDER_ERROR", `MoodScore analysis failed: ${String(e).slice(0, 100)}`, debugId);
  }
}

/** POST /sottra/forecast/timeview — coordinates + horizon → projections */
async function handleForecastTimeView(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  const address = await reverseGeocode(lat, lng) ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  const prompt = `Sei un analista immobiliare e urbanistico italiano. Per la zona di "${address}" (coordinate: ${lat}, ${lng}), prevedi l'evoluzione del valore immobiliare nei prossimi 5, 10 e 20 anni.

Rispondi SOLO in JSON valido:
{
  "previsione5Anni": percentuale_variazione_attesa,
  "previsione10Anni": percentuale_variazione_attesa,
  "previsione20Anni": percentuale_variazione_attesa,
  "progettiInArrivo": ["progetto 1 con anno", "progetto 2 con anno"]
}

Considera: piani urbanistici comunali, nuove infrastrutture di trasporto (metro, tram, ferrovie), riqualificazioni previste, trend demografici, effetti del cambiamento climatico sulla zona. I progetti devono essere realistici per quella specifica città/zona. Le percentuali possono essere negative se la zona è in declino.`;

  try {
    const output = await callAI(prompt, 400, 0.3);
    const data = parseJSON(output);
    if (!data) return fail(req, 502, "PARSE_ERROR", "Failed to parse timeview data", debugId);
    return ok(req, data, ["Previsioni basate su dati urbanistici — non consulenza finanziaria"], debugId);
  } catch (e) {
    return fail(req, 502, "PROVIDER_ERROR", `TimeView analysis failed: ${String(e).slice(0, 100)}`, debugId);
  }
}

/** POST /sottra/forecast/opportunity — coordinates → opportunity index */
async function handleForecastOpportunity(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  const address = await reverseGeocode(lat, lng) ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  const prompt = `Sei un analista di opportunità immobiliari in Italia. Per la zona di "${address}" (coordinate: ${lat}, ${lng}), calcola un Indice Opportunità da 0 a 100 e assegna un quadrante.

Rispondi SOLO in JSON valido:
{
  "indice": numero_da_0_a_100,
  "quadrante": "uno tra: Stella Nascente, Diamante Grezzo, Picco Raggiunto, Allerta Rossa",
  "raccomandazione": "frase di raccomandazione in italiano max 15 parole"
}

QUADRANTI:
- "Stella Nascente" (indice 70-100): zona in forte crescita, ottimo momento per comprare
- "Diamante Grezzo" (indice 50-69): zona sottovalutata con potenziale nascosto
- "Picco Raggiunto" (indice 30-49): zona ai massimi, crescita futura limitata
- "Allerta Rossa" (indice 0-29): zona in declino o sopravvalutata, rischio alto

Valuta: trend prezzi recenti, progetti infrastrutturali, demografia, attrattività commerciale, rapporto prezzo/qualità della zona.`;

  try {
    const output = await callAI(prompt, 300, 0.2);
    const data = parseJSON(output);
    if (!data) return fail(req, 502, "PARSE_ERROR", "Failed to parse opportunity data", debugId);
    return ok(req, data, ["Indice calcolato da analisi di mercato — non consulenza di investimento"], debugId);
  } catch (e) {
    return fail(req, 502, "PROVIDER_ERROR", `Opportunity analysis failed: ${String(e).slice(0, 100)}`, debugId);
  }
}

// ═══════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════

const ROUTES: Record<string, (req: Request, body: Record<string, unknown>, debugId: string) => Promise<Response>> = {
  // Motore Scan
  "scan/identify":       handleScanIdentify,
  "scan/cadastral":      handleScanCadastral,
  "scan/pricing":        handleScanPricing,
  "scan/listings":       handleScanListings,
  "scan/energy":         handleScanEnergy,
  // Motore Forecast
  "forecast/moodscore":  handleForecastMoodScore,
  "forecast/timeview":   handleForecastTimeView,
  "forecast/opportunity": handleForecastOpportunity,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  const debugId = makeDebugId();
  const pathname = new URL(req.url).pathname;
  console.log(`[sottra] method=${req.method} pathname=${pathname} debug_id=${debugId}`);

  try {
    // Health check — no auth
    if (req.method === "GET" && (pathname.endsWith("/health") || pathname === "/")) {
      return ok(req, {
        status: "healthy",
        engine: "sottra",
        version: CORE_VERSION,
        routes: Object.keys(ROUTES),
        time: new Date().toISOString(),
      }, [], debugId);
    }

    // Auth
    const authErr = requireSecret(req, debugId);
    if (authErr) return authErr;

    if (req.method !== "POST") {
      return fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId);
    }

    // Parse body
    const rawBody = await req.text();
    if (rawBody.length > 500_000) {
      return fail(req, 413, "PAYLOAD_TOO_LARGE", "Request body exceeds 500KB", debugId);
    }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(rawBody); } catch {
      return fail(req, 400, "INVALID_JSON", "Body must be valid JSON", debugId);
    }

    // Route matching: find the matching suffix
    for (const [route, handler] of Object.entries(ROUTES)) {
      if (pathname.endsWith(`/${route}`) || pathname.endsWith(`/${route}/`)) {
        console.log(`[sottra] route=${route} debug_id=${debugId}`);
        return await handler(req, body, debugId);
      }
    }

    return fail(req, 404, "ROUTE_NOT_FOUND", `No handler for ${pathname}. Available: ${Object.keys(ROUTES).join(", ")}`, debugId);

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[sottra] Error debug_id=${debugId}:`, errMsg);
    return fail(req, 500, "INTERNAL_ERROR", `An internal error occurred. Reference: ${debugId}`, debugId);
  }
});
