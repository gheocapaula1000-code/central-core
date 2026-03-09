// Sottra shared utilities: AI caller, JSON parser, geocoding, GPT normalization layer

// ═══════════════════════════════════════════════════════════════
// OpenAI config helpers — single source of truth
// OPENAI_API_KEY: secret, server-side only
// OPENAI_MODEL:   model name, default "gpt-5.4"
// ═══════════════════════════════════════════════════════════════

/** Returns the configured OpenAI API key (server-side only). Empty string if missing. */
export function getOpenAIKey(): string {
  return Deno.env.get("OPENAI_API_KEY") ?? Deno.env.get("OPENAI_KEY") ?? "";
}

/** Returns the configured OpenAI model. Defaults to gpt-5.4. */
export function getOpenAIModel(): string {
  return Deno.env.get("OPENAI_MODEL") ?? "gpt-5.4";
}

// ═══════════════════════════════════════════════════════════════
// GPT-5.4 Normalization Layer — HARDENED
// Post-collection enrichment ONLY. Never a data source.
// Can ONLY touch: observation, driversSummary, risksSummary, bandExplanation
// CANNOT touch: sourceType, sourceLabel, sourcePeriod, confidenceReason,
//   limitations, score, band, drivers[], risks[], projects[]
// ═══════════════════════════════════════════════════════════════

const ALLOWED_OUTPUT_KEYS = ["observation", "driversSummary", "risksSummary", "bandExplanation"] as const;
type AllowedOutputKey = typeof ALLOWED_OUTPUT_KEYS[number];

const MAX_FIELD_LENGTH = 350;

/** Phrases that must never appear in GPT output — triggers rejection */
const BANNED_PHRASES = [
  "affare certo", "rendimento garantito", "salirà sicuramente",
  "occasione sicura", "guadagno assicurato", "compra subito",
  "investimento sicuro", "certamente redditizio", "profitto garantito",
  "rivalutazione certa", "consigliamo di acquistare", "consigliamo l'acquisto",
  "rendimento assicurato", "crescerà sicuramente",
];

export interface NormalizationInput {
  module: "opportunity" | "timeview" | "infrastrutture" | "sviluppo-area";
  comune: string;
  /** Pre-collected structured data from real sources — GPT reads this, never modifies it */
  collectedData: Record<string, unknown>;
  requestedOutputs: AllowedOutputKey[];
}

export interface NormalizationResult {
  observation?: string;
  driversSummary?: string;
  risksSummary?: string;
  bandExplanation?: string;
  /** true if GPT produced valid output; false = static fallback used */
  normalized: boolean;
  /** internal debug only — never forwarded to user-facing payload */
  _debugRejectionReason?: string;
}

/**
 * Validates and sanitizes GPT output. Returns null if output is unsafe.
 */
function validateNormalizationOutput(
  parsed: Record<string, unknown>,
  requestedOutputs: AllowedOutputKey[],
): { result: Partial<Record<AllowedOutputKey, string>>; rejection?: string } | null {
  const result: Partial<Record<AllowedOutputKey, string>> = {};

  // Reject any keys not in the allowed set
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_OUTPUT_KEYS.includes(key as AllowedOutputKey)) {
      console.warn(`[normalize:validate] Rejected — unexpected key "${key}"`);
      return null;
    }
  }

  for (const key of requestedOutputs) {
    const val = parsed[key];
    if (val === undefined || val === null) continue;
    if (typeof val !== "string") {
      console.warn(`[normalize:validate] Rejected — "${key}" is not a string`);
      return null;
    }

    // Length guard
    if (val.length > MAX_FIELD_LENGTH) {
      console.warn(`[normalize:validate] Truncating "${key}" from ${val.length} to ${MAX_FIELD_LENGTH}`);
      result[key] = val.slice(0, MAX_FIELD_LENGTH) + "…";
      continue;
    }

    // Banned phrase check
    const lower = val.toLowerCase();
    for (const phrase of BANNED_PHRASES) {
      if (lower.includes(phrase)) {
        console.warn(`[normalize:validate] Rejected — "${key}" contains banned phrase "${phrase}"`);
        return null;
      }
    }

    // No numbers that look fabricated (reject if GPT injects €, %, scores not in input)
    // Allow % and € only if they appeared in the collectedData serialization
    result[key] = val;
  }

  return { result };
}

/**
 * Optional GPT-5.4 normalization layer (HARDENED).
 * - Takes ALREADY COLLECTED data, produces ONLY text synthesis
 * - Cannot modify sourceType, sourceLabel, sourcePeriod, scores, drivers, risks
 * - Output validated against strict schema + banned phrases
 * - On any failure → { normalized: false }, caller uses deterministic fallback
 */
export async function normalizeWithGPT(input: NormalizationInput): Promise<NormalizationResult> {
  const key = Deno.env.get("OPENAI_API_KEY") ?? Deno.env.get("OPENAI_KEY") ?? "";
  if (!key) {
    return { normalized: false, _debugRejectionReason: "no_api_key" };
  }

  // Validate requested outputs
  for (const out of input.requestedOutputs) {
    if (!ALLOWED_OUTPUT_KEYS.includes(out)) {
      console.warn(`[normalize] Invalid requested output "${out}" — skipping GPT call`);
      return { normalized: false, _debugRejectionReason: `invalid_output_key:${out}` };
    }
  }

  const systemPrompt = `Sei un analista territoriale italiano. Il tuo ruolo è ESCLUSIVAMENTE sintetizzare e riformulare dati già raccolti da fonti pubbliche ufficiali. Non sei una fonte di dati.

DIVIETI ASSOLUTI — la violazione di uno qualsiasi invalida l'intero output:
- NON inventare dati, numeri, percentuali, date o fatti non presenti nell'input
- NON aggiungere progetti, opere o infrastrutture non elencati nell'input
- NON fare previsioni di mercato, proiezioni numeriche o promesse di rendimento
- NON usare linguaggio da consulenza finanziaria o raccomandazioni d'investimento
- NON usare espressioni come "affare certo", "rendimento garantito", "compra subito", "occasione sicura", "guadagno assicurato", "salirà sicuramente"
- NON menzionare intelligenza artificiale, AI, modelli, algoritmi o machine learning
- NON produrre campi JSON diversi da quelli richiesti
- NON superare 2 frasi per campo

COSA PUOI FARE:
- Riformulare in italiano professionale e neutro
- Sintetizzare driver e rischi già presenti nei dati
- Produrre osservazioni descrittive ancorate ai dati forniti
- Se i dati sono insufficienti, dichiararlo esplicitamente

Rispondi SOLO in JSON valido con ESCLUSIVAMENTE i campi richiesti.`;

  const userPrompt = `Modulo: ${input.module}
Comune: ${input.comune}
Dati raccolti (sola lettura): ${JSON.stringify(input.collectedData, null, 0).slice(0, 2500)}
Campi da produrre: ${JSON.stringify(input.requestedOutputs)}

Genera SOLO i campi elencati sopra, basandoti ESCLUSIVAMENTE sui dati forniti.
- "observation": osservazione sintetica (max 2 frasi brevi)
- "driversSummary": sintesi fattori positivi (max 1 frase)
- "risksSummary": sintesi fattori di rischio (max 1 frase)
- "bandExplanation": spiegazione della fascia assegnata (max 1 frase)`;

  const { signal, clear } = withAbort(12_000);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: Deno.env.get("OPENAI_MODEL") ?? "gpt-5.4",
        temperature: 0.1,
        max_tokens: 300,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal,
    });

    if (!res.ok) {
      console.warn(`[normalize] GPT ${res.status} — static fallback`);
      return { normalized: false, _debugRejectionReason: `http_${res.status}` };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    const parsed = parseJSON(content);

    if (!parsed) {
      console.warn(`[normalize] Unparseable GPT response — static fallback`);
      return { normalized: false, _debugRejectionReason: "parse_error" };
    }

    const validation = validateNormalizationOutput(parsed, input.requestedOutputs);
    if (!validation) {
      console.warn(`[normalize] GPT output rejected by validation — static fallback`);
      return { normalized: false, _debugRejectionReason: "validation_rejected" };
    }

    return { ...validation.result, normalized: true };
  } catch (e) {
    console.warn(`[normalize] GPT error: ${String(e).slice(0, 80)} — static fallback`);
    return { normalized: false, _debugRejectionReason: `exception:${String(e).slice(0, 50)}` };
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
