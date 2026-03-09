// Sottra shared utilities: AI caller, JSON parser, geocoding, GPT normalization layer

// ═══════════════════════════════════════════════════════════════
// GPT-5.4 Normalization Layer — post-collection enrichment ONLY
// NEVER used as data source. Only normalizes/synthesizes collected data.
// ═══════════════════════════════════════════════════════════════

export interface NormalizationInput {
  /** Module requesting normalization */
  module: "opportunity" | "timeview" | "infrastrutture" | "sviluppo-area";
  /** Comune name */
  comune: string;
  /** Pre-collected structured data from real sources */
  collectedData: Record<string, unknown>;
  /** What to produce */
  requestedOutputs: ("observation" | "driversSummary" | "risksSummary" | "bandExplanation")[];
}

export interface NormalizationResult {
  observation?: string;
  driversSummary?: string;
  risksSummary?: string;
  bandExplanation?: string;
  normalized: boolean;
}

const NORMALIZATION_ENABLED_KEY = "OPENAI_API_KEY";

/**
 * Optional GPT-5.4 normalization layer.
 * Takes ALREADY COLLECTED data and produces structured synthesis.
 * If OpenAI key missing or call fails, returns { normalized: false } — caller uses static fallback.
 * NEVER invents data. Prompt explicitly forbids fabrication.
 */
export async function normalizeWithGPT(input: NormalizationInput): Promise<NormalizationResult> {
  const key = Deno.env.get(NORMALIZATION_ENABLED_KEY) ?? Deno.env.get("OPENAI_KEY") ?? "";
  if (!key) {
    console.log(`[normalize] GPT layer disabled — no API key`);
    return { normalized: false };
  }

  const systemPrompt = `Sei un analista territoriale italiano. Il tuo ruolo è SOLO sintetizzare e normalizzare dati già raccolti da fonti pubbliche ufficiali.

REGOLE ASSOLUTE:
- NON inventare dati, numeri, percentuali o fatti non presenti nell'input
- NON fare previsioni di mercato o promesse di rendimento
- NON usare linguaggio da consulenza finanziaria
- NON menzionare intelligenza artificiale, AI, modelli o algoritmi
- Scrivi in italiano professionale, chiaro e neutro
- Se i dati sono insufficienti, dillo esplicitamente
- Ogni affermazione deve essere riconducibile ai dati forniti

Rispondi SOLO in JSON valido con i campi richiesti.`;

  const userPrompt = `Modulo: ${input.module}
Comune: ${input.comune}
Dati raccolti: ${JSON.stringify(input.collectedData, null, 0).slice(0, 3000)}
Output richiesti: ${JSON.stringify(input.requestedOutputs)}

Per ogni output richiesto, genera una sintesi basata ESCLUSIVAMENTE sui dati forniti sopra.
- "observation": osservazione sintetica incisiva (max 2 frasi), senza claim assoluti
- "driversSummary": sintesi dei principali fattori positivi (max 1 frase)
- "risksSummary": sintesi dei principali fattori di rischio (max 1 frase)
- "bandExplanation": spiegazione leggibile della fascia/band assegnata (max 1 frase)

Rispondi in JSON: { "observation": "...", "driversSummary": "...", "risksSummary": "...", "bandExplanation": "..." }
Includi solo i campi richiesti.`;

  const { signal, clear } = withAbort(12_000);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: Deno.env.get("OPENAI_MODEL") ?? "gpt-5.4",
        temperature: 0.15,
        max_tokens: 400,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal,
    });

    if (!res.ok) {
      console.warn(`[normalize] GPT returned ${res.status} — using static fallback`);
      return { normalized: false };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    const parsed = parseJSON(content);

    if (!parsed) {
      console.warn(`[normalize] GPT returned unparseable response — using static fallback`);
      return { normalized: false };
    }

    return {
      observation: typeof parsed.observation === "string" ? parsed.observation : undefined,
      driversSummary: typeof parsed.driversSummary === "string" ? parsed.driversSummary : undefined,
      risksSummary: typeof parsed.risksSummary === "string" ? parsed.risksSummary : undefined,
      bandExplanation: typeof parsed.bandExplanation === "string" ? parsed.bandExplanation : undefined,
      normalized: true,
    };
  } catch (e) {
    console.warn(`[normalize] GPT call failed: ${String(e).slice(0, 100)} — using static fallback`);
    return { normalized: false };
  } finally {
    clear();
  }
}

export function withAbort(ms: number) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

export async function callAI(prompt: string, maxTokens = 1000, temperature = 0.1): Promise<string> {
  const openaiKey = Deno.env.get("OPENAI_API_KEY") ?? Deno.env.get("OPENAI_KEY") ?? "";
  if (openaiKey) {
    const { signal, clear } = withAbort(20_000);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: Deno.env.get("OPENAI_MODEL") ?? "gpt-5.4",
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

/**
 * Call AI with image (vision). Accepts a base64 data URL.
 * Falls back to text-only callAI if vision fails.
 */
export async function callAIVision(
  prompt: string,
  imageBase64: string,
  maxTokens = 1000,
  temperature = 0.1
): Promise<string> {
  const match = imageBase64.match(/^data:(image\/\w+);base64,(.+)$/);
  const mediaType = match?.[1] ?? "image/jpeg";
  const base64Data = match?.[2] ?? imageBase64;

  // Try OpenAI GPT-5.4 first (supports vision natively)
  const openaiKey = Deno.env.get("OPENAI_API_KEY") ?? Deno.env.get("OPENAI_KEY") ?? "";
  if (openaiKey) {
    const { signal, clear } = withAbort(30_000);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          temperature,
          max_tokens: maxTokens,
          messages: [{
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:${mediaType};base64,${base64Data}`, detail: "low" } },
              { type: "text", text: prompt },
            ],
          }],
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

  // Fallback: Anthropic Claude (supports vision)
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (anthropicKey) {
    const { signal, clear } = withAbort(30_000);
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
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
              { type: "text", text: prompt },
            ],
          }],
        }),
        signal,
      });
      if (res.ok) {
        const data = await res.json();
        return data?.content?.[0]?.text ?? "";
      }
    } catch { /* fallthrough to text-only */ }
    finally { clear(); }
  }

  // Last resort: text-only without image
  return callAI(prompt, maxTokens, temperature);
}

export function parseJSON(text: string): Record<string, unknown> | null {
  try {
    const clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
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

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=it&addressdetails=1`,
      { headers: { "User-Agent": "Sottra/1.0 (sottra.app)" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
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
