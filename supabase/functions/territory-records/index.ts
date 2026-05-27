// territory-records
// GET /functions/v1/territory-records?city=Padova
// Auth: Bearer JWT required.
// Aggregates real signals from Firecrawl (auction portals), Perplexity
// (territorial intelligence) and Google Places (construction sites).
// PRINCIPLE: if APIs return nothing, response is []. No mocks, no invented data.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

// ─── CORS ────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://civikoone.com",
  "https://www.civikoone.com",
];
const LOVABLE_SUFFIXES = [".lovable.app", ".lovableproject.com", ".lovable.dev"];

function corsFor(origin: string | null): Record<string, string> {
  let allow = "https://civikoone.com";
  if (origin) {
    const o = origin.toLowerCase();
    try {
      const u = new URL(o);
      if (ALLOWED_ORIGINS.includes(o)) allow = o;
      else if (LOVABLE_SUFFIXES.some((s) => u.hostname.endsWith(s))) allow = o;
      else if (u.hostname === "localhost" || u.hostname.startsWith("127.")) allow = o;
    } catch { /* ignore */ }
  }
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResp(body: unknown, status: number, cors: Record<string, string>, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, ...extra, "Content-Type": "application/json" },
  });
}

// ─── Geo ─────────────────────────────────────────────────────────────────
function distanzaKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
const PADOVA_CENTER = { lat: 45.4064, lng: 11.8768 };
const MAX_KM = 5.5;

// ─── Types ───────────────────────────────────────────────────────────────
type Category =
  | "cantiere"
  | "area_trasformazione"
  | "demolizione"
  | "segnale_demografico"
  | "brownfield"
  | "segnale_territoriale";

interface TerritoryRecord {
  id: string;
  title: string;
  comune: string;
  microzona: string | null;
  source_name: string;
  last_seen: string;
  freshness: "fresco" | "recente" | "datato";
  priority_score: number;
  scoring_reason: string;
  has_geo: boolean;
  municipality: string;
  area_label: string | null;
  category: Category;
  tags: string[];
  freshness_label: string;
  priority_label: string;
  reason_short: string;
}

const PADOVA_ZONES = [
  "Arcella", "Portello", "Centro Storico", "Forcellini", "Guizza",
  "Sacra Famiglia", "Camin", "Stanga", "Zona Industriale", "Voltabarozzo",
  "Pontevigodarzere", "Mortise", "Altichiero", "Mandria", "Brusegana",
  "Brentelle", "Chiesanuova", "Salboro", "Ponte di Brenta", "Stazione",
  "Fiera", "Santo", "Prato della Valle",
];

const VALID_CATEGORIES: Category[] = [
  "cantiere","area_trasformazione","demolizione","segnale_demografico","brownfield","segnale_territoriale",
];

function findZone(text: string): string | null {
  const lower = text.toLowerCase();
  for (const z of PADOVA_ZONES) {
    if (lower.includes(z.toLowerCase())) return z;
  }
  return null;
}

function shortId(prefix: string, seed: string): string {
  const b64 = btoa(unescape(encodeURIComponent(seed))).slice(0, 16).replace(/[^a-z0-9]/gi, "");
  return `${prefix}-${b64}`;
}

// ─── FONTE 1: Firecrawl ──────────────────────────────────────────────────
async function firecrawlScrape(url: string, apiKey: string): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const md: string | undefined = data?.data?.markdown ?? data?.markdown;
    if (!md || md.length < 100) return null;
    return md.slice(0, 4000);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const ASTE_KEYWORDS = [
  "asta","procedura","fallimento","liquidazione","concordato","immobile",
  "appartamento","villa","capannone","terreno","lotto","vendita forzata",
];

function parseAsteMarkdown(md: string, sourceUrl: string): TerritoryRecord[] {
  const out: TerritoryRecord[] = [];
  const sourceName = (() => { try { return new URL(sourceUrl).hostname.replace(/^www\./, ""); } catch { return sourceUrl; } })();
  const blocks: string[] = [];
  for (let i = 0; i < md.length; i += 500) blocks.push(md.slice(i, i + 500));

  for (const block of blocks) {
    const lower = block.toLowerCase();
    const matches = ASTE_KEYWORDS.filter((k) => lower.includes(k));
    if (matches.length < 2) continue;
    if (!/\d/.test(block)) continue;

    const firstLine = block.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
    const title = firstLine.replace(/[#*_>`-]/g, "").trim().slice(0, 80);
    if (title.length < 5) continue;

    const microzona = findZone(block);
    let category: Category = "segnale_territoriale";
    if (lower.includes("asta") || lower.includes("vendita forzata") || lower.includes("procedura")) {
      category = "area_trasformazione";
    } else if (lower.includes("demolizione") || lower.includes("abbattimento")) {
      category = "demolizione";
    }
    let priority_score = 62;
    if (lower.includes("asta")) priority_score = 82;
    else if (lower.includes("fallimento") || lower.includes("concordato")) priority_score = 75;

    const scoring_reason = "Procedura giudiziaria o asta immobiliare rilevata in zona Padova";
    const now = new Date().toISOString();
    out.push({
      id: shortId("fc", sourceUrl + title),
      title,
      comune: "Padova",
      microzona,
      source_name: sourceName,
      last_seen: now,
      freshness: "fresco",
      priority_score,
      scoring_reason,
      has_geo: false,
      municipality: "Padova",
      area_label: microzona,
      category,
      tags: [category, "Padova", ...(microzona ? [microzona] : [])],
      freshness_label: "",
      priority_label: "",
      reason_short: scoring_reason,
    });
  }
  return out;
}

async function fetchFirecrawl(): Promise<TerritoryRecord[]> {
  const key = Deno.env.get("FIRECRAWL_API_KEY");
  if (!key) return [];
  const urls = [
    "https://www.astegiudiziarie.it/ricerca-aste?comune=Padova&tipo=immobili",
    "https://www.portaleaste.com/aste-immobili/padova",
    "https://www.tribunale.padova.giustizia.it/it/Content/Index/50",
    "https://www.immobiliare.it/aste-giudiziarie/padova/",
  ];
  const settled = await Promise.allSettled(urls.map((u) => firecrawlScrape(u, key)));
  const records: TerritoryRecord[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) {
      records.push(...parseAsteMarkdown(r.value, urls[i]));
    }
  });
  return records;
}

// ─── FONTE 2: Perplexity ─────────────────────────────────────────────────
async function fetchPerplexity(): Promise<TerritoryRecord[]> {
  const key = Deno.env.get("PERPLEXITY_API_KEY");
  if (!key) return [];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: "sonar-pro",
        messages: [{
          role: "user",
          content: "Trova segnali immobiliari concreti e recenti nel Comune di Padova, Italia. Cerca: cantieri edilizi aperti negli ultimi 12 mesi, aree industriali dismesse o in riconversione, nuovi complessi residenziali in costruzione, dismissioni di immobili commerciali o aziendali, zone di trasformazione urbanistica previste dal Piano degli Interventi. Considera le microzone: Arcella, Portello, Centro Storico, Forcellini, Guizza, Sacra Famiglia, Camin, Stanga, Albignasego, Selvazzano Dentro, Abano Terme, Cadoneghe, Limena, Vigodarzere, Rubano, Zona Industriale Padova. Rispondi ESCLUSIVAMENTE con un array JSON valido, nessun testo prima o dopo, nessun markdown: [{\"microzona\":\"nome zona\",\"titolo\":\"descrizione concisa del segnale\",\"categoria\":\"cantiere|area_trasformazione|segnale_demografico|brownfield|demolizione\",\"motivo\":\"perché è rilevante per un agente immobiliare che cerca incarichi in esclusiva\",\"priorita\":60}]. Se non trovi informazioni concrete e verificabili, restituisci array vuoto [].",
        }],
        temperature: 0.1,
        max_tokens: 1200,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    let content: string | undefined = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") return [];
    content = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return []; }
    if (!Array.isArray(parsed)) return [];

    const out: TerritoryRecord[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      const titolo = typeof e.titolo === "string" ? e.titolo : "";
      const microzona = typeof e.microzona === "string" ? e.microzona : "";
      const categoria = typeof e.categoria === "string" ? e.categoria as Category : "" as Category;
      const motivo = typeof e.motivo === "string" ? e.motivo : "";
      if (titolo.length < 10) continue;
      if (!VALID_CATEGORIES.includes(categoria)) continue;
      const priorita = typeof e.priorita === "number"
        ? Math.min(95, Math.max(40, e.priorita))
        : 65;
      const now = new Date().toISOString();
      out.push({
        id: shortId("perp", titolo),
        title: titolo,
        comune: "Padova",
        microzona: microzona || null,
        source_name: "Intelligence territoriale",
        last_seen: now,
        freshness: "fresco",
        priority_score: priorita,
        scoring_reason: motivo,
        has_geo: false,
        municipality: "Padova",
        area_label: microzona || null,
        category: categoria,
        tags: [categoria, "Padova", microzona].filter(Boolean) as string[],
        freshness_label: "",
        priority_label: "",
        reason_short: motivo.slice(0, 120),
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

// ─── FONTE 3: Google Places ──────────────────────────────────────────────
interface PlacesQuery { keyword: string; category: Category; priority_score: number; }

async function placesNearby(q: PlacesQuery, key: string): Promise<TerritoryRecord[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=45.4064,11.8768&radius=6000&language=it&keyword=${encodeURIComponent(q.keyword)}&key=${key}`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    const results: unknown[] = Array.isArray(data?.results) ? data.results : [];
    const out: TerritoryRecord[] = [];
    for (const p of results.slice(0, 5)) {
      const place = p as Record<string, unknown>;
      const status = place.business_status as string | undefined;
      if (status === "CLOSED_PERMANENTLY") continue;
      if (status && status !== "OPERATIONAL") continue;
      const placeId = String(place.place_id ?? "");
      const name = String(place.name ?? "").trim();
      if (!placeId || !name) continue;
      const vicinity = String(place.vicinity ?? "");
      const geom = place.geometry as { location?: { lat?: number; lng?: number } } | undefined;
      const placeLat = geom?.location?.lat;
      const placeLng = geom?.location?.lng;
      if (typeof placeLat !== "number" || typeof placeLng !== "number") continue;
      if (distanzaKm(PADOVA_CENTER.lat, PADOVA_CENTER.lng, placeLat, placeLng) > MAX_KM) continue;
      const areaLabel = vicinity.split(",")[0]?.trim() || null;
      const microzona = vicinity ? findZone(vicinity) : null;
      const scoring_reason = "Rilevato tramite dati geografici in zona " + (microzona ?? "Padova");
      const now = new Date().toISOString();
      out.push({
        id: `gm-${placeId.slice(0, 20)}`,
        title: name,
        comune: "Padova",
        microzona,
        source_name: "Dati geografici",
        last_seen: now,
        freshness: "fresco",
        priority_score: q.priority_score,
        scoring_reason,
        has_geo: true,
        municipality: "Padova",
        area_label: areaLabel,
        category: q.category,
        tags: [q.category, "Padova"],
        freshness_label: "",
        priority_label: "",
        reason_short: scoring_reason,
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

async function fetchGooglePlaces(): Promise<TerritoryRecord[]> {
  const key = Deno.env.get("GOOGLE_MAPS_API_KEY");
  if (!key) return [];
  const queries: PlacesQuery[] = [
    { keyword: "cantiere edile", category: "cantiere", priority_score: 68 },
    { keyword: "demolizione immobile", category: "demolizione", priority_score: 72 },
    { keyword: "area industriale dismessa", category: "brownfield", priority_score: 65 },
  ];
  const settled = await Promise.allSettled(queries.map((q) => placesNearby(q, key)));
  const out: TerritoryRecord[] = [];
  for (const r of settled) if (r.status === "fulfilled") out.push(...r.value);
  return out;
}

// ─── Dedup + derived fields ──────────────────────────────────────────────
function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

function tokenSimilarity(a: string, b: string): number {
  const sa = new Set(a.split(/\s+/).filter(Boolean));
  const sb = new Set(b.split(/\s+/).filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const uni = new Set([...sa, ...sb]).size;
  return inter / uni;
}

function dedupe(records: TerritoryRecord[]): TerritoryRecord[] {
  const kept: { norm: string; rec: TerritoryRecord }[] = [];
  for (const r of records) {
    const norm = normalizeTitle(r.title);
    let replaced = false;
    for (let i = 0; i < kept.length; i++) {
      if (tokenSimilarity(norm, kept[i].norm) > 0.6) {
        if (r.priority_score > kept[i].rec.priority_score) {
          kept[i] = { norm, rec: r };
        }
        replaced = true;
        break;
      }
    }
    if (!replaced) kept.push({ norm, rec: r });
  }
  return kept.map((k) => k.rec);
}

function freshnessLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return "Aggiornato oggi";
  const diffDays = (now.getTime() - d.getTime()) / 86_400_000;
  if (diffDays <= 7) return "Questa settimana";
  return "Recente";
}

function priorityLabel(score: number): string {
  if (score >= 80) return "Priorità alta";
  if (score >= 60) return "Priorità media";
  return "Monitoraggio";
}

// ─── Handler ─────────────────────────────────────────────────────────────
serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsFor(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return jsonResp({ error: "method_not_allowed" }, 405, cors);

  // Auth
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return jsonResp({ error: "unauthorized" }, 401, cors);
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!supabaseUrl || !anonKey) return jsonResp({ error: "config_error" }, 500, cors);
  const supa = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: auth } },
  });
  const { data: userRes, error: userErr } = await supa.auth.getUser();
  if (userErr || !userRes?.user) return jsonResp({ error: "unauthorized" }, 401, cors);

  const url = new URL(req.url);
  const city = (url.searchParams.get("city") ?? "Padova").toLowerCase();
  if (city !== "padova") {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json", "X-Source": "empty", "X-Record-Count": "0", "X-Core-Version": "3.5.0" },
    });
  }

  const [fcRes, ppRes, gmRes] = await Promise.allSettled([
    fetchFirecrawl(),
    fetchPerplexity(),
    fetchGooglePlaces(),
  ]);
  const all: TerritoryRecord[] = [];
  if (fcRes.status === "fulfilled") all.push(...fcRes.value);
  if (ppRes.status === "fulfilled") all.push(...ppRes.value);
  if (gmRes.status === "fulfilled") all.push(...gmRes.value);

  let records = dedupe(all)
    .map((r) => ({
      ...r,
      freshness_label: freshnessLabel(r.last_seen),
      priority_label: priorityLabel(r.priority_score),
    }))
    .sort((a, b) => b.priority_score - a.priority_score)
    .slice(0, 40);

  const headers = {
    ...cors,
    "Content-Type": "application/json",
    "X-Source": records.length > 0 ? "live" : "empty",
    "X-Record-Count": String(records.length),
    "X-Core-Version": "3.5.0",
  };
  return new Response(JSON.stringify(records), { status: 200, headers });
});
