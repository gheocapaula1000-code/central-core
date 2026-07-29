// ═══════════════════════════════════════════════════════════════
// Civiko One — Content Studio (Central Core V3)
// POST /civiko/content-studio
//
// Receives:
//   { titolo, zona, tipologia, prezzo, tone, platforms[] }
//
// Returns a marketing kit with copy optimized per platform:
//   facebook, instagram, linkedin, whatsapp, email, annuncio_portali
//
// Hard rules: no forbidden vocabulary (AI, IA, algoritmo, valore
// garantito, prezzo giusto, ...). All outgoing strings sanitized.
// ═══════════════════════════════════════════════════════════════

import {
  CORE_CONTRACT, CORE_VERSION, addIdentityHeaders, buildManifest,
  enforceOriginPolicy, fail, handleOptions, json, makeDebugId,
  requireCivikoCostSecret,
} from "../_shared/http.ts";
import { sanitizeOutgoing } from "../_shared/civiko.ts";
import { rateLimit } from "../_shared/rate-limit.ts";

const FUNCTION_NAME = "civiko-content-studio";
const EXPECTED_BASE_PATH = "/functions/v1/civiko-content-studio";
const ROUTES = [
  "GET  /health",
  "GET  /manifest",
  "POST /civiko/content-studio",
];

type Platform = "facebook" | "instagram" | "linkedin" | "whatsapp" | "email" | "annuncio_portali";
const PLATFORM_LABELS: Record<Platform, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  whatsapp: "WhatsApp",
  email: "Email",
  annuncio_portali: "Annuncio Portali",
};
const ALLOWED_PLATFORMS: Platform[] = ["facebook", "instagram", "linkedin", "whatsapp", "email", "annuncio_portali"];

const ALLOWED_TONES = ["professionale", "caldo", "diretto", "elegante", "informativo"] as const;
type Tone = typeof ALLOWED_TONES[number];

interface RequestBody {
  titolo?: string;
  zona?: string;
  tipologia?: string;
  prezzo?: string | number;
  tone?: string;
  platforms?: string[];
}

interface PlatformContent {
  platform: Platform;
  label: string;
  title: string;
  body: string;
  hashtags?: string[];
  callToAction: string;
  characterCount: number;
}

interface ContentStudioResponse {
  configured: boolean;
  status: "ok" | "partial" | "unavailable";
  brief: { titolo: string; zona: string; tipologia: string; prezzo: string; tone: Tone };
  contenuti: PlatformContent[];
  warnings: string[];
  updatedAt: string;
}

function withIdentity(res: Response, route: string): Response {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

function normalizePlatforms(input: unknown): Platform[] {
  if (!Array.isArray(input)) return [];
  const set = new Set<Platform>();
  for (const v of input) {
    const s = String(v ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_");
    if ((ALLOWED_PLATFORMS as string[]).includes(s)) set.add(s as Platform);
  }
  return Array.from(set);
}

function normalizeTone(t: unknown): Tone {
  const s = String(t ?? "").toLowerCase().trim();
  return (ALLOWED_TONES as readonly string[]).includes(s) ? (s as Tone) : "professionale";
}

function platformBrief(p: Platform): string {
  switch (p) {
    case "facebook": return "Post Facebook 600-900 caratteri, paragrafi brevi, 1 chiamata all'azione finale, 3-5 hashtag pertinenti.";
    case "instagram": return "Caption Instagram 400-700 caratteri, prime due righe d'impatto, 6-10 hashtag locali e di settore alla fine.";
    case "linkedin": return "Post LinkedIn 700-1100 caratteri, tono professionale, struttura: contesto → opportunità → invito al contatto, 2-4 hashtag.";
    case "whatsapp": return "Messaggio WhatsApp 280-450 caratteri, tono caldo e personale, una sola chiamata all'azione, niente hashtag.";
    case "email": return "Email 700-1200 caratteri, subject line di max 65 caratteri, struttura: apertura → tre punti chiave → invito a fissare un appuntamento.";
    case "annuncio_portali": return "Annuncio per portali immobiliari 900-1400 caratteri, struttura: descrizione, caratteristiche tecniche, contesto di zona, invito a contattare l'agenzia. Niente hashtag.";
  }
}

// ── Lovable AI generation per platform ───────────────────────

async function generatePlatform(p: Platform, brief: ContentStudioResponse["brief"]): Promise<PlatformContent | null> {
  const key = Deno.env.get("LOVABLE_API_KEY") ?? "";
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const system = [
      "Sei un copywriter senior per il settore immobiliare italiano.",
      "Scrivi sempre in italiano corretto, professionale e umano.",
      "VIETATI questi termini in qualsiasi forma: AI, IA, algoritmo, intelligente, smart, machine learning, valore garantito, prezzo giusto, prezzo corretto, valore reale, stima ufficiale, perizia, valutazione ufficiale.",
      "Non promettere mai risultati certi né valori monetari assoluti.",
      "Non inventare caratteristiche dell'immobile non fornite nel brief.",
      "Rispondi solo tramite la funzione fornita.",
    ].join(" ");

    const user = [
      `Brief immobile:`,
      `- Titolo: ${brief.titolo}`,
      `- Zona: ${brief.zona}`,
      `- Tipologia: ${brief.tipologia}`,
      `- Prezzo richiesto: ${brief.prezzo}`,
      `- Tono: ${brief.tone}`,
      ``,
      `Piattaforma: ${PLATFORM_LABELS[p]}`,
      `Linee guida: ${platformBrief(p)}`,
    ].join("\n");

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools: [{
          type: "function",
          function: {
            name: "emit_content",
            description: "Emette il contenuto strutturato per la piattaforma",
            parameters: {
              type: "object",
              properties: {
                title: { type: "string", description: "Titolo o subject line. Vuoto per WhatsApp." },
                body: { type: "string", description: "Corpo del contenuto, rispettando le linee guida della piattaforma." },
                hashtags: { type: "array", items: { type: "string" }, description: "Hashtag senza #. Vuoto per WhatsApp/Email/Annuncio Portali." },
                callToAction: { type: "string", description: "Chiamata all'azione finale, breve." },
              },
              required: ["title", "body", "hashtags", "callToAction"],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "emit_content" } },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const args = data?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) return null;
    const parsed = JSON.parse(args);
    const title = String(parsed.title ?? "");
    const body = String(parsed.body ?? "");
    const hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags.map((h: unknown) => String(h).replace(/^#/, "").trim()).filter(Boolean).slice(0, 12) : [];
    const cta = String(parsed.callToAction ?? "");
    return {
      platform: p,
      label: PLATFORM_LABELS[p],
      title,
      body,
      hashtags: hashtags.length ? hashtags : undefined,
      callToAction: cta,
      characterCount: body.length,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Orchestrator ─────────────────────────────────────────────

async function orchestrate(body: RequestBody): Promise<ContentStudioResponse> {
  const titolo = String(body.titolo ?? "").trim();
  const zona = String(body.zona ?? "").trim();
  const tipologia = String(body.tipologia ?? "").trim();
  const prezzo = body.prezzo == null ? "" : String(body.prezzo).trim();
  const tone = normalizeTone(body.tone);
  let platforms = normalizePlatforms(body.platforms);
  if (platforms.length === 0) platforms = ["facebook", "instagram", "annuncio_portali"];

  const brief: ContentStudioResponse["brief"] = {
    titolo: titolo || "—",
    zona: zona || "—",
    tipologia: tipologia || "—",
    prezzo: prezzo || "—",
    tone,
  };

  const warnings: string[] = [];
  const hasAi = !!Deno.env.get("LOVABLE_API_KEY");
  if (!hasAi) warnings.push("Modulo di generazione contenuti non configurato in questo ambiente.");
  if (!titolo || !zona || !tipologia) warnings.push("Brief incompleto: i contenuti potrebbero essere generici.");

  const generated: PlatformContent[] = [];
  if (hasAi) {
    const results = await Promise.all(platforms.map((p) => generatePlatform(p, brief)));
    for (const r of results) if (r) generated.push(r);
  }

  const status: ContentStudioResponse["status"] =
    generated.length === platforms.length && platforms.length > 0 ? "ok" :
    generated.length > 0 ? "partial" : "unavailable";

  const out: ContentStudioResponse = {
    configured: hasAi,
    status,
    brief,
    contenuti: generated,
    warnings,
    updatedAt: new Date().toISOString(),
  };
  return sanitizeOutgoing(out);
}

// ── server ───────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = makeDebugId();
  try {
    const blocked = enforceOriginPolicy(req, debugId);
    if (blocked) return withIdentity(blocked, "origin-blocked");

    const url = new URL(req.url);
    const pathname = url.pathname;

    if (req.method === "GET") {
      if (pathname.endsWith("/health") || pathname === "/" || pathname === EXPECTED_BASE_PATH) {
        return withIdentity(json(req, 200, {
          status: "healthy", function: FUNCTION_NAME, version: CORE_VERSION,
          contract: CORE_CONTRACT, expectedBasePath: EXPECTED_BASE_PATH, time: new Date().toISOString(),
        }, debugId), "health");
      }
      if (pathname.endsWith("/manifest")) {
        return withIdentity(json(req, 200, buildManifest({
          functionName: FUNCTION_NAME, serviceKind: "civiko-content-studio",
          expectedBasePath: EXPECTED_BASE_PATH, routes: ROUTES, callingMode: "direct",
        }), debugId), "manifest");
      }
      return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `GET ${pathname}`, debugId), "error");
    }
    if (req.method !== "POST") return withIdentity(fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId), "error");

    // Checkpoint 1B — application auth before any cost (rate limit, body parse,
    // provider key read, orchestration, fetch).
    const authFailure = requireCivikoCostSecret(req, debugId);
    if (authFailure) return withIdentity(authFailure, "unauthorized");

    const rl = rateLimit(req, FUNCTION_NAME, { windowMs: 60_000, max: 20 });
    if (!rl.ok) {
      const r = fail(req, 429, "RATE_LIMITED", "Troppe richieste, riprovare a breve.", debugId);
      r.headers.set("Retry-After", String(rl.retryAfter));
      return withIdentity(r, "rate-limited");
    }

    let raw: unknown;
    try { raw = await req.json(); }
    catch { return withIdentity(fail(req, 400, "INVALID_JSON", "Body is not valid JSON", debugId), "error"); }
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
      return withIdentity(fail(req, 400, "INVALID_BODY", "Body must be a JSON object.", debugId), "error");
    }

    const out = await orchestrate(raw as RequestBody);
    return withIdentity(json(req, 200, out, debugId), "content-studio");
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] error debug_id=${debugId}: ${err instanceof Error ? err.message : String(err)}`);
    const fallback = sanitizeOutgoing({
      configured: false, status: "unavailable",
      brief: { titolo: "—", zona: "—", tipologia: "—", prezzo: "—", tone: "professionale" },
      contenuti: [],
      warnings: ["Errore interno temporaneo durante la generazione."],
      updatedAt: new Date().toISOString(),
    });
    return withIdentity(json(req, 200, fallback, debugId), "error-fallback");
  }
});
