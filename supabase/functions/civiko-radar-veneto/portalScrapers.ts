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

export interface NormalizedListing {
  source: "immobiliare.it" | "idealista.it" | "casa.it";
  listing_id: string;             // id univoco lato sorgente
  url: string;
  title: string;
  address: string | null;
  price_eur: number | null;
  surface_sqm: number | null;
  rooms: number | null;
  property_type: PropertyType;
  agency_name: string | null;
  lat: number | null;
  lng: number | null;
}

const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/scrape";
const SCRAPE_TIMEOUT_MS = 55_000;
const MAX_LISTINGS_PER_PORTAL = 25;

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
    buildUrl: (slug) => `https://www.idealista.it/vendita-case/${slug}-comune/`,
    prompt: "Estrai la lista degli annunci di vendita immobiliare presenti nella pagina. Per ciascuno: titolo, indirizzo, prezzo numerico in euro, superficie in metri quadri, numero locali, tipologia, nome agenzia, latitudine e longitudine, link assoluto. Solo dati realmente presenti.",
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
): Promise<NormalizedListing[]> {
  const slug = municipalitySlug(municipality);
  if (!slug) {
    console.log(`[DEBUG portalScrapers] ${config.source}: empty slug for "${municipality}"`);
    return [];
  }
  const url = config.buildUrl(slug);
  console.log(`[DEBUG portalScrapers] ${config.source} URL:`, url);

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
        // header rotation per ridurre profiling
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
      out.push({
        source: config.source,
        listing_id: id,
        url: link.slice(0, 400),
        title: typeof r.title === "string" ? r.title.slice(0, 200) : "Annuncio",
        address: typeof r.address === "string" ? r.address.slice(0, 200) : null,
        price_eur: parsePriceEur(r.price),
        surface_sqm: parseInt0(r.surface_sqm),
        rooms: parseInt0(r.rooms),
        property_type: normalizePropertyType(typeof r.property_type === "string" ? r.property_type : null),
        agency_name: typeof r.agency === "string" ? r.agency.slice(0, 150) : null,
        lat,
        lng,
      });
      if (out.length >= MAX_LISTINGS_PER_PORTAL) break;
    }
    return out;
  } catch (e) {
    console.error(`[portalScrapers] ${config.source} error:`, e instanceof Error ? e.message : String(e));
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function scrapeWithApify(comune: string, provincia: string): Promise<NormalizedListing[]> {
  const APIFY_TOKEN = Deno.env.get("APIFY_API_TOKEN") ?? Deno.env.get("APIFY_TOKEN");
  if (!APIFY_TOKEN) {
    console.log("[scrapeWithApify] no APIFY_API_TOKEN configured");
    return [];
  }
  const actorId = "misceres~immobiliare-it-scraper";
  const runUrl = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=60&memory=256`;
  const slug = municipalitySlug(comune);
  const startUrl = `https://www.immobiliare.it/vendita-case/${slug || comune.toLowerCase()}/`;
  const body = {
    startUrls: [startUrl],
    maxItems: 50,
    proxyConfiguration: { useApifyProxy: true },
  };
  console.log("[scrapeWithApify] calling Apify actor:", actorId, "startUrl:", startUrl);
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
      return [];
    }
    const items = await res.json();
    if (!Array.isArray(items)) {
      console.warn("[scrapeWithApify] response is not an array");
      return [];
    }
    console.log(`[scrapeWithApify] received ${items.length} raw items for ${comune} (${provincia})`);
    const out: NormalizedListing[] = [];
    for (const item of items.slice(0, 50)) {
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
    return out;
  } catch (e) {
    console.error("[scrapeWithApify] error:", e instanceof Error ? e.message : String(e));
    return [];
  }
}

export async function scrapeAllPortals(
  municipality: string,
  firecrawlKey: string,
  provincia: string = "",
): Promise<NormalizedListing[]> {
  if (!municipality) return [];
  const results = await Promise.allSettled(
    PORTAL_CONFIGS.map((c) => scrapePortal(c, municipality, firecrawlKey)),
  );
  const listings: NormalizedListing[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") listings.push(...r.value);
  }
  // Apify fallback disabilitato: actor "misceres~immobiliare-it-scraper" non più disponibile (404).
  // Lascio solo il fallback Firecrawl per evitare timeout su padova-daily-radar.
  // if (listings.length === 0) {
  //   console.log("[portalScrapers] Firecrawl fallito, tentativo Apify per", municipality);
  //   const apifyListings = await scrapeWithApify(municipality, provincia);
  //   listings.push(...apifyListings);
  // }
  void scrapeWithApify;
  return listings;
}
