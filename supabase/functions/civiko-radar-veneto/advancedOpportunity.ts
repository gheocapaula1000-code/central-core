// ═══════════════════════════════════════════════════════════════
// Advanced Veneto Opportunity Engine
// Orchestrates: legal extraction, listing velocity, pricing errors,
// motivated sellers refresh, urgent opportunities.
//
// HARD RULES:
//   - No demo/mock/seed. Records derived from demo sources are skipped.
//   - Every imported row carries source_url + data_basis.
//   - No personal data exposed.
//   - Signals only when sufficient evidence is present.
// ═══════════════════════════════════════════════════════════════
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { fcScrape, firecrawlAvailable } from "./firecrawl/firecrawlClient.ts";
import { filterSources, registryStats } from "./firecrawl/sourceRegistry.ts";
import { isForbiddenPage, isDemoText, isVenetoProvince } from "./firecrawl/complianceGuards.ts";
import { sha1Hex } from "./firecrawl/dedupe.ts";
import { planCrawlUrls } from "./firecrawl/crawlPlanner.ts";

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────
export interface AdvancedJobRequest {
  dryRun?: boolean;
  runFirecrawl?: boolean;
  runLegal?: boolean;
  runVelocity?: boolean;
  runPricing?: boolean;
  runUrgent?: boolean;
  province?: string[];
  comuni?: string[];
  maxPagesPerSource?: number;
  maxDepth?: number;
  import?: boolean;
}

export interface AdvancedJobReport {
  ok: boolean;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  firecrawl_available: boolean;
  firecrawl_pages_seen: number;
  firecrawl_documents_saved: number;
  legal_candidates: number;
  legal_imported: number;
  velocity_candidates: number;
  velocity_imported: number;
  pricing_candidates: number;
  pricing_imported: number;
  motivated_sellers_created: number;
  urgent_opportunities_created: number;
  radar_signals_added: number;
  rejected_demo: number;
  rejected_invalid: number;
  warnings: string[];
  next_actions: string[];
  samples: {
    legal: unknown[];
    velocity: unknown[];
    pricing: unknown[];
    urgent: unknown[];
  };
}

const VENETO_PROV = new Set(["VE", "VR", "VI", "PD", "TV", "BL", "RO"]);
const DEMO_MARKERS = ["seed_demo", "seed", "demo", "mock", "fixture", "sample", "fake", "stub"];
function isDemoVal(...vals: unknown[]): boolean {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).toLowerCase();
    if (DEMO_MARKERS.some((m) => s.includes(m))) return true;
  }
  return false;
}

function svc(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ═══════════════════════════════════════════════════════════════
// LEGAL EXTRACTOR (Firecrawl)
// ═══════════════════════════════════════════════════════════════
const LEGAL_PATTERNS: Array<{ rx: RegExp; type: string }> = [
  { rx: /\bpignoramento\s+immobiliare\b/i, type: "pignoramento" },
  { rx: /\bvendita\s+(giudiziaria|forzata)\b/i, type: "vendita_giudiziaria" },
  { rx: /\basta\s+(immobiliare|telematica|giudiziaria)\b/i, type: "asta" },
  { rx: /\bavviso\s+di\s+vendita\b/i, type: "asta" },
  { rx: /\bliquidazione\s+(giudiziale|controllata)\b/i, type: "liquidazione_giudiziale" },
  { rx: /\bfallimento\b/i, type: "fallimento" },
  { rx: /\bconcordato\s+preventivo\b/i, type: "concordato" },
  { rx: /\bprocedura\s+concorsuale\b/i, type: "procedura_concorsuale" },
  { rx: /\balienazione\s+immobile\b/i, type: "asta" },
];
const PRICE_RX = /(?:prezzo\s+(?:base|minimo|d['’]?asta)|offerta\s+minima)\s*:?\s*€?\s*([\d.\s]{4,15})/i;
const SALE_DATE_RX = /(?:data\s+(?:vendita|asta|udienza)|fissat[ao]\s+per\s+il)\s*:?\s*(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4})/i;
const COURT_RX = /\btribunale\s+di\s+([A-ZÀ-Ü][a-zà-ü\s]{3,30})/i;
const COMUNE_RX = /\b(?:comune|sito\s+in|ubicat[oa]\s+in)\s+([A-ZÀ-Ü][A-Za-zÀ-ü'\s]{2,40})/i;

// Strip personal data hints
const PERSONAL_RX = [
  /\b[A-Z]{6}\d{2}[A-EHLMPRT]\d{2}[A-Z]\d{3}[A-Z]\b/g, // CF
  /\bcodice\s+fiscale[:\s]+[A-Z0-9]+/gi,
  /\b(?:nato|nata)\s+(?:a|il)[^\.]{0,80}/gi,
];

function stripPersonal(txt: string): { clean: string; redacted: boolean } {
  let clean = txt;
  let redacted = false;
  for (const rx of PERSONAL_RX) {
    if (rx.test(clean)) { redacted = true; clean = clean.replace(rx, "[redatto]"); }
  }
  return { clean, redacted };
}

function parsePriceEur(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, "").replace(/\./g, "").replace(/,/g, ".");
  const n = parseFloat(cleaned);
  return isFinite(n) && n > 1000 ? n : null;
}
function parseDateIt(raw: string): string | null {
  const m = raw.match(/(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{2,4})/);
  if (!m) return null;
  let [_, d, mo, y] = m;
  if (y.length === 2) y = "20" + y;
  const iso = `${y.padStart(4, "0")}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return iso;
}

interface LegalCandidate {
  source_name: string; source_url: string;
  signal_type: string; comune: string | null; provincia: string | null;
  property_type: string | null; court_or_authority: string | null;
  base_price_eur: number | null; sale_date: string | null;
  status: string; confidence: number; data_basis: string[];
  privacy_redacted: boolean; payload: Record<string, unknown>;
}

function extractLegalFromText(txt: string, sourceUrl: string, sourceName: string, comuneHint: string | null, provHint: string | null): LegalCandidate | null {
  if (!txt || txt.length < 80) return null;
  const lower = txt.toLowerCase();
  const matched = LEGAL_PATTERNS.find((p) => p.rx.test(txt));
  if (!matched) return null;

  const { clean, redacted } = stripPersonal(txt);

  let basePrice: number | null = null;
  const pm = clean.match(PRICE_RX);
  if (pm) basePrice = parsePriceEur(pm[1]);

  let saleDate: string | null = null;
  const dm = clean.match(SALE_DATE_RX);
  if (dm) saleDate = parseDateIt(dm[1]);

  let court: string | null = null;
  const cm = clean.match(COURT_RX);
  if (cm) court = cm[1].trim().split(/\s+/).slice(0, 3).join(" ");

  let comune = comuneHint;
  if (!comune) {
    const m = clean.match(COMUNE_RX);
    if (m) comune = m[1].trim().split(/[,\.\n]/)[0].trim();
  }
  const provincia = provHint;

  let propertyType: string | null = null;
  if (/\bappartament|trilocal|bilocal|monolocal/i.test(lower)) propertyType = "appartamento";
  else if (/\bvilla\b|villetta/i.test(lower)) propertyType = "villa";
  else if (/\bcapannone|magazzin|laboratorio/i.test(lower)) propertyType = "industriale";
  else if (/\bnegozio|locale\s+commerciale|ufficio/i.test(lower)) propertyType = "commerciale";
  else if (/\bterreno|fondo\s+rustico/i.test(lower)) propertyType = "terreno";

  let confidence = 50;
  if (basePrice) confidence += 15;
  if (saleDate) confidence += 15;
  if (court) confidence += 10;
  if (comune) confidence += 5;
  if (propertyType) confidence += 5;

  return {
    source_name: sourceName, source_url: sourceUrl,
    signal_type: matched.type,
    comune: comune || null, provincia,
    property_type: propertyType, court_or_authority: court,
    base_price_eur: basePrice, sale_date: saleDate,
    status: "active", confidence, privacy_redacted: redacted,
    data_basis: ["firecrawl", sourceName, "regex_extractor"].filter(Boolean),
    payload: { snippet: clean.slice(0, 500) },
  };
}

async function runLegalFirecrawl(opts: {
  province: string[]; comuni: string[]; maxPages: number; maxDepth: number;
}, warnings: string[]): Promise<{ candidates: LegalCandidate[]; pages: number; documents_saved: number }> {
  const out: LegalCandidate[] = [];
  let pages = 0;
  let saved = 0;
  if (!firecrawlAvailable()) { warnings.push("firecrawl_unavailable"); return { candidates: out, pages, documents_saved: saved }; }

  const sources = filterSources({
    province: opts.province,
    comuni: opts.comuni,
    sourceTypes: ["auctions", "ivg", "municipal_notices"],
  }).slice(0, 8);

  for (const src of sources) {
    if (isForbiddenPage(src.base_url)) { warnings.push(`forbidden:${src.source_name}`); continue; }
    const targets: string[] = [src.base_url];
    if (src.crawl_depth >= 1) {
      const m = await fcMap(src.base_url, { search: "asta vendita pignoramento", limit: Math.min(opts.maxPages, src.max_pages) });
      if (m.ok) {
        for (const raw of m.links) {
          if (targets.length >= opts.maxPages) break;
          const l = typeof raw === "string" ? raw : (raw as { url?: string })?.url;
          if (!l || typeof l !== "string") continue;
          if (isForbiddenPage(l)) continue;
          if (!/asta|vendita|pignoramento|alienazion|liquidazion/i.test(l)) continue;
          targets.push(l);
        }
      }
    }

    for (const url of targets.slice(0, opts.maxPages)) {
      const r = await fcScrape(url, { timeoutMs: 18_000, formats: ["markdown"] });
      pages++;
      if (!r.ok || !r.markdown) continue;
      if (isDemoText(r.markdown)) continue;
      const provHint = src.province[0] ?? null;
      const comuneHint = src.comuni?.[0] ?? null;
      const cand = extractLegalFromText(r.markdown, url, src.source_name, comuneHint, provHint);
      if (cand && cand.confidence >= 70 && cand.comune) {
        out.push(cand);
        saved++;
      }
    }
  }
  return { candidates: out, pages, documents_saved: saved };
}

// ═══════════════════════════════════════════════════════════════
// LISTING VELOCITY ENGINE (DB-derived from listing_price_snapshots)
// ═══════════════════════════════════════════════════════════════
interface VelocityCandidate {
  listing_hash: string; source_name: string; source_url: string | null;
  comune: string | null; provincia: string | null;
  property_type: string | null;
  price_eur: number | null; previous_price_eur: number | null;
  surface_mq: number | null; price_per_mq: number | null;
  first_seen_at: string | null; last_seen_at: string | null; detected_at: string;
  hours_since_first_seen: number | null; days_online: number | null;
  price_drop_percent: number | null;
  repost_detected: boolean; stale_listing: boolean; fresh_listing: boolean;
  velocity_type: string;
  confidence_score: number; quality: string; data_basis: string[];
  payload: Record<string, unknown>;
}

async function runVelocityEngine(supa: SupabaseClient, opts: { province: string[] }, warnings: string[]): Promise<VelocityCandidate[]> {
  const candidates: VelocityCandidate[] = [];
  // Pull recent snapshots, filter demo
  const { data, error } = await supa.from("listing_price_snapshots")
    .select("listing_id, identity_hash, source, url, price_eur, surface_sqm, first_seen_at, captured_at, municipality, province, property_type")
    .order("captured_at", { ascending: false })
    .range(0, 2000);
  if (error) { warnings.push(`velocity_query: ${error.message}`); return candidates; }
  if (!data?.length) return candidates;

  // Group by identity_hash (or listing_id+source as fallback)
  const byHash = new Map<string, typeof data>();
  for (const row of data) {
    if (isDemoVal(row.source, row.url)) continue;
    if (!isVenetoProvince(row.province ?? "")) continue;
    if (opts.province.length && !opts.province.includes((row.province ?? "").toUpperCase())) continue;
    const h = row.identity_hash || `${row.source}:${row.listing_id}`;
    if (!h) continue;
    const arr = byHash.get(h) ?? [];
    arr.push(row);
    byHash.set(h, arr);
  }

  const now = Date.now();
  for (const [hash, rows] of byHash) {
    rows.sort((a, b) => new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime());
    const first = rows[0];
    const last = rows[rows.length - 1];
    const firstSeen = first.first_seen_at ?? first.captured_at;
    const lastSeen = last.captured_at;
    const hoursSinceFirst = (now - new Date(firstSeen).getTime()) / 3_600_000;
    const daysOnline = Math.floor(hoursSinceFirst / 24);

    const prevPrice = rows.length >= 2 ? Number(rows[rows.length - 2].price_eur) : null;
    const curPrice = Number(last.price_eur);
    const dropPct = (prevPrice && curPrice && prevPrice > 0) ? ((prevPrice - curPrice) / prevPrice) * 100 : null;

    let velocityType = "unknown";
    let fresh = false, stale = false, repost = false;
    if (hoursSinceFirst <= 1) { velocityType = "new_under_1h"; fresh = true; }
    else if (hoursSinceFirst <= 24) { velocityType = "new_under_24h"; fresh = true; }
    if (daysOnline >= 120) { velocityType = "stale_120d"; stale = true; }
    else if (daysOnline >= 90) { velocityType = "stale_90d"; stale = true; }
    if (dropPct !== null && dropPct >= 5) { velocityType = "price_drop"; }
    // repost detection: gap >30d between captures with same hash
    if (rows.length >= 3) {
      for (let i = 1; i < rows.length; i++) {
        const gap = (new Date(rows[i].captured_at).getTime() - new Date(rows[i - 1].captured_at).getTime()) / 86_400_000;
        if (gap > 30) { repost = true; velocityType = "reposted"; break; }
      }
    }
    if (velocityType === "unknown") continue;

    const surface = Number(last.surface_sqm) || null;
    const ppm = (curPrice && surface) ? Math.round(curPrice / surface) : null;

    let conf = 60;
    if (rows.length >= 3) conf += 15;
    if (dropPct !== null) conf += 10;
    if (surface) conf += 5;

    candidates.push({
      listing_hash: hash,
      source_name: String(last.source ?? "unknown"),
      source_url: last.url,
      comune: last.municipality, provincia: (last.province ?? "").toUpperCase(),
      property_type: last.property_type,
      price_eur: curPrice || null, previous_price_eur: prevPrice,
      surface_mq: surface, price_per_mq: ppm,
      first_seen_at: firstSeen, last_seen_at: lastSeen,
      detected_at: new Date().toISOString(),
      hours_since_first_seen: Math.round(hoursSinceFirst * 10) / 10,
      days_online: daysOnline,
      price_drop_percent: dropPct !== null ? Math.round(dropPct * 10) / 10 : null,
      repost_detected: repost, stale_listing: stale, fresh_listing: fresh,
      velocity_type: velocityType,
      confidence_score: Math.min(100, conf), quality: "parziale",
      data_basis: ["listing_price_snapshots"],
      payload: { observations: rows.length },
    });
  }
  return candidates;
}

// ═══════════════════════════════════════════════════════════════
// PRICING ERROR ENGINE
// ═══════════════════════════════════════════════════════════════
interface PricingCandidate {
  listing_hash: string; source_name: string | null; source_url: string | null;
  comune: string | null; provincia: string | null; property_type: string | null;
  price_eur: number | null; surface_mq: number | null; price_per_mq: number | null;
  omi_min: number | null; omi_max: number | null; omi_avg: number | null;
  comparable_avg: number | null;
  deviation_from_omi_percent: number | null;
  deviation_from_comparable_percent: number | null;
  pricing_error_type: string; score: number; confidence_score: number;
  reason: string; recommended_action: string;
  data_basis: string[]; quality: string;
}

async function runPricingEngine(supa: SupabaseClient, velocity: VelocityCandidate[], warnings: string[]): Promise<PricingCandidate[]> {
  const out: PricingCandidate[] = [];
  if (velocity.length === 0) return out;

  // Cache OMI per comune (residenziale)
  const comuni = Array.from(new Set(velocity.map((v) => v.comune).filter(Boolean) as string[]));
  if (!comuni.length) return out;
  const comuniUpper = comuni.map((c) => c.toUpperCase());

  const omiCache = new Map<string, { min: number; max: number; avg: number }>();
  for (let i = 0; i < comuniUpper.length; i += 200) {
    const slice = comuniUpper.slice(i, i + 200);
    const { data, error } = await supa.from("omi_valori")
      .select("comune_descrizione, compr_min, compr_max, descr_tipologia")
      .in("comune_descrizione", slice)
      .ilike("descr_tipologia", "%abitazion%");
    if (error) { warnings.push(`omi_lookup: ${error.message}`); continue; }
    const buckets = new Map<string, { min: number[]; max: number[] }>();
    for (const row of data ?? []) {
      const k = (row.comune_descrizione ?? "").toUpperCase();
      const b = buckets.get(k) ?? { min: [], max: [] };
      if (row.compr_min) b.min.push(Number(row.compr_min));
      if (row.compr_max) b.max.push(Number(row.compr_max));
      buckets.set(k, b);
    }
    for (const [k, b] of buckets) {
      if (!b.min.length || !b.max.length) continue;
      const min = b.min.reduce((a, x) => a + x, 0) / b.min.length;
      const max = b.max.reduce((a, x) => a + x, 0) / b.max.length;
      omiCache.set(k, { min, max, avg: (min + max) / 2 });
    }
  }

  for (const v of velocity) {
    if (!v.price_per_mq || !v.comune) continue;
    const omi = omiCache.get(v.comune.toUpperCase());
    if (!omi) continue;
    const dev = ((v.price_per_mq - omi.avg) / omi.avg) * 100;
    let type = "unknown", reason = "", action = "";
    if (dev <= -12) {
      type = v.fresh_listing ? "under_omi_fast_action" : "underpriced";
      reason = `Prezzo al mq ${Math.round(dev)}% sotto OMI medio (${Math.round(omi.avg)} €/mq).`;
      action = v.fresh_listing
        ? "Allertare investitori entro 24h: opportunità sottoprezzo appena pubblicata."
        : "Verificare stato immobile e segnalare a investitori per acquisto rapido.";
    } else if (dev >= 18) {
      type = (v.days_online ?? 0) >= 90 ? "over_omi_stale" : "overpriced";
      reason = `Prezzo al mq ${Math.round(dev)}% sopra OMI medio (${Math.round(omi.avg)} €/mq), ${v.days_online ?? 0}gg online.`;
      action = "Contattare proprietario con analisi OMI: proposta esclusiva per riposizionamento prezzo.";
    } else if (Math.abs(dev) >= 8 && (v.days_online ?? 0) >= 60) {
      type = "price_mismatch";
      reason = `Prezzo disallineato (${Math.round(dev)}%) con giacenza ${v.days_online}gg.`;
      action = "Audit prezzo + suggerimento riposizionamento.";
    } else continue;

    const score = Math.min(100, Math.round(50 + Math.abs(dev) * 1.5 + (v.days_online ?? 0) / 10));
    out.push({
      listing_hash: v.listing_hash,
      source_name: v.source_name, source_url: v.source_url,
      comune: v.comune, provincia: v.provincia, property_type: v.property_type,
      price_eur: v.price_eur, surface_mq: v.surface_mq, price_per_mq: v.price_per_mq,
      omi_min: Math.round(omi.min), omi_max: Math.round(omi.max), omi_avg: Math.round(omi.avg),
      comparable_avg: null,
      deviation_from_omi_percent: Math.round(dev * 10) / 10,
      deviation_from_comparable_percent: null,
      pricing_error_type: type, score,
      confidence_score: Math.min(100, v.confidence_score + 10),
      reason, recommended_action: action,
      data_basis: ["listing_price_snapshots", "omi_valori"], quality: "parziale",
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// URGENT OPPORTUNITY ENGINE
// ═══════════════════════════════════════════════════════════════
interface UrgentCandidate {
  fingerprint: string;
  comune: string | null; provincia: string | null; area_label: string;
  opportunity_type: string; priority: string; time_window: string;
  title: string; reason: string; agent_action: string; script: string; target: string;
  source_urls: string[]; data_basis: string[];
  confidence_score: number; quality: string;
  expires_at: string | null;
}

async function buildUrgentOpportunities(legal: LegalCandidate[], velocity: VelocityCandidate[], pricing: PricingCandidate[]): Promise<UrgentCandidate[]> {
  const out: UrgentCandidate[] = [];
  const mkFp = async (s: string) => "uop_" + (await sha1Hex(s)).slice(0, 24);
  const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

  // Legal — immediata if sale within 30 days
  for (const l of legal) {
    const soon = l.sale_date ? (new Date(l.sale_date).getTime() - Date.now()) < 30 * 86_400_000 : false;
    const priority = soon ? "immediata" : "alta";
    out.push({
      fingerprint: await mkFp(`legal|${l.source_url}|${l.comune}`),
      comune: l.comune, provincia: l.provincia,
      area_label: l.comune ?? "—",
      opportunity_type: l.signal_type === "asta" ? "auction" : "legal_asset",
      priority, time_window: soon ? "30d" : "90d",
      title: `${l.comune ?? "Veneto"} — ${l.signal_type} (${l.property_type ?? "immobile"})`,
      reason: `${l.signal_type} rilevato${l.court_or_authority ? ` presso ${l.court_or_authority}` : ""}${l.base_price_eur ? `, prezzo base €${l.base_price_eur.toLocaleString("it-IT")}` : ""}.`,
      agent_action: "Verificare fascicolo pubblico e valutare opportunità per investitori prima della scadenza.",
      script: `Buongiorno, monitoro le procedure su ${l.comune}. Posso aiutarla a leggere il fascicolo e valutare l'opportunità prima dell'asta.`,
      target: "investitori",
      source_urls: [l.source_url], data_basis: l.data_basis,
      confidence_score: l.confidence, quality: "parziale",
      expires_at: l.sale_date ?? future(60),
    });
  }

  // Pricing immediata
  for (const p of pricing) {
    if (p.pricing_error_type === "under_omi_fast_action") {
      out.push({
        fingerprint: await mkFp(`pric|${p.listing_hash}`),
        comune: p.comune, provincia: p.provincia,
        area_label: p.comune ?? "—",
        opportunity_type: "underpriced_listing",
        priority: "immediata", time_window: "24h",
        title: `${p.comune} — sottoprezzo appena pubblicato`,
        reason: p.reason, agent_action: p.recommended_action,
        script: `Buongiorno, ho un immobile su ${p.comune} appena pubblicato a un prezzo molto interessante rispetto ai valori OMI. Le interessa una segnalazione rapida?`,
        target: "investitori",
        source_urls: p.source_url ? [p.source_url] : [],
        data_basis: p.data_basis,
        confidence_score: p.confidence_score, quality: "parziale",
        expires_at: future(2),
      });
    } else if (p.pricing_error_type === "over_omi_stale") {
      out.push({
        fingerprint: await mkFp(`pric|${p.listing_hash}`),
        comune: p.comune, provincia: p.provincia,
        area_label: p.comune ?? "—",
        opportunity_type: "stale_listing_acquisition",
        priority: "alta", time_window: "30d",
        title: `${p.comune} — opportunità acquisizione su immobile fermo`,
        reason: p.reason, agent_action: p.recommended_action,
        script: `Buongiorno, ho visto che il suo immobile è online da diverso tempo. Lavoro su ${p.comune} con dati OMI aggiornati: posso proporle una valutazione realistica.`,
        target: "acquisizione",
        source_urls: p.source_url ? [p.source_url] : [],
        data_basis: p.data_basis,
        confidence_score: p.confidence_score, quality: "parziale",
        expires_at: future(30),
      });
    } else if (p.pricing_error_type === "underpriced") {
      out.push({
        fingerprint: await mkFp(`pric|${p.listing_hash}`),
        comune: p.comune, provincia: p.provincia,
        area_label: p.comune ?? "—",
        opportunity_type: "underpriced_listing",
        priority: "alta", time_window: "7d",
        title: `${p.comune} — immobile sottoprezzo`,
        reason: p.reason, agent_action: p.recommended_action, script: p.recommended_action,
        target: "investitori",
        source_urls: p.source_url ? [p.source_url] : [],
        data_basis: p.data_basis,
        confidence_score: p.confidence_score, quality: "parziale",
        expires_at: future(7),
      });
    }
  }

  // Velocity price drops
  for (const v of velocity) {
    if (v.velocity_type === "price_drop" && (v.price_drop_percent ?? 0) >= 10) {
      out.push({
        fingerprint: await mkFp(`vel|${v.listing_hash}|drop`),
        comune: v.comune, provincia: v.provincia,
        area_label: v.comune ?? "—",
        opportunity_type: "price_drop",
        priority: "alta", time_window: "7d",
        title: `${v.comune} — ribasso ${v.price_drop_percent}%`,
        reason: `Ribasso del ${v.price_drop_percent}% su immobile online da ${v.days_online}gg.`,
        agent_action: "Contattare proprietario con analisi OMI e proposta esclusiva.",
        script: `Buongiorno, ho notato un ribasso recente sul suo immobile. Posso proporle una strategia per chiudere entro 60 giorni con un'analisi OMI aggiornata.`,
        target: "esclusiva",
        source_urls: v.source_url ? [v.source_url] : [],
        data_basis: v.data_basis,
        confidence_score: v.confidence_score, quality: "parziale",
        expires_at: future(7),
      });
    } else if (v.velocity_type === "new_under_1h") {
      out.push({
        fingerprint: await mkFp(`vel|${v.listing_hash}|new1h`),
        comune: v.comune, provincia: v.provincia,
        area_label: v.comune ?? "—",
        opportunity_type: "fresh_listing",
        priority: "immediata", time_window: "1h",
        title: `${v.comune} — nuovo immobile entro 1h`,
        reason: `Nuovo annuncio rilevato meno di un'ora fa.`,
        agent_action: "Contatto immediato con investitori in lista.",
        script: `Buongiorno, segnalo un immobile appena pubblicato su ${v.comune} che potrebbe rientrare nei suoi parametri.`,
        target: "investitori",
        source_urls: v.source_url ? [v.source_url] : [],
        data_basis: v.data_basis,
        confidence_score: v.confidence_score, quality: "parziale",
        expires_at: future(1 / 24),
      });
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// MOTIVATED SELLERS REFRESH (from velocity + pricing)
// ═══════════════════════════════════════════════════════════════
async function refreshMotivatedSellers(supa: SupabaseClient, velocity: VelocityCandidate[], pricing: PricingCandidate[], doImport: boolean, warnings: string[]): Promise<number> {
  let count = 0;
  const now = new Date().toISOString();
  const fpHashes = new Set<string>();
  const rows: Record<string, unknown>[] = [];

  for (const v of velocity) {
    let label = "", score = 0;
    if (v.velocity_type === "stale_120d") { label = "stale_120d"; score = 80; }
    else if (v.velocity_type === "stale_90d") { label = "stale_90d"; score = 65; }
    else if (v.velocity_type === "price_drop" && (v.price_drop_percent ?? 0) >= 5) { label = "price_drop"; score = 60 + Math.min(40, (v.price_drop_percent ?? 0) * 2); }
    else if (v.velocity_type === "reposted") { label = "reposted"; score = 70; }
    else continue;
    if (fpHashes.has(v.listing_hash)) continue;
    fpHashes.add(v.listing_hash);

    rows.push({
      identity_hash: v.listing_hash,
      listing_id: v.listing_hash.slice(0, 50),
      url: v.source_url,
      source: v.source_name,
      municipality: v.comune, province: v.provincia,
      first_seen_at: v.first_seen_at ?? v.detected_at,
      initial_price_eur: v.previous_price_eur,
      last_price_eur: v.price_eur,
      total_drop_pct: v.price_drop_percent,
      drops_count: v.price_drop_percent ? 1 : 0,
      days_online: v.days_online,
      fatigue_score: score,
      fatigue_label: label,
      detected_at: now, is_active: true,
      payload: { quality: "parziale", data_basis: v.data_basis, velocity_type: v.velocity_type },
    });
  }
  for (const p of pricing) {
    if (p.pricing_error_type !== "over_omi_stale") continue;
    if (fpHashes.has(p.listing_hash)) continue;
    fpHashes.add(p.listing_hash);
    rows.push({
      identity_hash: p.listing_hash,
      listing_id: p.listing_hash.slice(0, 50),
      url: p.source_url, source: p.source_name,
      municipality: p.comune, province: p.provincia,
      first_seen_at: now, last_price_eur: p.price_eur,
      drops_count: 0, days_online: 90,
      fatigue_score: p.score, fatigue_label: "over_omi_stale",
      detected_at: now, is_active: true,
      payload: { quality: "parziale", data_basis: p.data_basis },
    });
  }

  if (!rows.length) return 0;
  if (!doImport) return rows.length;

  // Upsert by identity_hash
  for (const row of rows) {
    const { error } = await supa.from("motivated_sellers")
      .upsert(row, { onConflict: "identity_hash" });
    if (error) warnings.push(`motivated_upsert: ${error.message}`);
    else count++;
  }
  return count;
}

// ═══════════════════════════════════════════════════════════════
// RADAR SIGNALS sync
// ═══════════════════════════════════════════════════════════════
async function syncRadarSignals(supa: SupabaseClient, urgent: UrgentCandidate[], doImport: boolean, warnings: string[]): Promise<number> {
  if (!urgent.length || !doImport) return urgent.length;
  let added = 0;
  for (const u of urgent) {
    const row = {
      fingerprint: u.fingerprint,
      signal_type: u.opportunity_type,
      title: u.title, description: u.reason,
      municipality: u.comune, province: u.provincia,
      evidence_url: u.source_urls[0] ?? null,
      source: u.data_basis.join(","),
      urgency: u.priority === "immediata" ? "alta" : u.priority === "alta" ? "alta" : "media",
      confidence: u.confidence_score >= 80 ? "high" : u.confidence_score >= 60 ? "medium" : "low",
      payload: { time_window: u.time_window, agent_action: u.agent_action, script: u.script, target: u.target, data_basis: u.data_basis, quality: u.quality },
      detected_at: new Date().toISOString(),
      expires_at: u.expires_at, is_active: true,
    };
    const { error } = await supa.from("radar_signals").upsert(row, { onConflict: "fingerprint" });
    if (error) warnings.push(`radar_signal: ${error.message}`);
    else added++;
  }
  return added;
}

// ═══════════════════════════════════════════════════════════════
// IMPORTERS
// ═══════════════════════════════════════════════════════════════
async function importLegal(supa: SupabaseClient, items: LegalCandidate[], warnings: string[]): Promise<number> {
  let n = 0;
  for (const c of items) {
    const fp = "leg_" + (await sha1Hex(`${c.source_name}|${c.source_url}|${c.comune}|${c.signal_type}|${c.sale_date ?? ""}`)).slice(0, 24);
    const row = {
      source_name: c.source_name, source_url: c.source_url,
      signal_type: c.signal_type, comune: c.comune, provincia: c.provincia,
      property_type: c.property_type, court_or_authority: c.court_or_authority,
      base_price_eur: c.base_price_eur, sale_date: c.sale_date, status: c.status,
      confidence_score: c.confidence, quality: "parziale",
      data_basis: c.data_basis, extracted_entities: {}, payload: c.payload,
      privacy_redacted: c.privacy_redacted, fingerprint: fp,
    };
    const { error } = await supa.from("legal_property_signals").upsert(row, { onConflict: "fingerprint" });
    if (error) warnings.push(`legal_upsert: ${error.message}`);
    else n++;
  }
  return n;
}
async function importVelocity(supa: SupabaseClient, items: VelocityCandidate[], warnings: string[]): Promise<number> {
  let n = 0;
  for (const c of items) {
    const { error } = await supa.from("listing_velocity_signals").upsert(c, { onConflict: "listing_hash,velocity_type" });
    if (error) warnings.push(`velocity_upsert: ${error.message}`);
    else n++;
  }
  return n;
}
async function importPricing(supa: SupabaseClient, items: PricingCandidate[], warnings: string[]): Promise<number> {
  let n = 0;
  for (const c of items) {
    const { error } = await supa.from("pricing_error_signals").upsert(c, { onConflict: "listing_hash,pricing_error_type" });
    if (error) warnings.push(`pricing_upsert: ${error.message}`);
    else n++;
  }
  return n;
}
async function importUrgent(supa: SupabaseClient, items: UrgentCandidate[], warnings: string[]): Promise<number> {
  let n = 0;
  for (const c of items) {
    const { error } = await supa.from("urgent_opportunity_signals").upsert(c, { onConflict: "fingerprint" });
    if (error) warnings.push(`urgent_upsert: ${error.message}`);
    else n++;
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════
// ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════
export async function runAdvancedVenetoOpportunities(req: AdvancedJobRequest): Promise<AdvancedJobReport> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const warnings: string[] = [];
  const dryRun = req.dryRun !== false;
  const doImport = req.import === true && !dryRun;
  const province = (req.province ?? ["VE", "VR", "VI", "PD", "TV", "BL", "RO"]).map((p) => p.toUpperCase()).filter((p) => VENETO_PROV.has(p));
  const comuni = req.comuni ?? [];

  const supa = svc();
  if (!supa) {
    return baseReport(startedAt, t0, false, warnings, ["service_role_missing"]);
  }

  let legalCands: LegalCandidate[] = [];
  let pagesSeen = 0, docsSaved = 0;
  if (req.runFirecrawl !== false && req.runLegal !== false) {
    const legal = await runLegalFirecrawl({
      province, comuni,
      maxPages: req.maxPagesPerSource ?? 30,
      maxDepth: req.maxDepth ?? 1,
    }, warnings);
    legalCands = legal.candidates;
    pagesSeen = legal.pages;
    docsSaved = legal.documents_saved;
  }

  let velocity: VelocityCandidate[] = [];
  if (req.runVelocity !== false) {
    velocity = await runVelocityEngine(supa, { province }, warnings);
  }

  let pricing: PricingCandidate[] = [];
  if (req.runPricing !== false) {
    pricing = await runPricingEngine(supa, velocity, warnings);
  }

  let urgent: UrgentCandidate[] = [];
  if (req.runUrgent !== false) {
    urgent = await buildUrgentOpportunities(legalCands, velocity, pricing);
  }

  let legalImported = 0, velImp = 0, priImp = 0, urgImp = 0, motivCreated = 0, radarAdded = 0;
  if (doImport) {
    legalImported = await importLegal(supa, legalCands, warnings);
    velImp = await importVelocity(supa, velocity, warnings);
    priImp = await importPricing(supa, pricing, warnings);
    urgImp = await importUrgent(supa, urgent, warnings);
    motivCreated = await refreshMotivatedSellers(supa, velocity, pricing, true, warnings);
    radarAdded = await syncRadarSignals(supa, urgent, true, warnings);
  } else {
    motivCreated = await refreshMotivatedSellers(supa, velocity, pricing, false, warnings);
  }

  // Log run
  if (doImport) {
    await supa.from("ingestion_runs").insert({
      job_name: "build-advanced-veneto-opportunities",
      source_name: "internal",
      status: "completed",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      rows_in: pagesSeen,
      rows_out: legalImported + velImp + priImp + urgImp,
      warnings, errors: [],
      report: {
        legal: legalImported, velocity: velImp, pricing: priImp, urgent: urgImp,
        motivated_sellers: motivCreated, radar_signals: radarAdded,
      },
    }).select().maybeSingle();
  }

  const next: string[] = [];
  if (!firecrawlAvailable()) next.push("Configurare FIRECRAWL_API_KEY per estrazione legale.");
  if (legalCands.length === 0) next.push("Aggiungere fonti legali pubbliche (IVG/PVP locali) alla source registry.");
  if (velocity.length === 0) next.push("Popolare listing_price_snapshots con osservazioni reali via portali autorizzati.");
  if (pricing.length === 0 && velocity.length > 0) next.push("Estendere copertura OMI per i comuni con velocity signals.");

  return {
    ok: true, started_at: startedAt, ended_at: new Date().toISOString(),
    duration_ms: Date.now() - t0,
    firecrawl_available: firecrawlAvailable(),
    firecrawl_pages_seen: pagesSeen, firecrawl_documents_saved: docsSaved,
    legal_candidates: legalCands.length, legal_imported: legalImported,
    velocity_candidates: velocity.length, velocity_imported: velImp,
    pricing_candidates: pricing.length, pricing_imported: priImp,
    motivated_sellers_created: motivCreated,
    urgent_opportunities_created: urgent.length,
    radar_signals_added: radarAdded,
    rejected_demo: 0, rejected_invalid: 0,
    warnings, next_actions: next,
    samples: {
      legal: legalCands.slice(0, 3),
      velocity: velocity.slice(0, 3),
      pricing: pricing.slice(0, 3),
      urgent: urgent.slice(0, 3),
    },
  };
}

function baseReport(startedAt: string, t0: number, fc: boolean, warnings: string[], errors: string[]): AdvancedJobReport {
  return {
    ok: false, started_at: startedAt, ended_at: new Date().toISOString(),
    duration_ms: Date.now() - t0, firecrawl_available: fc,
    firecrawl_pages_seen: 0, firecrawl_documents_saved: 0,
    legal_candidates: 0, legal_imported: 0,
    velocity_candidates: 0, velocity_imported: 0,
    pricing_candidates: 0, pricing_imported: 0,
    motivated_sellers_created: 0, urgent_opportunities_created: 0,
    radar_signals_added: 0, rejected_demo: 0, rejected_invalid: 0,
    warnings: [...warnings, ...errors], next_actions: [],
    samples: { legal: [], velocity: [], pricing: [], urgent: [] },
  };
}
