// ═══════════════════════════════════════════════════════════════
// Central Core V3 — property-marketing-pack
// White-label edge function exposing the marketing-pack capability
// (powered internally by Civiko/KeyDraft pipelines) to PWA clients.
// The brand name "KeyDraft" is NEVER returned in any response.
// Public naming: "Studio Immobile Civiko" / "property_marketing_pack".
//
// Auth:     x-internal-secret (per-app secret resolution)
// Envelope: { ok, data, warnings, debug_id }
// Routes:   GET /health, GET /manifest, POST /
// ═══════════════════════════════════════════════════════════════

import {
  CORE_CONTRACT,
  CORE_VERSION,
  addIdentityHeaders,
  buildManifest,
  enforceOriginPolicy,
  fail,
  handleOptions,
  makeDebugId,
  ok,
  requireSecret,
} from "../_shared/http.ts";

const FUNCTION_NAME = "property-marketing-pack";
const EXPECTED_BASE_PATH = "/functions/v1/property-marketing-pack";
const STUDIO_NAME = "Studio Immobile Civiko";

const ROUTES = [
  "GET /health",
  "GET /manifest",
  "POST /",
];

function withIdentity(res: Response, route: string): Response {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

// ── Public-safe scrubber: strip any internal brand leakage ─────
const FORBIDDEN_BRAND_RE = /\b(key[\s\-_]*draft|keydraft_engine|ai[-_ ]?core[-_ ]?run)\b/gi;

function scrubBrand(value: string): string {
  if (!value) return value;
  return value.replace(FORBIDDEN_BRAND_RE, STUDIO_NAME).replace(/\s{2,}/g, " ").trim();
}

function deepScrub<T>(value: T): T {
  if (value == null) return value;
  if (typeof value === "string") return scrubBrand(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => deepScrub(v)) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepScrub(v);
    return out as T;
  }
  return value;
}

// ── Input contract ─────────────────────────────────────────────
interface PropertyInput {
  title?: string;
  address?: string;
  comune?: string;
  province?: string;
  property_type?: string;
  estimated_value?: number | string;
  rooms?: number | string;
  bathrooms?: number | string;
  mq?: number | string;
  photos_summary?: string;
  strengths?: string[] | string;
  objections?: string[] | string;
  urgency?: string;
}

interface RequestBody {
  source_app?: string;
  workspace_id?: string;
  opportunity_id?: string;
  property?: PropertyInput;
  tone_hint?: "professionale" | "caldo" | "diretto";
}

interface SocialVariant {
  channel: "facebook" | "instagram" | "linkedin" | "whatsapp";
  tone: "professionale" | "caldo" | "diretto";
  text: string;
}

interface ObjectionAnswer {
  objection: string;
  answer: string;
}

interface MarketingPack {
  studio_name: string;
  listing_text_long: string;
  listing_text_short: string;
  owner_message: string;
  social_variants: SocialVariant[];
  highlights: string[];
  objection_answers: ObjectionAnswer[];
  next_best_action: string;
  hashtags: string[];
  confidence: "alta" | "media" | "bassa";
  warnings: string[];
}

// ── Normalization ──────────────────────────────────────────────
function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x ?? "").trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) {
    return v.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function normalizeProperty(p: PropertyInput | undefined): {
  norm: Required<Omit<PropertyInput, "strengths" | "objections">> & { strengths: string[]; objections: string[] };
  missing: string[];
} {
  const norm = {
    title: String(p?.title ?? "").trim() || "Immobile",
    address: String(p?.address ?? "").trim(),
    comune: String(p?.comune ?? "").trim(),
    province: String(p?.province ?? "").trim(),
    property_type: String(p?.property_type ?? "").trim() || "immobile",
    estimated_value: p?.estimated_value == null ? "" : String(p.estimated_value).trim(),
    rooms: p?.rooms == null ? "" : String(p.rooms).trim(),
    bathrooms: p?.bathrooms == null ? "" : String(p.bathrooms).trim(),
    mq: p?.mq == null ? "" : String(p.mq).trim(),
    photos_summary: String(p?.photos_summary ?? "").trim(),
    strengths: asArray(p?.strengths),
    objections: asArray(p?.objections),
    urgency: String(p?.urgency ?? "").trim(),
  };
  const missing: string[] = [];
  if (!norm.address && !norm.comune) missing.push("address/comune");
  if (!norm.mq) missing.push("mq");
  if (!norm.property_type || norm.property_type === "immobile") missing.push("property_type");
  return { norm, missing };
}

// ── Lovable AI generation (single structured call) ─────────────
async function generatePack(
  input: ReturnType<typeof normalizeProperty>["norm"],
  toneHint?: "professionale" | "caldo" | "diretto",
): Promise<Partial<MarketingPack> | null> {
  const key = Deno.env.get("LOVABLE_API_KEY") ?? "";
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const toneLine = toneHint
      ? `Taglio richiesto per listing_text_long, listing_text_short e owner_message: "${toneHint}". Mantieni comunque le varianti social con i loro tone specifici.`
      : "";
    const system = [
      "Sei un copywriter senior italiano per acquisizione immobiliare.",
      "Scrivi in italiano corretto, naturale, professionale ma umano.",
      "VIETATI in qualsiasi forma: AI, IA, algoritmo, intelligente, smart, machine learning, valore garantito, prezzo giusto, stima ufficiale, perizia, valutazione ufficiale.",
      "VIETATO nominare strumenti interni o brand tecnici (es. KeyDraft).",
      "Non inventare caratteristiche non presenti nel brief. Se mancano dati, mantieni il tono generico ma onesto.",
      "Non promettere risultati certi né valori monetari assoluti.",
      toneLine,
      "Rispondi esclusivamente tramite la funzione fornita.",
    ].filter(Boolean).join(" ");

    const user = [
      "Brief proprietà:",
      `- Titolo: ${input.title}`,
      `- Indirizzo: ${input.address || "—"}`,
      `- Comune: ${input.comune || "—"} (${input.province || "—"})`,
      `- Tipologia: ${input.property_type}`,
      `- Mq: ${input.mq || "—"}`,
      `- Locali: ${input.rooms || "—"} | Bagni: ${input.bathrooms || "—"}`,
      `- Valore stimato (riferimento interno): ${input.estimated_value || "—"}`,
      `- Sintesi foto: ${input.photos_summary || "—"}`,
      `- Punti forti dichiarati: ${input.strengths.join("; ") || "—"}`,
      `- Obiezioni note del proprietario: ${input.objections.join("; ") || "—"}`,
      `- Urgenza: ${input.urgency || "—"}`,
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
            name: "emit_marketing_pack",
            description: "Emette il pacchetto marketing strutturato per l'acquisizione dell'immobile.",
            parameters: {
              type: "object",
              properties: {
                listing_text_long: { type: "string", description: "Descrizione immobile premium 900-1300 caratteri." },
                listing_text_short: { type: "string", description: "Versione breve 220-320 caratteri per vetrina/locandina." },
                owner_message: { type: "string", description: "Messaggio diretto al proprietario 400-600 caratteri, tono caldo e professionale." },
                social_variants: {
                  type: "array",
                  description: "Varianti social: facebook, instagram, linkedin, whatsapp.",
                  items: {
                    type: "object",
                    properties: {
                      channel: { type: "string", enum: ["facebook", "instagram", "linkedin", "whatsapp"] },
                      tone: { type: "string", enum: ["professionale", "caldo", "diretto"] },
                      text: { type: "string" },
                    },
                    required: ["channel", "tone", "text"],
                    additionalProperties: false,
                  },
                },
                highlights: { type: "array", items: { type: "string" }, description: "5-8 punti forti sintetici." },
                objection_answers: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      objection: { type: "string" },
                      answer: { type: "string" },
                    },
                    required: ["objection", "answer"],
                    additionalProperties: false,
                  },
                },
                next_best_action: { type: "string", description: "Prossima azione concreta consigliata all'agente." },
                confidence: { type: "string", enum: ["alta", "media", "bassa"] },
                hashtags: {
                  type: "array",
                  description: "10-15 hashtag in italiano (zona, quartiere, tipologia, immobiliare generici). Tutti con prefisso #, senza spazi.",
                  items: { type: "string" },
                },
              },
              required: [
                "listing_text_long", "listing_text_short", "owner_message",
                "social_variants", "highlights", "objection_answers",
                "next_best_action", "confidence", "hashtags",
              ],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "emit_marketing_pack" } },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[${FUNCTION_NAME}] AI gateway returned status=${res.status}`);
      return null;
    }
    const data = await res.json();
    const args = data?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) return null;
    const parsed = JSON.parse(args);
    return parsed as Partial<MarketingPack>;
  } catch (e) {
    console.warn(`[${FUNCTION_NAME}] generation failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Hashtag helpers ────────────────────────────────────────────
function slugTag(v: string): string {
  const cleaned = v
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
  return cleaned ? `#${cleaned}` : "";
}

function normalizeHashtags(raw: unknown, fallback: string[]): string[] {
  const src = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (s: string) => {
    const cleaned = String(s ?? "").trim();
    if (!cleaned) return;
    const tag = cleaned.startsWith("#") ? `#${cleaned.replace(/^#+/, "").replace(/\s+/g, "")}` : slugTag(cleaned);
    if (!tag || tag === "#") return;
    const lower = tag.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    out.push(tag);
  };
  for (const t of src) add(String(t ?? ""));
  if (out.length === 0) for (const t of fallback) add(t);
  return out.slice(0, 20);
}

function fallbackHashtags(input: ReturnType<typeof normalizeProperty>["norm"]): string[] {
  const base = ["#immobiliare", "#casa", "#vendita", "#realestate", "#immobile"];
  const extras: string[] = [];
  if (input.property_type && input.property_type !== "immobile") extras.push(input.property_type);
  if (input.comune) extras.push(input.comune);
  if (input.province) extras.push(input.province);
  if (input.address) extras.push(input.address.split(",")[0] ?? "");
  return [...extras.map(slugTag).filter(Boolean), ...base];
}

// ── Fallback (no AI) ───────────────────────────────────────────
function fallbackPack(input: ReturnType<typeof normalizeProperty>["norm"]): MarketingPack {
  const loc = [input.address, input.comune].filter(Boolean).join(", ") || "—";
  return {
    studio_name: STUDIO_NAME,
    listing_text_long:
      `Proposta in acquisizione: ${input.property_type} in ${loc}. ` +
      `Brief disponibile su superficie, locali e contesto. Materiali commerciali da completare ` +
      `con foto e descrizione di dettaglio in fase di sopralluogo.`,
    listing_text_short: `${input.property_type} in ${loc}. Materiali commerciali in preparazione.`,
    owner_message:
      "Buongiorno, abbiamo preparato una proposta di valorizzazione dell'immobile basata sui dati ricevuti. " +
      "Le proponiamo un incontro per condividere materiali e piano di pubblicazione.",
    social_variants: [
      { channel: "facebook", tone: "professionale", text: `Nuova proposta di acquisizione in ${loc}.` },
      { channel: "instagram", tone: "caldo", text: `Stiamo preparando i materiali per ${loc}.` },
    ],
    highlights: input.strengths.length ? input.strengths.slice(0, 8) : ["Materiali in preparazione."],
    objection_answers: input.objections.slice(0, 5).map((o) => ({
      objection: o,
      answer: "Verifichiamo insieme i dati di mercato disponibili prima di rispondere.",
    })),
    next_best_action: "Confermare il sopralluogo e raccogliere foto definitive.",
    hashtags: normalizeHashtags([], fallbackHashtags(input)),
    confidence: "bassa",
    warnings: ["Modulo di generazione contenuti non configurato: output di fallback."],
  };
}

// ── Orchestrator ───────────────────────────────────────────────
async function orchestrate(body: RequestBody): Promise<MarketingPack> {
  const { norm, missing } = normalizeProperty(body.property);
  const warnings: string[] = [];
  if (missing.length) warnings.push(`Brief incompleto: ${missing.join(", ")}.`);

  const toneHint = (["professionale", "caldo", "diretto"] as const).includes(body.tone_hint as "caldo")
    ? body.tone_hint
    : undefined;
  const gen = await generatePack(norm, toneHint);
  if (!gen) {
    const fb = fallbackPack(norm);
    fb.warnings = [...warnings, ...fb.warnings];
    return deepScrub(fb);
  }

  const pack: MarketingPack = {
    studio_name: STUDIO_NAME,
    listing_text_long: String(gen.listing_text_long ?? ""),
    listing_text_short: String(gen.listing_text_short ?? ""),
    owner_message: String(gen.owner_message ?? ""),
    social_variants: Array.isArray(gen.social_variants)
      ? (gen.social_variants as SocialVariant[]).slice(0, 6)
      : [],
    highlights: Array.isArray(gen.highlights)
      ? (gen.highlights as string[]).map((h) => String(h)).filter(Boolean).slice(0, 10)
      : [],
    objection_answers: Array.isArray(gen.objection_answers)
      ? (gen.objection_answers as ObjectionAnswer[]).slice(0, 8)
      : [],
    next_best_action: String(gen.next_best_action ?? ""),
    hashtags: normalizeHashtags((gen as { hashtags?: unknown }).hashtags, fallbackHashtags(norm)),
    confidence: (["alta", "media", "bassa"] as const).includes(gen.confidence as "alta")
      ? (gen.confidence as MarketingPack["confidence"])
      : (missing.length ? "media" : "alta"),
    warnings,
  };
  return deepScrub(pack);
}

// ── Server ─────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = makeDebugId();
  const pathname = new URL(req.url).pathname;

  try {
    const blocked = enforceOriginPolicy(req, debugId);
    if (blocked) return withIdentity(blocked, "origin-blocked");

    if (req.method === "GET") {
      if (pathname.endsWith("/health") || pathname === "/" || pathname.endsWith(EXPECTED_BASE_PATH)) {
        return withIdentity(ok(req, {
          status: "healthy",
          function: FUNCTION_NAME,
          version: CORE_VERSION,
          contract: CORE_CONTRACT,
          expectedBasePath: EXPECTED_BASE_PATH,
          time: new Date().toISOString(),
        }, [], debugId), "health");
      }
      if (pathname.endsWith("/manifest")) {
        return withIdentity(ok(req, buildManifest({
          functionName: FUNCTION_NAME,
          serviceKind: "property-marketing-pack",
          expectedBasePath: EXPECTED_BASE_PATH,
          routes: ROUTES,
          callingMode: "direct",
        }), [], debugId), "manifest");
      }
      return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `GET ${pathname}`, debugId), "error");
    }

    if (req.method !== "POST") {
      return withIdentity(fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId), "error");
    }

    const authErr = requireSecret(req, debugId);
    if (authErr) return withIdentity(authErr, "auth-rejected");

    let raw: unknown;
    try { raw = await req.json(); }
    catch { return withIdentity(fail(req, 400, "INVALID_JSON", "Body is not valid JSON", debugId), "error"); }
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
      return withIdentity(fail(req, 400, "INVALID_BODY", "Body must be a JSON object", debugId), "error");
    }
    const body = raw as RequestBody;
    if (!body.property || typeof body.property !== "object") {
      return withIdentity(fail(req, 400, "MISSING_PROPERTY", "Field 'property' is required", debugId), "error");
    }

    const pack = await orchestrate(body);
    return withIdentity(ok(req, pack, pack.warnings, debugId), "property-marketing-pack");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${FUNCTION_NAME}] error debug_id=${debugId}: ${msg}`);
    return withIdentity(fail(req, 500, "INTERNAL_ERROR", `Internal error. Reference: ${debugId}`, debugId), "error");
  }
});
