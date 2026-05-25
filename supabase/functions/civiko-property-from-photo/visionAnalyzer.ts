// ═══════════════════════════════════════════════════════════════
// Vision Analyzer — analizza la foto di un edificio con OpenAI
// (fallback Anthropic) e restituisce un oggetto strutturato.
//
// - Mai bloccante: timeout 15s per provider.
// - In caso di errore restituisce un default sicuro.
// - Le chiavi vengono lette da OPENAI_API_KEY e ANTHROPIC_API_KEY.
// ═══════════════════════════════════════════════════════════════

export interface VisionAnalysis {
  tipologiaProbabile: string;
  pianoStimato: string | null;
  statoApparente: string;
  puntiDiForzaVisivi: string[];
  materialePresunto: string | null;
  annoPresunto: string | null;
  presenzaGiardino: boolean;
  presenzaParcheggio: boolean;
}

const SYSTEM_PROMPT =
  "Sei un esperto di valutazione immobiliare italiana. Analizza la foto " +
  "di un edificio e rispondi SOLO con un oggetto JSON valido, senza " +
  "markdown, senza testo aggiuntivo.";

const USER_PROMPT =
  "Analizza questa foto di un edificio italiano e restituisci un JSON " +
  "con esattamente questi campi:\n" +
  "- tipologiaProbabile: tipo di immobile (es. 'Condominio anni 70', 'Villa singola', 'Palazzo storico', 'Capannone industriale')\n" +
  "- pianoStimato: numero di piani visibili come stringa o null\n" +
  "- statoApparente: una di queste opzioni esatte: 'Ottime condizioni', 'Buone condizioni', 'Condizioni discrete', 'Da ristrutturare', 'Fatiscente'\n" +
  "- puntiDiForzaVisivi: array di stringhe con caratteristiche positive visibili (giardino, box auto, terrazza, portineria, facciata recente, ecc.). Array vuoto se nessuna.\n" +
  "- materialePresunto: materiale principale della facciata o null\n" +
  "- annoPresunto: range di anni stimato (es. '1960-1975') o null\n" +
  "- presenzaGiardino: true o false\n" +
  "- presenzaParcheggio: true o false";

const TIMEOUT_MS = 15_000;

const DEFAULT_ANALYSIS: VisionAnalysis = {
  tipologiaProbabile: "Immobile residenziale",
  pianoStimato: null,
  statoApparente: "Buone condizioni",
  puntiDiForzaVisivi: [],
  materialePresunto: null,
  annoPresunto: null,
  presenzaGiardino: false,
  presenzaParcheggio: false,
};

function extractJson(text: string): unknown | null {
  if (!text) return null;
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return null;
}

function coerce(raw: unknown): VisionAnalysis | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
    return null;
  };
  const arr = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
  };
  const bool = (v: unknown): boolean => v === true || v === "true";

  return {
    tipologiaProbabile: str(r.tipologiaProbabile) ?? DEFAULT_ANALYSIS.tipologiaProbabile,
    pianoStimato: str(r.pianoStimato),
    statoApparente: str(r.statoApparente) ?? DEFAULT_ANALYSIS.statoApparente,
    puntiDiForzaVisivi: arr(r.puntiDiForzaVisivi),
    materialePresunto: str(r.materialePresunto),
    annoPresunto: str(r.annoPresunto),
    presenzaGiardino: bool(r.presenzaGiardino),
    presenzaParcheggio: bool(r.presenzaParcheggio),
  };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAIVision(photoDataUrl: string): Promise<VisionAnalysis | null> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return null;
  try {
    const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.2,
        max_tokens: 600,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: USER_PROMPT },
              { type: "image_url", image_url: { url: photoDataUrl } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[visionAnalyzer] OpenAI status=${res.status}`);
      return null;
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    return coerce(extractJson(typeof text === "string" ? text : JSON.stringify(text)));
  } catch (e) {
    console.warn(`[visionAnalyzer] OpenAI error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function callAnthropicVision(photoDataUrl: string): Promise<VisionAnalysis | null> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return null;
  // DataURL → (mediaType, base64)
  const m = photoDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return null;
  const mediaType = m[1];
  const b64 = m[2];
  try {
    const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 700,
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
              { type: "text", text: USER_PROMPT },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[visionAnalyzer] Anthropic status=${res.status}`);
      return null;
    }
    const data = await res.json();
    const text = data?.content?.[0]?.text ?? "";
    return coerce(extractJson(typeof text === "string" ? text : ""));
  } catch (e) {
    console.warn(`[visionAnalyzer] Anthropic error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Analizza la foto e restituisce VisionAnalysis.
 * Non lancia mai eccezioni: in caso di errore o input mancante restituisce
 * un default sicuro.
 *
 * @param photoDataUrl  DataURL "data:image/jpeg;base64,..."
 * @param _supabaseUrl  Riservato per evoluzioni future (relay via ai-core-run).
 * @param _serviceRoleKey Riservato per evoluzioni future.
 */
export async function analyzePhotoWithVision(
  photoDataUrl: string | undefined | null,
  _supabaseUrl?: string,
  _serviceRoleKey?: string,
): Promise<VisionAnalysis> {
  if (!photoDataUrl || typeof photoDataUrl !== "string" || !photoDataUrl.startsWith("data:image/")) {
    return { ...DEFAULT_ANALYSIS };
  }
  const primary = await callOpenAIVision(photoDataUrl);
  if (primary) return primary;
  const fallback = await callAnthropicVision(photoDataUrl);
  if (fallback) return fallback;
  return { ...DEFAULT_ANALYSIS };
}
