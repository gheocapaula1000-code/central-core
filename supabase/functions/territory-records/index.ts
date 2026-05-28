// territory-records
// GET /functions/v1/territory-records?city=Padova
// Auth: Bearer JWT required.
// Aggregates real signals for Padova from 8 parallel sources.
// PRINCIPLE: if APIs return nothing, response is []. No mocks, no invented data.
// PRIVACY: never expose person names in titles/reasons.

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

// Strip any person-like names (sequence of 2+ capitalized words).
function anonymize(s: string): string {
  return s.replace(/\b([A-Z][a-zàèéìòù]{1,}\s+){1,3}[A-Z][a-zàèéìòù]{1,}\b/g, "—");
}

function blocksOf(md: string, size = 500): string[] {
  const out: string[] = [];
  for (let i = 0; i < md.length; i += size) out.push(md.slice(i, i + size));
  return out;
}

function firstLine(block: string, max = 80): string {
  const ln = block.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return ln.replace(/[#*_>`-]/g, "").trim().slice(0, max);
}

// ─── Firecrawl helper ────────────────────────────────────────────────────
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
    return md.slice(0, 6000);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const NOW = () => new Date().toISOString();

// ─── FONTE 1: PVP — Portale Vendite Pubbliche Min. Giustizia ─────────────
const PVP_URLS = [
  "https://pvp.giustizia.it/pvp/it/list.wp?ricerca=true&comune=Padova&tipoAsta=IMMOBILIARE",
  "https://pvp.giustizia.it/pvp/it/list.wp?ricerca=true&provincia=PD&tipoAsta=IMMOBILIARE",
];
const PVP_KEYWORDS = [
  "lotto","prezzo base","udienza","tribunale","esecuzione",
  "pignoramento","aggiudicazione","immobile","appartamento","villa",
  "capannone","terreno","locale","ufficio",
];

function pvpParser(md: string): TerritoryRecord[] {
  const out: TerritoryRecord[] = [];
  for (const block of blocksOf(md)) {
    const lower = block.toLowerCase();
    const hits = PVP_KEYWORDS.filter((k) => lower.includes(k));
    if (hits.length < 2) continue;
    if (!/\d/.test(block)) continue;
    const title = anonymize(firstLine(block));
    if (title.length < 5) continue;
    const microzona = findZone(block);
    out.push({
      id: shortId("pvp", title + (microzona ?? "")),
      title,
      comune: "Padova",
      microzona,
      source_name: "Portale Vendite Pubbliche — Min. Giustizia",
      last_seen: NOW(),
      freshness: "fresco",
      priority_score: 90,
      scoring_reason: "Asta giudiziaria immobiliare su portale ufficiale",
      has_geo: false,
      municipality: "Padova",
      area_label: microzona,
      category: "area_trasformazione",
      tags: ["asta", "Padova", ...(microzona ? [microzona] : [])],
      freshness_label: "",
      priority_label: "",
      reason_short: "Asta giudiziaria — finestra di acquisizione certa",
    });
  }
  return out;
}

async function fetchPVP(key: string): Promise<TerritoryRecord[]> {
  const settled = await Promise.allSettled(PVP_URLS.map((u) => firecrawlScrape(u, key)));
  const out: TerritoryRecord[] = [];
  for (const r of settled) if (r.status === "fulfilled" && r.value) out.push(...pvpParser(r.value));
  return out;
}

// ─── FONTE 2: Subito.it — annunci privati ───────────────────────────────
const SUBITO_URLS = [
  "https://www.subito.it/annunci-veneto/vendita/immobili/padova/",
  "https://www.subito.it/annunci-veneto/vendita/immobili/?q=padova&o=1",
];
const PRIVATI_KEYWORDS = [
  "privato","vendo","vendesi","trattative",
  "appartamento","bilocale","trilocale","villa","terreno","box","garage",
];

function privatiParser(md: string, sourceName: string, priority: number, scoringReason: string, reasonShort: string, prefix: string): TerritoryRecord[] {
  const out: TerritoryRecord[] = [];
  for (const block of blocksOf(md, 600)) {
    const lower = block.toLowerCase();
    if (lower.includes("agenzia") || lower.includes("immobiliare")) continue;
    const hits = PRIVATI_KEYWORDS.filter((k) => lower.includes(k));
    if (hits.length < 2) continue;
    if (!/\d/.test(block)) continue;
    const title = anonymize(firstLine(block));
    if (title.length < 5) continue;
    const microzona = findZone(block);
    out.push({
      id: shortId(prefix, title + (microzona ?? "")),
      title,
      comune: "Padova",
      microzona,
      source_name: sourceName,
      last_seen: NOW(),
      freshness: "fresco",
      priority_score: priority,
      scoring_reason: scoringReason,
      has_geo: false,
      municipality: "Padova",
      area_label: microzona,
      category: "segnale_territoriale",
      tags: ["privato", "Padova", ...(microzona ? [microzona] : [])],
      freshness_label: "",
      priority_label: "",
      reason_short: reasonShort,
    });
  }
  return out;
}

async function fetchSubito(key: string): Promise<TerritoryRecord[]> {
  const settled = await Promise.allSettled(SUBITO_URLS.map((u) => firecrawlScrape(u, key)));
  const out: TerritoryRecord[] = [];
  for (const r of settled) if (r.status === "fulfilled" && r.value) {
    out.push(...privatiParser(
      r.value,
      "Subito.it — annunci privati",
      72,
      "Privato che vende senza agenzia — opportunità di incarico diretto",
      "Privato senza agenzia — primo contatto vantaggioso",
      "sub",
    ));
  }
  return out;
}

// ─── FONTE 3: Bakeca.it ──────────────────────────────────────────────────
const BAKECA_URLS = [
  "https://www.bakeca.it/annunci/vendita-case-appartamenti/padova/",
  "https://www.bakeca.it/annunci/vendita-ville/padova/",
];
async function fetchBakeca(key: string): Promise<TerritoryRecord[]> {
  const settled = await Promise.allSettled(BAKECA_URLS.map((u) => firecrawlScrape(u, key)));
  const out: TerritoryRecord[] = [];
  for (const r of settled) if (r.status === "fulfilled" && r.value) {
    out.push(...privatiParser(
      r.value,
      "Bakeca.it",
      65,
      "Annuncio privato su Bakeca — invenduto potenziale",
      "Invenduto su canale secondario — proprietario da qualificare",
      "bak",
    ));
  }
  return out;
}

// ─── FONTE 4: Necrologi — pressione successoria ──────────────────────────
const NECRO_URLS = [
  "https://www.padovanet.it/necrologi",
  "https://necrologi.gelocal.it/padova",
  "https://www.lastampa.it/necrologi/padova/",
];
const NECRO_KEYWORDS = [
  "anni","il giorno","i familiari","lascia","abitante di","residente",
];

function necrologiParser(md: string): TerritoryRecord[] {
  const out: TerritoryRecord[] = [];
  for (const block of blocksOf(md, 500)) {
    const lower = block.toLowerCase();
    const hits = NECRO_KEYWORDS.filter((k) => lower.includes(k));
    if (hits.length < 2) continue;
    // Must contain at least one name-shaped sequence to be a valid obit block,
    // but we strip names from output.
    if (!/\b[A-Z][a-zàèéìòù]{2,}\s+[A-Z][a-zàèéìòù]{2,}\b/.test(block)) continue;
    const microzona = findZone(block) ?? "Centro";
    const title = `Successione potenziale — zona ${microzona}`;
    out.push({
      id: shortId("nec", microzona + block.slice(0, 40)),
      title: anonymize(title),
      comune: "Padova",
      microzona,
      source_name: "Segnale demografico locale",
      last_seen: NOW(),
      freshness: "fresco",
      priority_score: 68,
      scoring_reason: anonymize("Probabile apertura successione in zona — patrimonio immobiliare da verificare"),
      has_geo: false,
      municipality: "Padova",
      area_label: microzona,
      category: "segnale_demografico",
      tags: ["successione", "demografico", "Padova"],
      freshness_label: "",
      priority_label: "",
      reason_short: anonymize("Pressione successoria attiva nella zona"),
    });
  }
  return out;
}

async function fetchNecrologi(key: string): Promise<TerritoryRecord[]> {
  const settled = await Promise.allSettled(NECRO_URLS.map((u) => firecrawlScrape(u, key)));
  const out: TerritoryRecord[] = [];
  for (const r of settled) if (r.status === "fulfilled" && r.value) out.push(...necrologiParser(r.value));
  return out;
}

// ─── FONTE 5: CCIAA — liquidazioni aziendali ─────────────────────────────
const CCIAA_URLS = [
  "https://www.registroimprese.it/ricerca-libera?q=liquidazione+Padova&filtro=PD",
  "https://www.pd.camcom.it/servizi/registro-imprese",
];
const CCIAA_KEYWORDS = [
  "liquidazione","scioglimento","cessazione","cancellazione",
  "sede legale padova","immobile","capannone","magazzino","ufficio",
];

function cciaaParser(md: string): TerritoryRecord[] {
  const out: TerritoryRecord[] = [];
  for (const block of blocksOf(md, 500)) {
    const lower = block.toLowerCase();
    const hits = CCIAA_KEYWORDS.filter((k) => lower.includes(k));
    if (hits.length < 2) continue;
    const title = anonymize(firstLine(block));
    if (title.length < 5) continue;
    const microzona = findZone(block);
    out.push({
      id: shortId("ccia", title + (microzona ?? "")),
      title,
      comune: "Padova",
      microzona,
      source_name: "Registro Imprese — Camera di Commercio PD",
      last_seen: NOW(),
      freshness: "fresco",
      priority_score: 75,
      scoring_reason: "Azienda in liquidazione con sede a Padova — asset immobiliari potenzialmente in dismissione",
      has_geo: false,
      municipality: "Padova",
      area_label: microzona,
      category: "brownfield",
      tags: ["liquidazione", "azienda", "Padova", ...(microzona ? [microzona] : [])],
      freshness_label: "",
      priority_label: "",
      reason_short: "Dismissione aziendale — possibili asset immobiliari",
    });
  }
  return out;
}

async function fetchCCIAA(key: string): Promise<TerritoryRecord[]> {
  const settled = await Promise.allSettled(CCIAA_URLS.map((u) => firecrawlScrape(u, key)));
  const out: TerritoryRecord[] = [];
  for (const r of settled) if (r.status === "fulfilled" && r.value) out.push(...cciaaParser(r.value));
  return out;
}

// ─── FONTE 6: Open Data Comune di Padova ─────────────────────────────────
const OPENDATA_URLS = [
  "https://opendata.comune.padova.it/dataset?q=edilizi",
  "https://opendata.comune.padova.it/dataset?q=permessi+costruire",
];
const OPENDATA_KEYWORDS = [
  "permesso","concessione","autorizzazione","suap",
  "ristrutturazione","demolizione","nuova costruzione","ampliamento",
];

function openDataParser(md: string): TerritoryRecord[] {
  const out: TerritoryRecord[] = [];
  const seen = new Set<string>();
  for (const block of blocksOf(md, 500)) {
    const lower = block.toLowerCase();
    const hits = OPENDATA_KEYWORDS.filter((k) => lower.includes(k));
    if (hits.length < 1) continue;
    const title = anonymize(firstLine(block));
    if (title.length < 8) continue;
    if (seen.has(title)) continue;
    seen.add(title);
    const microzona = findZone(block);
    out.push({
      id: shortId("opd", title),
      title,
      comune: "Padova",
      microzona,
      source_name: "Open Data Comune di Padova",
      last_seen: NOW(),
      freshness: "fresco",
      priority_score: 70,
      scoring_reason: "Permesso edilizio o SUAP attivo nel Comune di Padova",
      has_geo: false,
      municipality: "Padova",
      area_label: microzona,
      category: "cantiere",
      tags: ["edilizia", "open_data", "Padova", ...(microzona ? [microzona] : [])],
      freshness_label: "",
      priority_label: "",
      reason_short: "Attività edilizia autorizzata — zona in trasformazione",
    });
    if (out.length >= 20) break;
  }
  return out;
}

async function fetchOpenData(key: string): Promise<TerritoryRecord[]> {
  const settled = await Promise.allSettled(OPENDATA_URLS.map((u) => firecrawlScrape(u, key)));
  const out: TerritoryRecord[] = [];
  for (const r of settled) if (r.status === "fulfilled" && r.value) out.push(...openDataParser(r.value));
  return out;
}

// ─── FONTE 7: Perplexity ─────────────────────────────────────────────────
const VALID_CATEGORIES: Category[] = [
  "cantiere","area_trasformazione","demolizione","segnale_demografico","brownfield","segnale_territoriale",
];

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
          content: "Cerca SOLO su fonti italiane pubbliche verificabili (2024-2025) queste informazioni su Padova città (NON provincia):\n\n1. Immobili specifici in asta giudiziaria al Tribunale di Padova\n2. Aziende padovane in liquidazione con asset immobiliari (capannoni, uffici, sedi)\n3. Dismissioni immobiliari da parte di enti pubblici o sanitari padovani\n4. Immobili residenziali invenduti da oltre 12 mesi nelle microzone: Arcella, Portello, Forcellini, Guizza, Camin, Stanga, Zona Industriale\n\nRispondi SOLO con JSON array senza testo aggiuntivo, nessun markdown:\n[{\"microzona\":\"nome\",\"titolo\":\"descrizione anonima max 60 chars senza nomi di persone\",\"categoria\":\"area_trasformazione|brownfield|segnale_territoriale\",\"motivo\":\"perché rilevante per un agente immobiliare max 80 chars\",\"priorita\":65}]\n\nSe non hai dati concreti e verificabili per Padova CITTÀ, restituisci [].",
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
      const titolo = typeof e.titolo === "string" ? anonymize(e.titolo) : "";
      const microzona = typeof e.microzona === "string" ? e.microzona : "";
      const categoria = (typeof e.categoria === "string" ? e.categoria : "") as Category;
      const motivo = typeof e.motivo === "string" ? anonymize(e.motivo) : "";
      if (titolo.length < 10) continue;
      if (!VALID_CATEGORIES.includes(categoria)) continue;
      const priorita = typeof e.priorita === "number"
        ? Math.min(95, Math.max(40, e.priorita))
        : 65;
      out.push({
        id: shortId("perp", titolo),
        title: titolo,
        comune: "Padova",
        microzona: microzona || null,
        source_name: "Intelligence territoriale",
        last_seen: NOW(),
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

// ─── FONTE 8: Google Places (invariata) ──────────────────────────────────
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
      out.push({
        id: `gm-${placeId.slice(0, 20)}`,
        title: name,
        comune: "Padova",
        microzona,
        source_name: "Dati geografici",
        last_seen: NOW(),
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

  const fcKey = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
  const fcSources: Promise<TerritoryRecord[]>[] = fcKey ? [
    fetchPVP(fcKey),
    fetchSubito(fcKey),
    fetchBakeca(fcKey),
    fetchNecrologi(fcKey),
    fetchCCIAA(fcKey),
    fetchOpenData(fcKey),
  ] : [];

  const settled = await Promise.allSettled([
    ...fcSources,
    fetchPerplexity(),
    fetchGooglePlaces(),
  ]);

  const all: TerritoryRecord[] = [];
  for (const r of settled) if (r.status === "fulfilled") all.push(...r.value);

  const records = dedupe(all)
    .map((r) => ({
      ...r,
      freshness_label: freshnessLabel(r.last_seen),
      priority_label: priorityLabel(r.priority_score),
    }))
    .sort((a, b) => b.priority_score - a.priority_score)
    .slice(0, 50);

  const headers = {
    ...cors,
    "Content-Type": "application/json",
    "X-Source": records.length > 0 ? "live" : "empty",
    "X-Record-Count": String(records.length),
    "X-Core-Version": "3.5.0",
  };
  return new Response(JSON.stringify(records), { status: 200, headers });
});
