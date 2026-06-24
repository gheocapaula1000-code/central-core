// ═══════════════════════════════════════════════════════════════
// Portal Scrapers — Immobiliare.it, Idealista, Casa.it
// ═══════════════════════════════════════════════════════════════
//
// Ogni scraper estrae un set normalizzato di annunci (NormalizedListing).
// Resilienza: se uno fallisce, gli altri continuano.
// Rate-limiting bypass: rotazione User-Agent + accept-language sul lato Firecrawl
// (Firecrawl gestisce la rotazione di IP residenziali quando supportata).
// ═══════════════════════════════════════════════════════════════

import { normalizePropertyType, type PropertyType } from "./listingIdentity.ts";
import { getApifyToken } from "../_shared/apify.ts";
import { canSpendApify, recordApifySpend } from "../_shared/apifyBudget.ts";
import type { RadarRunMeta } from "../_shared/radarBudget.ts";

export interface PortalIngestionStat {
  source: NormalizedListing["source"] | "apify_fallback";
  raw: number;
  reason?: string;
}
export interface IngestionStats {
  perPortal: PortalIngestionStat[];
  rotation?: string;
  firecrawl_pages_estimated?: number;
  firecrawl_skipped_reason?: string;
}

export type RadarMode = "soft" | "full";

export interface NormalizedListing {
  source: "immobiliare.it" | "idealista.it" | "casa.it" | "subito.it";
  listing_id: string;             // id univoco lato sorgente
  url: string;
  title: string;
  address: string | null;
  price_eur: number | null;
  surface_sqm: number | null;
  rooms: number | null;
  property_type: PropertyType;
  agency_name: string | null;
  is_private?: boolean;           // true se annuncio da privato (Subito tipico)
  lat: number | null;
  lng: number | null;
}

const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/scrape";
const SCRAPE_TIMEOUT_MS = 55_000;
const MAX_LISTINGS_PER_PORTAL_SOFT = 25;
const MAX_LISTINGS_PER_PORTAL_FULL = 60;

// Pool di User-Agent per rotazione (Firecrawl li forwarda)
const UA_POOL = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Safari/537.36",
];

const ACCEPT_LANG_POOL = ["it-IT,it;q=0.9,en;q=0.7", "it-IT,it;q=0.8,en-US;q=0.5"];

function pickUA(): string { return UA_POOL[Math.floor(Math.random() * UA_POOL.length)]; }
function pickLang(): string { return ACCEPT_LANG_POOL[Math.floor(Math.random() * ACCEPT_LANG_POOL.length)]; }

function parsePriceEur(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw).replace(/[^0-9,.\s]/g, "").trim();
  if (!s) return null;
  const normalized = s.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) && n > 1000 && n < 100_000_000 ? n : null;
}

function parseInt0(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw);
  if (typeof raw !== "string") return null;
  const m = raw.match(/(\d{1,5})/);
  return m ? Number(m[1]) : null;
}

function municipalitySlug(municipality: string): string {
  return municipality.toLowerCase().trim()
    .replace(/à/g, "a").replace(/è|é/g, "e").replace(/ì/g, "i").replace(/ò/g, "o").replace(/ù/g, "u")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

interface PortalConfig {
  source: NormalizedListing["source"];
  buildUrl: (slug: string) => string;
  prompt: string;
  schema: Record<string, unknown>;
  idFromLink: (link: string) => string | null;
}

const PORTAL_CONFIGS: PortalConfig[] = [
  {
    source: "immobiliare.it",
    buildUrl: (slug) => `https://www.immobiliare.it/vendita-case/${slug}/?ordinamento=dataModifica`,
    prompt: "Estrai la lista degli annunci immobiliari di vendita presenti nella pagina. Per ciascuno: titolo, indirizzo, prezzo numerico in euro, superficie in metri quadri, numero locali, tipologia (appartamento/villa/...), nome agenzia (se visibile), latitudine e longitudine se disponibili nel JSON-LD, link assoluto. Solo dati realmente presenti.",
    schema: standardSchema(),
    idFromLink: (l) => { const m = l.match(/\/(\d{6,})(?:[/?]|$)/); return m ? `imm-${m[1]}` : null; },
  },
  {
    source: "idealista.it",
    // Fix: l'URL `vendita-case/${slug}-comune/` restituiva 404 → uso pattern semplice.
    buildUrl: (slug) => `https://www.idealista.it/vendita-case/${slug}/`,
    prompt: "Estrai TUTTI gli annunci di vendita immobiliare presenti nella pagina dei risultati. Per ciascuno: titolo, indirizzo, prezzo numerico in euro, superficie in metri quadri, numero locali, tipologia, nome agenzia o 'Privato' se annuncio privato, latitudine e longitudine, link assoluto (https://www.idealista.it/...). Solo dati realmente presenti.",
    schema: standardSchema(),
    idFromLink: (l) => { const m = l.match(/\/immobile\/(\d{5,})/); return m ? `idl-${m[1]}` : null; },
  },
  {
    source: "casa.it",
    buildUrl: (slug) => `https://www.casa.it/vendita/residenziale/${slug}`,
    prompt: "Estrai la lista degli annunci di vendita immobiliare. Per ciascuno: titolo, indirizzo, prezzo numerico in euro, superficie in metri quadri, numero locali, tipologia, nome agenzia, latitudine, longitudine, link assoluto. Solo dati realmente presenti.",
    schema: standardSchema(),
    idFromLink: (l) => { const m = l.match(/\/(\d{6,})(?:[/?]|$)/); return m ? `casa-${m[1]}` : null; },
  },
  {
    source: "subito.it",
    // Subito: vendita case privati + agenzie, scope Padova.
    buildUrl: (slug) => `https://www.subito.it/annunci-veneto/vendita/case/${slug}/`,
    prompt: "Estrai TUTTI gli annunci di vendita case e appartamenti presenti nella pagina. Per ciascuno indica esplicitamente se è da 'Privato' o 'Agenzia' nel campo agency. Estrai: titolo, indirizzo o zona, prezzo numerico in euro, superficie in metri quadri, numero locali, tipologia, agency (nome agenzia oppure 'Privato'), latitudine, longitudine, link assoluto subito.it. Solo dati realmente presenti.",
    schema: standardSchema(),
    idFromLink: (l) => { const m = l.match(/-(\d{6,})\.htm/); return m ? `sub-${m[1]}` : null; },
  },
];

function standardSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      listings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            address: { type: "string" },
            price: { type: "string" },
            surface_sqm: { type: "string" },
            rooms: { type: "string" },
            property_type: { type: "string" },
            agency: { type: "string" },
            lat: { type: "number" },
            lng: { type: "number" },
            link: { type: "string" },
          },
          required: ["title", "price", "link"],
        },
      },
    },
  };
}

async function scrapePortal(
  config: PortalConfig,
  municipality: string,
  firecrawlKey: string,
  mode: RadarMode = "soft",
): Promise<NormalizedListing[]> {
  const maxItems = mode === "full" ? MAX_LISTINGS_PER_PORTAL_FULL : MAX_LISTINGS_PER_PORTAL_SOFT;
  const slug = municipalitySlug(municipality);
  if (!slug) {
    console.log(`[DEBUG portalScrapers] ${config.source}: empty slug for "${municipality}"`);
    return [];
  }
  const url = config.buildUrl(slug);
  console.log(`[DEBUG portalScrapers] ${config.source} URL:`, url, `mode=${mode} cap=${maxItems}`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SCRAPE_TIMEOUT_MS);

  try {
    const res = await fetch(FIRECRAWL_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${firecrawlKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: [{ type: "json", prompt: config.prompt, schema: config.schema }],
        onlyMainContent: true,
        headers: {
          "User-Agent": pickUA(),
          "Accept-Language": pickLang(),
        },
        waitFor: 1500,
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      console.warn(`[portalScrapers] ${config.source} HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    const items: unknown =
      data?.data?.json?.listings ?? data?.json?.listings ?? data?.data?.extract?.listings ?? [];
    console.log(`[DEBUG portalScrapers] ${config.source} raw items:`, Array.isArray(items) ? items.length : `not-array(${typeof items})`);
    if (!Array.isArray(items)) return [];

    const out: NormalizedListing[] = [];
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const r = it as Record<string, unknown>;
      const link = typeof r.link === "string" ? r.link : null;
      if (!link || !link.startsWith("http")) continue;
      const id = config.idFromLink(link);
      if (!id) continue;
      const lat = typeof r.lat === "number" && Number.isFinite(r.lat) ? r.lat : null;
      const lng = typeof r.lng === "number" && Number.isFinite(r.lng) ? r.lng : null;
      const rawAgency = typeof r.agency === "string" ? r.agency.trim() : "";
      const looksPrivate = /privat[oi]/i.test(rawAgency) || rawAgency === "" && config.source === "subito.it";
      const agency_name = rawAgency && !looksPrivate ? rawAgency.slice(0, 150) : null;
      out.push({
        source: config.source,
        listing_id: id,
        url: link.slice(0, 400),
        title: typeof r.title === "string" ? r.title.slice(0, 200) : "Annuncio",
        address: typeof r.address === "string" ? r.address.slice(0, 200) : null,
async function scrapeWithApify(
  comune: string,
  provincia: string,
  mode: RadarMode = "soft",
  meta?: RadarRunMeta,
  stats?: IngestionStats,
): Promise<NormalizedListing[]> {
  const APIFY_TOKEN = getApifyToken();
  if (!APIFY_TOKEN) {
    console.log("[scrapeWithApify] no APIFY_API_TOKEN configured");
    stats?.perPortal.push({ source: "apify_fallback", raw: 0, reason: "no_apify_token" });
    return [];
  }
  const maxItems = mode === "full" ? 200 : 50;
  const estCost = mode === "full" ? 1.5 : 0.5;
  const budget = await canSpendApify(estCost);
  if (!budget.ok) {
    console.warn(`[scrapeWithApify] apify_cap_reached spent=$${budget.spent.toFixed(2)} cap=$${budget.cap} skip mode=${mode}`);
    stats?.perPortal.push({ source: "apify_fallback", raw: 0, reason: budget.reason ?? "apify_cap_reached" });
    return [];
  }
  const actorId = "epctex/immobiliare-it-scraper";
  const runUrl = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=60&memory=256`;
  const slug = municipalitySlug(comune);
  const startUrl = `https://www.immobiliare.it/vendita-case/${slug || comune.toLowerCase()}/`;
  const body = {
    startUrls: [startUrl],
    maxItems,
    proxyConfiguration: { useApifyProxy: true },
  };
  console.log(`[scrapeWithApify] mode=${mode} maxItems=${maxItems} actor=${actorId} startUrl=${startUrl}`);
  try {
    const res = await fetch(runUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`[scrapeWithApify] HTTP ${res.status} body: ${txt.slice(0, 200)}`);
      await recordApifySpend(estCost * 0.2, 1, meta);
      stats?.perPortal.push({ source: "apify_fallback", raw: 0, reason: `apify_http_${res.status}` });
      return [];
    }
    const items = await res.json();
    await recordApifySpend(estCost, 1, meta);
    if (!Array.isArray(items)) {
      console.warn("[scrapeWithApify] response is not an array");
      stats?.perPortal.push({ source: "apify_fallback", raw: 0, reason: "apify_bad_response" });
      return [];
    }
    console.log(`[scrapeWithApify] received ${items.length} raw items for ${comune} (${provincia}) mode=${mode}`);
    const out: NormalizedListing[] = [];
    for (const item of items.slice(0, maxItems)) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const url = typeof r.url === "string" ? r.url : null;
      const id = typeof r.id === "string" || typeof r.id === "number" ? String(r.id) : url;
      if (!url || !id) continue;
      out.push({
        source: "immobiliare.it",
        listing_id: id.slice(0, 200),
        url: url.slice(0, 400),
        title: typeof r.title === "string"
          ? r.title.slice(0, 200)
          : (typeof r.description === "string" ? r.description.slice(0, 200) : "Annuncio"),
        address: typeof r.address === "string" ? r.address.slice(0, 200) : null,
        price_eur: parsePriceEur(r.price),
        surface_sqm: parseInt0(r.surface ?? r.squareMeters),
        rooms: parseInt0(r.rooms),
        property_type: normalizePropertyType(typeof r.propertyType === "string" ? r.propertyType : "residenziale"),
        agency_name: typeof r.agency === "string" ? r.agency.slice(0, 150) : null,
        lat: typeof r.lat === "number" ? r.lat : (typeof r.latitude === "number" ? r.latitude : null),
        lng: typeof r.lng === "number" ? r.lng : (typeof r.longitude === "number" ? r.longitude : null),
      });
    }
    stats?.perPortal.push({ source: "apify_fallback", raw: out.length });
    return out;
  } catch (e) {
    console.error("[scrapeWithApify] error:", e instanceof Error ? e.message : String(e));
    stats?.perPortal.push({ source: "apify_fallback", raw: 0, reason: "apify_exception" });
    return [];
  }
}

/**
 * Rotazione fonti soft per Roma-hour:
 *  - 00-07 → casa.it + immobiliare.it
 *  - 08-13 → subito.it + casa.it
 *  - 14-19 → immobiliare.it + idealista.it + subito.it
 *  - 20-23 → casa.it + immobiliare.it
 * In full mode usa tutti i portali.
 */
function selectPortalsForMode(mode: RadarMode): { configs: PortalConfig[]; rotationKey: string } {
  if (mode === "full") return { configs: PORTAL_CONFIGS, rotationKey: "full_all" };
  const romaHour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/Rome" })
      .format(new Date()),
  );
  let allow: Array<NormalizedListing["source"]>;
  let key: string;
  if (romaHour >= 8 && romaHour < 14) {
    allow = ["subito.it", "casa.it"];
    key = "soft_morning";
  } else if (romaHour >= 14 && romaHour < 20) {
    allow = ["immobiliare.it", "idealista.it", "subito.it"];
    key = "soft_afternoon";
  } else {
    allow = ["casa.it", "immobiliare.it"];
    key = "soft_night";
  }
  return { configs: PORTAL_CONFIGS.filter((c) => allow.includes(c.source)), rotationKey: key };
}

export async function scrapeAllPortals(
  municipality: string,
  firecrawlKey: string,
  provincia: string = "",
  mode: RadarMode = "soft",
  meta?: RadarRunMeta,
  stats?: IngestionStats,
): Promise<NormalizedListing[]> {
  if (!municipality) return [];
  const { configs, rotationKey } = selectPortalsForMode(mode);
  if (stats) stats.rotation = rotationKey;
  // Budget guard Firecrawl: stima pagine = numero portali selezionati * (1 soft / 2 full)
  try {
    const { canSpendFirecrawl, recordFirecrawlSpend } = await import("../_shared/firecrawlBudget.ts");
    const estPages = configs.length * (mode === "full" ? 2 : 1);
    if (stats) stats.firecrawl_pages_estimated = estPages;
    const fb = await canSpendFirecrawl(estPages);
    if (!fb.ok) {
      console.warn(`[portalScrapers] firecrawl_cap_reached spent=${fb.spent} cap=${fb.cap} skip mode=${mode}`);
      if (stats) stats.firecrawl_skipped_reason = fb.reason ?? "firecrawl_cap_reached";
      const apifyListings = await scrapeWithApify(municipality, provincia, mode, meta, stats);
      return apifyListings;
    }
    await recordFirecrawlSpend(estPages, configs.length, meta).catch(() => {});
  } catch (_) { /* budget module optional */ }

  const results = await Promise.allSettled(
    configs.map((c) => scrapePortal(c, municipality, firecrawlKey, mode)),
  );
  const listings: NormalizedListing[] = [];
  results.forEach((r, idx) => {
    const src = configs[idx].source;
    if (r.status === "fulfilled") {
      listings.push(...r.value);
      stats?.perPortal.push({ source: src, raw: r.value.length });
    } else {
      stats?.perPortal.push({ source: src, raw: 0, reason: "scrape_rejected" });
    }
  });
  // Fallback Apify (epctex) — only if Firecrawl returned nothing.
  if (listings.length === 0) {
    console.log(`[portalScrapers] Firecrawl 0 results, Apify fallback for ${municipality} mode=${mode}`);
    const apifyListings = await scrapeWithApify(municipality, provincia, mode, meta, stats);
    listings.push(...apifyListings);
  }
  return listings;
}
