// ═══════════════════════════════════════════════════════════════
// Vision Analyzer — analisi per-foto ed aggregata di immobili.
//
// - Provider: Lovable AI Gateway (Gemini) → fallback OpenAI → Anthropic.
// - Analisi per-ambiente: ogni foto riceve `ambiente_proposto` + confidence
//   e (se interno) materiali/pavimenti/finiture/sanitari/luce/stato.
// - Aggregato: `ambientiRilevati`, `cucinaConfig`, `spaziEsterni`,
//   `bagnoDettagli`. Nessuna invenzione: sanitari, spazi esterni e
//   materiali riportati solo se realmente rilevati.
// - Non blocca il chiamante: in caso di errore restituisce default onesti.
// ═══════════════════════════════════════════════════════════════

export type AmbienteTag =
  | "esterno"
  | "soggiorno"
  | "cucina"
  | "camera"
  | "cameretta"
  | "bagno"
  | "terrazzo_balcone"
  | "giardino"
  | "altro";

export const AMBIENTE_VALUES: AmbienteTag[] = [
  "esterno", "soggiorno", "cucina", "camera", "cameretta",
  "bagno", "terrazzo_balcone", "giardino", "altro",
];

export interface VisionAnalysis {
  // Campi legacy (invariati).
  tipologiaProbabile: string;
  pianoStimato: string | null;
  statoApparente: string;
  puntiDiForzaVisivi: string[];
  materialePresunto: string | null;
  annoPresunto: string | null;
  presenzaGiardino: boolean;
  presenzaParcheggio: boolean;
  // Campi aggiunti (per-foto).
  ambiente_proposto?: AmbienteTag;
  ambiente_confidence?: number;
  materialiPavimenti?: string | null;
  finiture?: string | null;
  sanitariVisibili?: string[];        // solo se effettivamente visti (vasca | doccia | ...)
  luceNaturale?: string | null;       // es. "abbondante", "media", "scarsa"
  statoConservazione?: string | null; // opinione visiva per l'interno
  elementiCucinaVisibili?: string[];  // usato per capire angolo cottura vs cucina abitabile
}

export interface AggregatedVisionAnalysis extends VisionAnalysis {
  fotoAnalizzate: number;
  visionStatus: "ok" | "parziale" | "non_disponibile";
  ambientiRilevati: Record<string, number>;
  cucinaConfig: "cucina abitabile" | "angolo cottura" | "non visibile";
  spaziEsterni: Array<"terrazzo_balcone" | "giardino">;
  bagnoDettagli: string[]; // solo sanitari visti (vasca/doccia/...)
  perPhoto: Array<{
    index: number;
    ambiente: AmbienteTag;
    confidence: number;
    materialiPavimenti: string | null;
    finiture: string | null;
    sanitariVisibili: string[];
    luceNaturale: string | null;
    statoConservazione: string | null;
    elementiCucinaVisibili: string[];
  }>;
}

const SYSTEM_PROMPT =
  "Sei un esperto di valutazione immobiliare italiana. Analizza la foto " +
  "di un immobile (esterno o interno) e rispondi SOLO con un oggetto " +
  "JSON valido, senza markdown né testo aggiuntivo. Non inventare mai " +
  "elementi non visibili: se non li vedi lascia null o array vuoto.";

const USER_PROMPT =
  "Analizza questa foto e restituisci un JSON con esattamente questi campi:\n" +
  "- tipologiaProbabile: tipo di immobile (es. 'Condominio anni 70', 'Villa singola', 'Palazzo storico') oppure descrizione dell'ambiente interno\n" +
  "- pianoStimato: numero di piani visibili come stringa o null\n" +
  "- statoApparente: una tra 'Ottime condizioni', 'Buone condizioni', 'Condizioni discrete', 'Da ristrutturare', 'Fatiscente'\n" +
  "- puntiDiForzaVisivi: array di caratteristiche positive REALMENTE visibili (array vuoto se nessuna)\n" +
  "- materialePresunto: materiale principale visibile o null\n" +
  "- annoPresunto: range di anni stimato (es. '1960-1975') o null\n" +
  "- presenzaGiardino: true SOLO se giardino visibile in questa foto\n" +
  "- presenzaParcheggio: true SOLO se parcheggio/box visibile in questa foto\n" +
  "- ambiente_proposto: uno tra 'esterno','soggiorno','cucina','camera','cameretta','bagno','terrazzo_balcone','giardino','altro'\n" +
  "- ambiente_confidence: numero tra 0 e 1\n" +
  "- materialiPavimenti: descrizione breve dei pavimenti visibili o null (es. 'parquet rovere','gres porcellanato','marmo')\n" +
  "- finiture: descrizione breve delle finiture (pareti/porte/infissi) o null\n" +
  "- sanitariVisibili: array che può contenere SOLO 'vasca' e/o 'doccia' se effettivamente visibili; array vuoto altrimenti\n" +
  "- luceNaturale: 'abbondante' | 'media' | 'scarsa' | null\n" +
  "- statoConservazione: breve nota sullo stato interno o null\n" +
  "- elementiCucinaVisibili: array di elementi cottura visibili (es. 'piano cottura','forno','cappa','frigorifero','lavello'); array vuoto se non se ne vedono";

const TIMEOUT_MS = 15_000;
const MAX_PHOTOS = 10;

const DEFAULT_ANALYSIS: VisionAnalysis = {
  tipologiaProbabile: "Immobile residenziale",
  pianoStimato: null,
  statoApparente: "Buone condizioni",
  puntiDiForzaVisivi: [],
  materialePresunto: null,
  annoPresunto: null,
  presenzaGiardino: false,
  presenzaParcheggio: false,
  ambiente_proposto: "altro",
  ambiente_confidence: 0,
  materialiPavimenti: null,
  finiture: null,
  sanitariVisibili: [],
  luceNaturale: null,
  statoConservazione: null,
  elementiCucinaVisibili: [],
};

function extractJson(text: string): unknown | null {
  if (!text) return null;
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return null;
}

function coerceAmbiente(v: unknown): AmbienteTag {
  if (typeof v !== "string") return "altro";
  const s = v.trim().toLowerCase();
  return (AMBIENTE_VALUES as string[]).includes(s) ? (s as AmbienteTag) : "altro";
}

function coerceSanitari(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const allowed = new Set(["vasca", "doccia", "bidet", "wc", "lavabo"]);
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const s = x.trim().toLowerCase();
    if (allowed.has(s)) out.push(s);
  }
  return Array.from(new Set(out));
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
  const conf = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  };

  return {
    tipologiaProbabile: str(r.tipologiaProbabile) ?? DEFAULT_ANALYSIS.tipologiaProbabile,
    pianoStimato: str(r.pianoStimato),
    statoApparente: str(r.statoApparente) ?? DEFAULT_ANALYSIS.statoApparente,
    puntiDiForzaVisivi: arr(r.puntiDiForzaVisivi),
    materialePresunto: str(r.materialePresunto),
    annoPresunto: str(r.annoPresunto),
    presenzaGiardino: bool(r.presenzaGiardino),
    presenzaParcheggio: bool(r.presenzaParcheggio),
    ambiente_proposto: coerceAmbiente(r.ambiente_proposto),
    ambiente_confidence: conf(r.ambiente_confidence),
    materialiPavimenti: str(r.materialiPavimenti),
    finiture: str(r.finiture),
    sanitariVisibili: coerceSanitari(r.sanitariVisibili),
    luceNaturale: str(r.luceNaturale),
    statoConservazione: str(r.statoConservazione),
    elementiCucinaVisibili: arr(r.elementiCucinaVisibili),
  };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function callLovableAIVision(photoDataUrl: string): Promise<VisionAnalysis | null> {
  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) return null;
  try {
    const res = await fetchWithTimeout("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: [
            { type: "text", text: USER_PROMPT },
            { type: "image_url", image_url: { url: photoDataUrl } },
          ]},
        ],
      }),
    });
    if (!res.ok) { console.warn(`[visionAnalyzer] Lovable AI status=${res.status}`); return null; }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    return coerce(extractJson(typeof text === "string" ? text : JSON.stringify(text)));
  } catch (e) {
    console.warn(`[visionAnalyzer] Lovable AI error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function callOpenAIVision(photoDataUrl: string): Promise<VisionAnalysis | null> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return null;
  try {
    const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.2,
        max_completion_tokens: 700,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: [
            { type: "text", text: USER_PROMPT },
            { type: "image_url", image_url: { url: photoDataUrl } },
          ]},
        ],
      }),
    });
    if (!res.ok) { console.warn(`[visionAnalyzer] OpenAI status=${res.status}`); return null; }
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
  const m = photoDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return null;
  try {
    const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 800,
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } },
          { type: "text", text: USER_PROMPT },
        ]}],
      }),
    });
    if (!res.ok) { console.warn(`[visionAnalyzer] Anthropic status=${res.status}`); return null; }
    const data = await res.json();
    const text = data?.content?.[0]?.text ?? "";
    return coerce(extractJson(typeof text === "string" ? text : ""));
  } catch (e) {
    console.warn(`[visionAnalyzer] Anthropic error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function analyzeOne(dataUrl: string): Promise<VisionAnalysis | null> {
  const lov = await callLovableAIVision(dataUrl); if (lov) return lov;
  const oa = await callOpenAIVision(dataUrl); if (oa) return oa;
  const an = await callAnthropicVision(dataUrl); if (an) return an;
  return null;
}

function mostFrequent<T extends string | null | undefined>(values: T[]): T | null {
  const counts = new Map<string, { count: number; value: T }>();
  for (const v of values) {
    if (v == null || v === "") continue;
    const key = String(v);
    const prev = counts.get(key);
    if (prev) prev.count++;
    else counts.set(key, { count: 1, value: v });
  }
  let best: { count: number; value: T } | null = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best ? best.value : null;
}

/**
 * Analizza fino a 10 foto in parallelo. `confirmedAmbienti` (opzionale) è
 * un array parallelo agli input: se contiene un valore valido per un
 * indice, quella conferma PREVALE sulla proposta della vision per quella
 * foto (confidence forzata a 1, confermato=true).
 */
export async function analyzePhotosWithVision(
  dataUrls: string[],
  confirmedAmbienti?: Array<AmbienteTag | null | undefined>,
): Promise<AggregatedVisionAnalysis> {
  const valid = (dataUrls || [])
    .map((u, i) => ({ u, i }))
    .filter((x): x is { u: string; i: number } => typeof x.u === "string" && x.u.startsWith("data:image/"))
    .slice(0, MAX_PHOTOS);

  if (valid.length === 0) {
    return {
      ...DEFAULT_ANALYSIS,
      fotoAnalizzate: 0,
      visionStatus: "non_disponibile",
      ambientiRilevati: {},
      cucinaConfig: "non visibile",
      spaziEsterni: [],
      bagnoDettagli: [],
      perPhoto: [],
    };
  }

  const settled = await Promise.allSettled(valid.map((v) => analyzeOne(v.u)));
  const successes: VisionAnalysis[] = [];
  const perPhoto: AggregatedVisionAnalysis["perPhoto"] = [];
  for (let k = 0; k < settled.length; k++) {
    const r = settled[k];
    const originalIndex = valid[k].i;
    const confirmed = confirmedAmbienti?.[originalIndex];
    const confirmedTag = confirmed && (AMBIENTE_VALUES as string[]).includes(confirmed)
      ? (confirmed as AmbienteTag) : null;

    if (r.status === "fulfilled" && r.value) {
      const a = r.value;
      successes.push(a);
      perPhoto.push({
        index: originalIndex,
        ambiente: confirmedTag ?? (a.ambiente_proposto ?? "altro"),
        confidence: confirmedTag ? 1 : (a.ambiente_confidence ?? 0),
        materialiPavimenti: a.materialiPavimenti ?? null,
        finiture: a.finiture ?? null,
        sanitariVisibili: a.sanitariVisibili ?? [],
        luceNaturale: a.luceNaturale ?? null,
        statoConservazione: a.statoConservazione ?? null,
        elementiCucinaVisibili: a.elementiCucinaVisibili ?? [],
      });
    } else if (confirmedTag) {
      // Vision fallita ma agente ha confermato l'ambiente: teniamo la conferma.
      perPhoto.push({
        index: originalIndex,
        ambiente: confirmedTag,
        confidence: 1,
        materialiPavimenti: null, finiture: null, sanitariVisibili: [],
        luceNaturale: null, statoConservazione: null, elementiCucinaVisibili: [],
      });
    }
  }

  if (perPhoto.length === 0) {
    return {
      ...DEFAULT_ANALYSIS,
      fotoAnalizzate: 0,
      visionStatus: "non_disponibile",
      ambientiRilevati: {},
      cucinaConfig: "non visibile",
      spaziEsterni: [],
      bagnoDettagli: [],
      perPhoto: [],
    };
  }

  // ── Aggregazioni sicure (nessuna invenzione) ────────────────
  const ambientiRilevati: Record<string, number> = {};
  for (const p of perPhoto) ambientiRilevati[p.ambiente] = (ambientiRilevati[p.ambiente] ?? 0) + 1;

  // cucinaConfig
  const hasCucinaPhoto = (ambientiRilevati["cucina"] ?? 0) > 0;
  const soggiornoWithCottura = perPhoto.some(
    (p) => p.ambiente === "soggiorno" && (p.elementiCucinaVisibili ?? []).length > 0,
  );
  let cucinaConfig: AggregatedVisionAnalysis["cucinaConfig"] = "non visibile";
  if (hasCucinaPhoto) cucinaConfig = "cucina abitabile";
  else if (soggiornoWithCottura) cucinaConfig = "angolo cottura";

  // spaziEsterni: solo se realmente visti come foto
  const spaziEsterni: AggregatedVisionAnalysis["spaziEsterni"] = [];
  if ((ambientiRilevati["terrazzo_balcone"] ?? 0) > 0) spaziEsterni.push("terrazzo_balcone");
  if ((ambientiRilevati["giardino"] ?? 0) > 0) spaziEsterni.push("giardino");

  // bagnoDettagli: solo sanitari effettivamente visti nelle foto di bagno
  const bagnoDettagliSet = new Set<string>();
  for (const p of perPhoto) {
    if (p.ambiente !== "bagno") continue;
    for (const s of p.sanitariVisibili) bagnoDettagliSet.add(s);
  }
  const bagnoDettagli = Array.from(bagnoDettagliSet);

  // Campi legacy aggregati
  const tipologia = mostFrequent(successes.map((s) => s.tipologiaProbabile)) ?? DEFAULT_ANALYSIS.tipologiaProbabile;
  const stato = mostFrequent(successes.map((s) => s.statoApparente)) ?? DEFAULT_ANALYSIS.statoApparente;
  const materiale = mostFrequent(successes.map((s) => s.materialePresunto).filter((v): v is string => !!v));
  const anno = mostFrequent(successes.map((s) => s.annoPresunto).filter((v): v is string => !!v));
  const piano = mostFrequent(successes.map((s) => s.pianoStimato).filter((v): v is string => !!v));
  const puntiSet = new Set<string>();
  for (const s of successes) for (const p of s.puntiDiForzaVisivi) if (p) puntiSet.add(p);

  // Presenza giardino/parcheggio SOLO se confermato da almeno una foto reale
  const giardino = spaziEsterni.includes("giardino") || successes.some((s) => s.presenzaGiardino);
  const parcheggio = successes.some((s) => s.presenzaParcheggio);

  const visionStatus: AggregatedVisionAnalysis["visionStatus"] =
    successes.length === valid.length ? "ok" : (successes.length > 0 ? "parziale" : "non_disponibile");

  // Aggregato materialiPavimenti / finiture / luce (mostFrequent, senza inventare)
  const aggMaterialiPav = mostFrequent(successes.map((s) => s.materialiPavimenti ?? null));
  const aggFiniture = mostFrequent(successes.map((s) => s.finiture ?? null));
  const aggLuce = mostFrequent(successes.map((s) => s.luceNaturale ?? null));

  return {
    tipologiaProbabile: tipologia,
    pianoStimato: piano,
    statoApparente: stato,
    puntiDiForzaVisivi: Array.from(puntiSet),
    materialePresunto: materiale,
    annoPresunto: anno,
    presenzaGiardino: giardino,
    presenzaParcheggio: parcheggio,
    materialiPavimenti: aggMaterialiPav,
    finiture: aggFiniture,
    sanitariVisibili: bagnoDettagli,
    luceNaturale: aggLuce,
    statoConservazione: mostFrequent(successes.map((s) => s.statoConservazione ?? null)),
    elementiCucinaVisibili: Array.from(new Set(successes.flatMap((s) => s.elementiCucinaVisibili ?? []))),
    fotoAnalizzate: successes.length,
    visionStatus,
    ambientiRilevati,
    cucinaConfig,
    spaziEsterni,
    bagnoDettagli,
    perPhoto,
  };
}

/**
 * Wrapper legacy a singola foto (compat call-site esistenti).
 */
export async function analyzePhotoWithVision(
  photoDataUrl: string | undefined | null,
  _supabaseUrl?: string,
  _serviceRoleKey?: string,
): Promise<VisionAnalysis> {
  if (!photoDataUrl || typeof photoDataUrl !== "string" || !photoDataUrl.startsWith("data:image/")) {
    return { ...DEFAULT_ANALYSIS };
  }
  const res = await analyzeOne(photoDataUrl);
  return res ?? { ...DEFAULT_ANALYSIS };
}
