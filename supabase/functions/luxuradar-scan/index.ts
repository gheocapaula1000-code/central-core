// LuxuRadar — Central Core vertical for rare luxury / special-situation real estate (IT).
// Endpoints:
//   POST /luxuradar-scan         → run a scan and return assets
//   GET  /luxuradar-scan/:id     → fetch a single asset by id
//
// Privacy: no person-level data, no obituaries, no heir targeting, no owner names.
// Source labels are sanitized for client display.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-source-app",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ── Types ───────────────────────────────────────────────────────────────────
type Priority = "low" | "medium" | "high" | "critical";

interface ScanFilters {
  categories?: string[];
  regions?: string[];
  minPrice?: number;
  maxPrice?: number;
  sources?: string[];
  query?: string;
  limit?: number;
}

type PriceConfidence = "exact" | "range" | "threshold_only" | "unknown";
type ExtractionConfidence = "high" | "medium" | "low";

interface CollectedAsset {
  title: string;
  category: string;
  country: string;
  region: string | null;
  city: string | null;
  priceEur: number | null;
  priceMinEur: number | null;
  priceMaxEur: number | null;
  surfaceSqm: number | null;
  sourceCategory: string;   // internal taxonomy
  sourceLabel: string;       // client-safe label
  sourceUrl: string | null;
  heroImageUrl: string | null;
  priceConfidence: PriceConfidence;
  extractionConfidence: ExtractionConfidence;
  missingFields: string[];
  rawData: Record<string, unknown>;
}

// ── Constants ───────────────────────────────────────────────────────────────
const LUXURY_MIN_EUR = 3_000_000;
const PRIME_MIN_EUR = 5_000_000;

const ALLOWED_CATEGORIES = [
  "villa", "hotel", "palazzo", "historic_estate",
  "castle", "masseria", "trophy", "public_disposal",
  "judicial_auction", "special_situation",
];

const SOURCE_LABELS: Record<string, string> = {
  pvp_judicial: "Judicial auction",
  public_disposal: "Public disposal",
  luxury_market_signal: "Luxury market signal",
  hospitality_signal: "Hospitality asset",
  special_situation: "Special situation",
  public_notice: "Public notice",
};

const FORBIDDEN_TERMS = [
  "necrolog", "obituar", "erede", "eredi", "defunto", "defunta",
  "vedova", "vedovo", "familiar", "celebrity", "vip ",
];

// ── Helpers ─────────────────────────────────────────────────────────────────
function ok(data: unknown, debugId: string) {
  return new Response(
    JSON.stringify({ ok: true, data, warnings: [], debug_id: debugId, error: null }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}
function fail(status: number, code: string, message: string, debugId: string) {
  return new Response(
    JSON.stringify({ ok: false, data: null, warnings: [], debug_id: debugId, error: { code, message } }),
    { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

function sanitizeTitle(t: string): string {
  let out = t.replace(/\s+/g, " ").trim().slice(0, 240);
  // strip emails / phones / CF defensively
  out = out.replace(/\b[\w.-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[email]");
  out = out.replace(/\b\d{3}[\s.-]?\d{6,8}\b/g, "[tel]");
  return out;
}

// Aggressive title cleanup for search results (PDF labels, file boilerplate, dup separators).
function cleanTitle(raw: string): string {
  let t = sanitizeTitle(raw);
  // Remove bracketed file labels: [PDF], [DOC], (PDF), [XLS]…
  t = t.replace(/[\[\(]\s*(pdf|doc|docx|xls|xlsx|ppt|pptx|file|download|scarica)\s*[\]\)]/gi, " ");
  // Remove leading/inline "PDF -", "PDF |", "PDF:" tokens
  t = t.replace(/(^|\s|[|·•\-–—:])\s*(pdf|doc|docx|xls|xlsx)\s*(?=\s|[|·•\-–—:]|$)/gi, "$1 ");
  // Strip trailing file extensions on tokens like "documento.pdf"
  t = t.replace(/\.(pdf|docx?|xlsx?|pptx?)\b/gi, "");
  // Boilerplate phrases
  t = t.replace(/\b(scarica\s+(il|la)?\s*(documento|allegato|pdf|file)?|allegato\s+\d*|click\s+here|leggi\s+(di\s+)?più|continua\s+a\s+leggere)\b/gi, " ");
  // Collapse repeated separators: " | | ", " - - ", " · · "
  t = t.replace(/([|·•\-–—:])\s*\1+/g, "$1");
  // Trim leading/trailing separators
  t = t.replace(/^[\s|·•\-–—:]+|[\s|·•\-–—:]+$/g, "");
  // Collapse whitespace again
  t = t.replace(/\s+/g, " ").trim();
  return t.slice(0, 220);
}

// Normalize URL for dedupe: lowercase host, strip fragment + tracking params + trailing slash.
function normalizeUrl(u: string | null): string {
  if (!u) return "";
  try {
    const url = new URL(u);
    url.hash = "";
    const drop = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "ref"];
    for (const k of drop) url.searchParams.delete(k);
    url.hostname = url.hostname.toLowerCase();
    let s = url.toString();
    s = s.replace(/\/+$/, "");
    return s.toLowerCase();
  } catch {
    return u.toLowerCase().trim();
  }
}

function hasForbiddenContent(text: string): boolean {
  const lower = text.toLowerCase();
  return FORBIDDEN_TERMS.some((t) => lower.includes(t));
}

async function sha1(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildDedupeKey(a: CollectedAsset): Promise<string> {
  const base = [
    normalizeUrl(a.sourceUrl),
    a.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
    (a.city || "").toLowerCase(),
    (a.region || "").toLowerCase(),
    a.category.toLowerCase(),
  ].join("|");
  return await sha1(base);
}

function computeMissingFields(a: CollectedAsset): string[] {
  const missing: string[] = [];
  if (!a.city) missing.push("city");
  if (!a.region) missing.push("region");
  if (!a.priceEur && !(a.priceMinEur && a.priceMaxEur)) missing.push("price");
  if (!a.surfaceSqm) missing.push("surface");
  if (!a.sourceUrl) missing.push("source_url");
  return missing;
}

// ── Scoring ─────────────────────────────────────────────────────────────────
interface ScoreBreakdown {
  price: number;
  rarity: number;
  location_prestige: number;
  source_quality: number;
  special_situation: number;
  public_disposal: number;
  hospitality: number;
  freshness: number;
  completeness: number;
  risk_penalty: number;
  total: number;
}

const PRESTIGE_CITIES = new Set([
  "milano", "roma", "firenze", "venezia", "como", "portofino", "capri",
  "forte dei marmi", "cortina d'ampezzo", "cortina", "taormina", "positano",
  "amalfi", "santa margherita ligure", "lago di como", "lago maggiore",
]);
const PRESTIGE_REGIONS = new Set([
  "lombardia", "toscana", "lazio", "veneto", "liguria", "sicilia", "campania",
]);

function scoreAsset(a: CollectedAsset): { score: number; priority: Priority; breakdown: ScoreBreakdown } {
  const b: ScoreBreakdown = {
    price: 0, rarity: 0, location_prestige: 0, source_quality: 0,
    special_situation: 0, public_disposal: 0, hospitality: 0,
    freshness: 0, completeness: 0, risk_penalty: 0, total: 0,
  };

  // Only score on a real, extracted price. Threshold-only/unknown prices do NOT
  // get treated like a real €3M asking price.
  const realPrice = a.priceConfidence === "exact" || a.priceConfidence === "range"
    ? (a.priceEur ?? a.priceMaxEur ?? a.priceMinEur ?? 0)
    : 0;
  if (realPrice >= 20_000_000) b.price = 25;
  else if (realPrice >= 10_000_000) b.price = 20;
  else if (realPrice >= PRIME_MIN_EUR) b.price = 15;
  else if (realPrice >= LUXURY_MIN_EUR) b.price = 10;
  else if (realPrice > 0) b.price = 4;

  // rarity by category
  const rare = ["castle", "historic_estate", "palazzo", "trophy", "masseria"];
  if (rare.includes(a.category)) b.rarity = 12;
  else if (a.category === "villa" || a.category === "hotel") b.rarity = 8;

  const city = (a.city || "").toLowerCase();
  const region = (a.region || "").toLowerCase();
  if (PRESTIGE_CITIES.has(city)) b.location_prestige = 12;
  else if (PRESTIGE_REGIONS.has(region)) b.location_prestige = 7;
  else if (a.city) b.location_prestige = 3;

  const sourceQ: Record<string, number> = {
    pvp_judicial: 12, public_disposal: 12, public_notice: 9,
    special_situation: 10, hospitality_signal: 7, luxury_market_signal: 5,
  };
  b.source_quality = sourceQ[a.sourceCategory] ?? 3;

  if (a.sourceCategory === "special_situation") b.special_situation = 10;
  if (a.sourceCategory === "pvp_judicial" || a.sourceCategory === "public_disposal") b.public_disposal = 10;
  if (a.category === "hotel" || a.sourceCategory === "hospitality_signal") b.hospitality = 6;

  b.freshness = 8; // freshly collected this run
  let comp = 0;
  if (a.city) comp += 2;
  if (a.region) comp += 1;
  if (a.priceConfidence === "exact") comp += 3;
  else if (a.priceConfidence === "range") comp += 2;
  if (a.surfaceSqm) comp += 2;
  if (a.sourceUrl) comp += 2;
  if (a.extractionConfidence === "low") comp = Math.max(0, comp - 2);
  b.completeness = Math.min(10, comp);

  // small risk penalty for judicial assets (procedural risk)
  if (a.sourceCategory === "pvp_judicial") b.risk_penalty = -3;
  // Penalize threshold-only / unknown prices so they cannot reach high priority
  // on the back of a fake €3M anchor.
  if (a.priceConfidence === "threshold_only") b.risk_penalty -= 6;
  if (a.priceConfidence === "unknown") b.risk_penalty -= 4;
  if (a.extractionConfidence === "low") b.risk_penalty -= 3;

  const total = Math.max(0, Math.min(100,
    b.price + b.rarity + b.location_prestige + b.source_quality +
    b.special_situation + b.public_disposal + b.hospitality +
    b.freshness + b.completeness + b.risk_penalty,
  ));
  b.total = total;

  let priority: Priority = "low";
  const isInstitutional = a.sourceCategory === "pvp_judicial"
    || a.sourceCategory === "public_disposal"
    || a.sourceCategory === "special_situation";
  // Critical/high require a real extracted price ≥ Prime threshold.
  if (realPrice >= PRIME_MIN_EUR && isInstitutional && total >= 60) priority = "critical";
  else if (realPrice >= PRIME_MIN_EUR && total >= 55) priority = "high";
  else if (realPrice >= LUXURY_MIN_EUR && total >= 40) priority = "medium";
  else if (total >= 30 && a.priceConfidence !== "threshold_only") priority = "medium";

  return { score: total, priority, breakdown: b };
}

function buildWhyNow(a: CollectedAsset, p: Priority): string {
  const parts: string[] = [];
  if (a.sourceCategory === "pvp_judicial") parts.push("Asta giudiziaria in calendario");
  if (a.sourceCategory === "public_disposal") parts.push("Alienazione pubblica in corso");
  if (a.sourceCategory === "special_situation") parts.push("Special situation rilevata");
  if (a.priceEur && a.priceEur >= PRIME_MIN_EUR) parts.push("Asset Prime ≥ €5M");
  else if (a.priceEur && a.priceEur >= LUXURY_MIN_EUR) parts.push("Asset Luxury ≥ €3M");
  if (a.city && PRESTIGE_CITIES.has(a.city.toLowerCase())) parts.push(`Location prestige: ${a.city}`);
  if (p === "critical") parts.unshift("Priorità critica");
  return parts.join(". ") || "Segnale rilevato dal radar Luxury";
}

function buildOpportunity(a: CollectedAsset): string {
  if (a.category === "hotel") return "Riposizionamento hospitality o conversione luxury.";
  if (a.category === "castle" || a.category === "historic_estate" || a.category === "palazzo")
    return "Trophy asset con potenziale di valorizzazione storico-culturale.";
  if (a.sourceCategory === "pvp_judicial") return "Acquisizione sotto valore di mercato via procedura.";
  if (a.sourceCategory === "public_disposal") return "Acquisizione da ente pubblico con percorso strutturato.";
  return "Asset luxury con potenziale di rivalutazione.";
}

function buildRisk(a: CollectedAsset): string {
  if (a.sourceCategory === "pvp_judicial") return "Procedura giudiziaria: verificare gravami, occupazione, perizia.";
  if (a.sourceCategory === "public_disposal") return "Iter amministrativo: tempi, vincoli paesaggistici e di tutela.";
  if (a.category === "historic_estate" || a.category === "castle" || a.category === "palazzo")
    return "Vincoli Soprintendenza, costi di restauro e manutenzione elevati.";
  if (a.category === "hotel") return "Rischio operativo hospitality; verificare licenze e flussi.";
  return "Verificare due diligence completa prima di procedere.";
}

// ── Collectors (source-registry driven) ─────────────────────────────────────
import {
  REGISTERED_SOURCES, getActiveSourcesFiltered,
  type LuxurySource,
} from "./sourceRegistry.ts";

function categoryFromText(text: string, fallback: string): string {
  const t = text.toLowerCase();
  if (/villa/.test(t)) return "villa";
  if (/hotel|albergh|relais|resort/.test(t)) return "hotel";
  if (/palazzo/.test(t)) return "palazzo";
  if (/castello|castle/.test(t)) return "castle";
  if (/masser/.test(t)) return "masseria";
  if (/dimora|tenuta|villa storica|storic/.test(t)) return "historic_estate";
  return fallback;
}

function extractPriceEur(text: string): number | null {
  // Match "€ 4.500.000" / "4,5 milioni" / "euro 3.200.000"
  const mMil = text.match(/(\d{1,3}(?:[.,]\d{1,2})?)\s?(?:milion[ie]|mln)/i);
  if (mMil) {
    const n = Number(mMil[1].replace(",", ".")) * 1_000_000;
    if (Number.isFinite(n) && n >= LUXURY_MIN_EUR && n <= 500_000_000) return Math.round(n);
  }
  const m = text.match(/(?:€|euro)\s?([\d.,]{4,})/i);
  if (m) {
    const raw = m[1].replace(/\./g, "").replace(",", ".");
    const n = Number(raw);
    if (Number.isFinite(n) && n >= LUXURY_MIN_EUR && n <= 500_000_000) return Math.round(n);
  }
  return null;
}

async function collectFromScrape(s: LuxurySource): Promise<CollectedAsset[]> {
  const key = Deno.env.get("FIRECRAWL_API_KEY");
  if (!key || !s.url) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 35_000);
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: s.url,
        formats: [{
          type: "json",
          prompt: "Estrai immobili italiani con prezzo base superiore a 3 milioni di euro. Per ciascuno: tipo immobile, città, regione se nota, prezzo base in euro come numero, superficie in mq se nota, data evento, link assoluto.",
          schema: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    tipo: { type: "string" }, citta: { type: "string" },
                    regione: { type: "string" }, prezzoBaseEur: { type: "number" },
                    superficieMq: { type: "number" }, dataEvento: { type: "string" },
                    link: { type: "string" },
                  },
                  required: ["tipo", "link"],
                },
              },
            },
          },
        }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const items: Array<Record<string, unknown>> =
      data?.data?.json?.items ?? data?.json?.items ?? data?.data?.json?.aste ?? [];
    if (!Array.isArray(items)) return [];

    const out: CollectedAsset[] = [];
    for (const it of items) {
      const price = Number(it?.prezzoBaseEur);
      if (!Number.isFinite(price) || price < LUXURY_MIN_EUR) continue;
      const text = `${it?.tipo ?? ""} ${it?.citta ?? ""}`;
      if (hasForbiddenContent(text)) continue;
      const link = String(it?.link ?? "");
      const absUrl = link.startsWith("http") ? link
        : link && s.url ? new URL(link, s.url).toString() : null;

      const asset: CollectedAsset = {
        title: cleanTitle(`${it?.tipo ?? "Immobile"} — ${it?.citta ?? "Italia"}`),
        category: categoryFromText(text, "trophy"),
        country: "IT",
        region: it?.regione ? String(it.regione) : (s.regionHint ?? null),
        city: it?.citta ? String(it.citta) : (s.cityHint ?? null),
        priceEur: Math.round(price),
        priceMinEur: null, priceMaxEur: null,
        surfaceSqm: it?.superficieMq ? Math.round(Number(it.superficieMq)) : null,
        sourceCategory: s.category,
        sourceLabel: s.label,
        sourceUrl: absUrl,
        heroImageUrl: null,
        priceConfidence: "exact",
        extractionConfidence: "high",
        missingFields: [],
        rawData: { source_id: s.id, dataEvento: it?.dataEvento ?? null },
      };
      asset.missingFields = computeMissingFields(asset);
      out.push(asset);

    }
    return out;
  } catch (e) {
    console.warn(`[luxuradar] scrape ${s.id} error:`, e instanceof Error ? e.message : String(e));
    return [];
  } finally { clearTimeout(timer); }
}

async function collectFromSearch(s: LuxurySource): Promise<CollectedAsset[]> {
  const key = Deno.env.get("FIRECRAWL_API_KEY");
  if (!key || !s.query) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: s.query, limit: 5, lang: "it", country: "it" }),
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const results: Array<Record<string, unknown>> =
      data?.data?.web ?? data?.data ?? data?.web?.results ?? [];
    if (!Array.isArray(results)) return [];

    const out: CollectedAsset[] = [];
    for (const r of results) {
      const rawTitle = String(r?.title ?? "").trim();
      const desc = String(r?.description ?? "");
      const url = String(r?.url ?? "");
      if (!rawTitle || !url) continue;
      const title = cleanTitle(rawTitle);
      if (!title || title.length < 6) continue;
      const combined = `${title} ${desc}`;
      if (hasForbiddenContent(combined)) continue;
      if (!/alienazione|vendita|bando|asta|disposal|demanio|patrimonio|hotel|villa|palazzo|castello|dimora|tenuta|complesso|dismissione|cessione|masser/i.test(combined)) continue;

      const priceEur = extractPriceEur(combined);
      const isSpecialSituation = s.category === "special_situation";
      const isInstitutional = isSpecialSituation || s.category === "public_disposal" || s.category === "pvp_judicial";
      // Filter: drop below €3M unless special situation with unknown price
      if (priceEur && priceEur < LUXURY_MIN_EUR) continue;
      if (!priceEur && !isInstitutional) continue;

      const category = categoryFromText(combined, s.expectedTypes[0] ?? "trophy");
      // Detect PDF-only results: extraction confidence is lower.
      const isPdf = /\.pdf(?:$|\?|#)/i.test(url) || /\[pdf\]|\bpdf\b/i.test(rawTitle);
      const priceConfidence: PriceConfidence = priceEur ? "exact" : "threshold_only";
      const extractionConfidence: ExtractionConfidence =
        priceEur ? (isPdf ? "medium" : "high") : (isPdf ? "low" : "medium");

      const asset: CollectedAsset = {
        title,
        category,
        country: "IT",
        region: s.regionHint ?? null,
        city: s.cityHint ?? null,
        priceEur,
        // Do NOT fake €3M as priceMinEur when only the search threshold is known.
        priceMinEur: null,
        priceMaxEur: null,
        surfaceSqm: null,
        sourceCategory: s.category,
        sourceLabel: s.label,
        sourceUrl: url,
        heroImageUrl: null,
        priceConfidence,
        extractionConfidence,
        missingFields: [],
        rawData: {
          source_id: s.id,
          snippet: desc.slice(0, 400),
          is_pdf: isPdf,
          original_title: rawTitle !== title ? rawTitle.slice(0, 240) : undefined,
        },
      };
      asset.missingFields = computeMissingFields(asset);
      out.push(asset);
    }
    return out;

  } catch (e) {
    console.warn(`[luxuradar] search ${s.id} error:`, e instanceof Error ? e.message : String(e));
    return [];
  } finally { clearTimeout(timer); }
}

async function collectFromSource(s: LuxurySource): Promise<CollectedAsset[]> {
  if (!s.active) return [];
  if (s.extraction === "firecrawl_scrape") return collectFromScrape(s);
  if (s.extraction === "firecrawl_search") return collectFromSearch(s);
  return [];
}

// ── Filter / dedupe ─────────────────────────────────────────────────────────
function applyFilters(assets: CollectedAsset[], f: ScanFilters): CollectedAsset[] {
  return assets.filter((a) => {
    if (f.categories?.length && !f.categories.includes(a.category)) return false;
    if (f.regions?.length && !(a.region && f.regions.map(r => r.toLowerCase()).includes(a.region.toLowerCase()))) return false;
    if (f.sources?.length && !f.sources.includes(a.sourceCategory)) return false;
    const price = a.priceEur ?? a.priceMaxEur ?? a.priceMinEur ?? 0;
    // €3M floor unless special_situation with no price
    if (a.sourceCategory !== "special_situation" || price > 0) {
      if (price && price < LUXURY_MIN_EUR) return false;
    }
    if (f.minPrice && price && price < f.minPrice) return false;
    if (f.maxPrice && price && price > f.maxPrice) return false;
    if (f.query) {
      const q = f.query.toLowerCase();
      const hay = `${a.title} ${a.city ?? ""} ${a.region ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// In-memory dedupe within a single scan (DB upsert handles cross-run dedupe)
function dedupeWithinRun(assets: CollectedAsset[]): CollectedAsset[] {
  const seen = new Set<string>();
  const out: CollectedAsset[] = [];
  for (const a of assets) {
    const key = [
      (a.sourceUrl || "").toLowerCase(),
      a.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
      (a.city || "").toLowerCase(),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}



// ── Main handler ────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const debugId = crypto.randomUUID();
  const url = new URL(req.url);
  // Path matches: /luxuradar-scan or /luxuradar-scan/{id}
  const segments = url.pathname.split("/").filter(Boolean);
  // ["luxuradar-scan"] or ["luxuradar-scan", "<id>"]
  const idSegment = segments[1];

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    // GET /luxuradar-scan/{id}
    if (req.method === "GET" && idSegment) {
      const { data, error } = await supabase
        .from("luxuradar_assets").select("*").eq("id", idSegment).maybeSingle();
      if (error) return fail(500, "db_error", error.message, debugId);
      if (!data) return fail(404, "not_found", "Asset not found", debugId);
      return ok({ asset: toClientAsset(data) }, debugId);
    }

    // GET /luxuradar-scan → list latest
    if (req.method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
      const { data, error } = await supabase
        .from("luxuradar_assets").select("*")
        .order("score", { ascending: false }).limit(limit);
      if (error) return fail(500, "db_error", error.message, debugId);
      return ok({ assets: (data ?? []).map(toClientAsset), count: data?.length ?? 0 }, debugId);
    }

    // POST /luxuradar-scan
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const filters: ScanFilters = {
        categories: Array.isArray(body?.categories) ? body.categories.filter((c: unknown) => typeof c === "string" && ALLOWED_CATEGORIES.includes(c)) : undefined,
        regions: Array.isArray(body?.regions) ? body.regions.filter((r: unknown) => typeof r === "string") : undefined,
        minPrice: typeof body?.minPrice === "number" ? Math.max(LUXURY_MIN_EUR, body.minPrice) : LUXURY_MIN_EUR,
        maxPrice: typeof body?.maxPrice === "number" ? body.maxPrice : undefined,
        sources: Array.isArray(body?.sources) ? body.sources.filter((s: unknown) => typeof s === "string") : undefined,
        query: typeof body?.query === "string" ? body.query.slice(0, 200) : undefined,
        limit: Math.min(Number(body?.limit ?? 30), 100),
      };

      // Open run log
      const { data: run, error: runErr } = await supabase
        .from("luxuradar_scan_runs")
        .insert({ filters, status: "running" })
        .select("*").single();
      if (runErr || !run) return fail(500, "db_error", runErr?.message ?? "run insert failed", debugId);

      const sourcesUsed: string[] = [];
      const sourceCounts: Record<string, number> = {};
      const collected: CollectedAsset[] = [];

      // Pick active sources matching filters; cap total upstream calls.
      const MAX_SOURCES_PER_RUN = 10;
      const selected = getActiveSourcesFiltered({
        categories: filters.categories, regions: filters.regions, sources: filters.sources,
      }).slice(0, MAX_SOURCES_PER_RUN);

      // Run with limited concurrency (3) to stay polite.
      const concurrency = 3;
      for (let i = 0; i < selected.length; i += concurrency) {
        const batch = selected.slice(i, i + concurrency);
        const results = await Promise.all(batch.map((s) =>
          collectFromSource(s).then((rs) => ({ s, rs }))
        ));
        for (const { s, rs } of results) {
          if (rs.length) {
            sourcesUsed.push(s.id);
            sourceCounts[s.id] = rs.length;
            collected.push(...rs);
          }
        }
      }

      const deduped = dedupeWithinRun(collected);
      const filtered = applyFilters(deduped, filters).slice(0, filters.limit ?? 30);


      // Score, dedupe-key, upsert
      const persistedIds: string[] = [];
      let newCount = 0;
      for (const a of filtered) {
        const { score, priority, breakdown } = scoreAsset(a);
        const dedupeKey = await buildDedupeKey(a);
        const row = {
          title: a.title,
          category: a.category,
          country: a.country,
          region: a.region,
          city: a.city,
          price_eur: a.priceEur,
          price_min_eur: a.priceMinEur,
          price_max_eur: a.priceMaxEur,
          surface_sqm: a.surfaceSqm,
          score,
          priority,
          why_now: buildWhyNow(a, priority),
          opportunity: buildOpportunity(a),
          risk: buildRisk(a),
          source_category: a.sourceCategory,
          source_label: a.sourceLabel,
          source_url: a.sourceUrl,
          dossier_available: !!(a.city && (a.priceEur || a.priceMinEur) && a.sourceUrl),
          hero_image_url: a.heroImageUrl,
          raw_data: { ...a.rawData, score_breakdown: breakdown },
          dedupe_key: dedupeKey,
          scan_run_id: run.id,
        };
        const { data: up, error: upErr } = await supabase
          .from("luxuradar_assets")
          .upsert(row, { onConflict: "dedupe_key" })
          .select("id, created_at, scan_run_id").single();
        if (upErr) { console.warn("[luxuradar] upsert error:", upErr.message); continue; }
        if (up) {
          persistedIds.push(up.id);
          if (up.scan_run_id === run.id && new Date(up.created_at).getTime() > Date.parse(run.started_at) - 1000) {
            newCount += 1;
          }
        }
      }

      await supabase.from("luxuradar_scan_runs").update({
        status: "completed",
        assets_found: filtered.length,
        assets_new: newCount,
        sources_used: sourcesUsed,
        finished_at: new Date().toISOString(),
      }).eq("id", run.id);

      // Fetch persisted rows for response
      const { data: rows } = await supabase
        .from("luxuradar_assets").select("*")
        .in("id", persistedIds.length ? persistedIds : ["00000000-0000-0000-0000-000000000000"])
        .order("score", { ascending: false });

      return ok({
        scan_run_id: run.id,
        sources_used: sourcesUsed,
        source_counts: sourceCounts,
        registered_only: REGISTERED_SOURCES.map((s) => ({
          id: s.id, category: s.category, note: s.notes ?? "registered only",
        })),
        assets_found: filtered.length,
        assets_new: newCount,
        assets: (rows ?? []).map(toClientAsset),
      }, debugId);

    }

    return fail(405, "method_not_allowed", `Method ${req.method} not supported`, debugId);
  } catch (e) {
    console.error("[luxuradar] fatal:", e);
    return fail(500, "internal_error", e instanceof Error ? e.message : "unknown", debugId);
  }
});

// ── Client mapping ──────────────────────────────────────────────────────────
function toClientAsset(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    location: {
      country: row.country,
      region: row.region,
      city: row.city,
    },
    priceEur: row.price_eur,
    priceRangeEur: (row.price_min_eur || row.price_max_eur)
      ? { min: row.price_min_eur, max: row.price_max_eur } : null,
    surfaceSqm: row.surface_sqm,
    score: row.score,
    priority: row.priority,
    whyNow: row.why_now,
    opportunity: row.opportunity,
    risk: row.risk,
    source: {
      category: row.source_category,
      name: row.source_label, // already sanitized
    },
    dossierAvailable: row.dossier_available,
    heroImageUrl: row.hero_image_url,
    updatedAt: row.updated_at,
  };
}
