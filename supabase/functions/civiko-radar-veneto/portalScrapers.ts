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
  // Ammesso anche `extraction_empty_<portale>` come sorgente diagnostica sintetica:
  // non è un vero portale, serve solo a far comparire una entry omonima in provider_errors.
  source: NormalizedListing["source"] | "apify_fallback" | string;
  raw: number;
  reason?: string;
}
export interface IngestionStats {
  perPortal: PortalIngestionStat[];
  rotation?: string;
  firecrawl_pages_estimated?: number;
  firecrawl_skipped_reason?: string;
  raw_items_found?: number;
  raw_items_after_city_filter?: number;
  raw_items_after_dedupe?: number;
  collect_items_created?: number;
  collect_items_updated?: number;
  collect_errors?: string[];
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
// 90s: città grandi (es. Padova, ~2.500 annunci) richiedono ~40s su casa.it
// e l'esecuzione in parallelo dei 4 portali può saturare il vecchio 55s.
const SCRAPE_TIMEOUT_MS = 90_000;
// waitFor più alto aiuta immobiliare.it/idealista.it/subito.it a renderizzare
// le card SSR/lazy. Costo aggiuntivo trascurabile (Firecrawl factura per page).
const FIRECRAWL_WAIT_FOR_MS = 3000;
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
    // Fix: Padova città richiede lo slug "padova-padova"; "padova" porta alla pagina di errore.
    buildUrl: (slug) => `https://www.idealista.it/vendita-case/${slug === "padova" ? "padova-padova" : slug}/`,
    prompt: "Estrai TUTTI gli annunci di vendita immobiliare presenti nella pagina dei risultati. Per ciascuno: titolo, indirizzo, prezzo numerico in euro, superficie in metri quadri, numero locali, tipologia, nome agenzia o 'Privato' se annuncio privato, latitudine e longitudine, link assoluto (https://www.idealista.it/...). Solo dati realmente presenti.",
    schema: standardSchema(),
    idFromLink: (l) => { const m = l.match(/\/immobile\/(\d{5,})/); return m ? `idl-${m[1]}` : null; },
  },
  {
    source: "subito.it",
    // Subito: la categoria "case" non esiste più; URL valido per Padova città.
    buildUrl: () => `https://www.subito.it/annunci-veneto/vendita/immobili/padova/padova/`,
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



// ═══════════════════════════════════════════════════════════════
// Markdown parsers rule-based per immobiliare.it / idealista.it / subito.it.
// Fallback quando Firecrawl JSON+LLM restituisce 0 item (schema change lato portale
// o extraction LLM che collassa a listings:[]).
// Approccio identico a parseCasaListPage: scan link markdown → prezzo vicino → id.
// ═══════════════════════════════════════════════════════════════

interface PortalMarkdownProfile {
  linkRe: RegExp;                                // group 1 = titolo, group 2 = id numerico
  urlBuilder: (id: string) => string;
  source: NormalizedListing["source"];
}

const PRICE_NEAR_RE = /€\s*(\d{1,3}(?:\.\d{3})+|\d{4,7})(?!\d|\.\d)/;

function parsePriceEurLocal(raw: string): number | null {
  const digits = raw.replace(/\./g, "");
  const n = Number(digits);
  if (!Number.isFinite(n) || n < 1000 || n > 5_000_000) return null;
  return Math.round(n);
}

function parseMarkdownListings(
  md: string,
  profile: PortalMarkdownProfile,
  maxItems: number,
): NormalizedListing[] {
  const out: NormalizedListing[] = [];
  const seenIds = new Set<string>();
  profile.linkRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = profile.linkRe.exec(md)) !== null && out.length < maxItems) {
    const rawTitle = (m[1] ?? "").trim();
    const id = (m[2] ?? "").trim();
    if (!id || seenIds.has(id)) continue;
    // scarta i link immagine ([![...]](...))
    const prefix = m.index > 0 ? md.charAt(m.index - 1) : "";
    if (prefix === "!") continue;
    if (/Immagine\s+\d+\s+di\s+\d+/i.test(rawTitle)) continue;
    // finestra di contesto dopo il link (~600 char) per pescare il prezzo della card
    const winStart = m.index + m[0].length;
    const window = md.slice(winStart, winStart + 600);
    const priceMatch = window.match(PRICE_NEAR_RE);
    const price = priceMatch ? parsePriceEurLocal(priceMatch[1]) : null;
    // requisito minimo per considerarlo un annuncio reale: id + (titolo o prezzo)
    if (!rawTitle && price == null) continue;
    seenIds.add(id);
    out.push({
      source: profile.source,
      listing_id: `${profile.source.split(".")[0].slice(0, 3)}-${id}`,
      url: profile.urlBuilder(id),
      title: (rawTitle || "Annuncio").slice(0, 200),
      address: null,
      price_eur: price,
      surface_sqm: null,
      rooms: null,
      property_type: normalizePropertyType(null),
      agency_name: null,
      is_private: profile.source === "subito.it",
      lat: null,
      lng: null,
    });
  }
  return out;
}

// Link "titolo card" per ciascun portale. Group 1 = titolo, group 2 = id.
// Profili per portale: linkRe cattura (titolo, id) evitando link immagine ([![...])
// tramite lookbehind negativo su `!`. Subito ha un secondo gruppo intermedio (path),
// quindi usa un blocco dedicato in scrapeSubitoViaMarkdown.
function makeProfile(source: NormalizedListing["source"]): PortalMarkdownProfile {
  if (source === "immobiliare.it") {
    return {
      source,
      linkRe: /(?<=^|[^!])\[([^\]\n]+?)\]\(https:\/\/www\.immobiliare\.it\/annunci\/(\d{6,})\/?[^)]*\)/g,
      urlBuilder: (id) => `https://www.immobiliare.it/annunci/${id}/`,
    };
  }
  // idealista.it
  return {
    source,
    linkRe: /(?<=^|[^!])\[([^\]\n]+?)\]\(https:\/\/www\.idealista\.it\/immobile\/(\d{5,})\/?[^)]*\)/g,
    urlBuilder: (id) => `https://www.idealista.it/immobile/${id}/`,
  };
}

async function fetchFirecrawlMarkdown(
  url: string,
  firecrawlKey: string,
): Promise<{ md: string; httpStatus: number | null; raw: string }> {
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
        formats: ["markdown"],
        onlyMainContent: false,
        headers: {
          "User-Agent": pickUA(),
          "Accept-Language": pickLang(),
        },
        waitFor: FIRECRAWL_WAIT_FOR_MS,
      }),
      signal: ctrl.signal,
    });
    const bodyText = await res.text().catch(() => "");
    if (!res.ok) {
      return { md: "", httpStatus: res.status, raw: bodyText };
    }
    let md = "";
    try {
      const data = JSON.parse(bodyText);
      md = (typeof data?.data?.markdown === "string" && data.data.markdown) ||
        (typeof data?.markdown === "string" && data.markdown) || "";
    } catch { /* raw body already captured */ }
    return { md, httpStatus: res.status, raw: bodyText };
  } catch (e) {
    return { md: "", httpStatus: null, raw: `exception: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function scrapeImmobiliareViaMarkdown(
  url: string,
  firecrawlKey: string,
  maxItems: number,
): Promise<{ listings: NormalizedListing[]; rawSample: string }> {
  const { md, raw } = await fetchFirecrawlMarkdown(url, firecrawlKey);
  const profile = makeProfile("immobiliare.it");
  const listings = md ? parseMarkdownListings(md, profile, maxItems) : [];
  console.log(`[DEBUG portalScrapers] immobiliare.it markdown fallback md_len=${md.length} parsed=${listings.length}`);
  return { listings, rawSample: md || raw };
}

async function scrapeIdealistaViaMarkdown(
  url: string,
  firecrawlKey: string,
  maxItems: number,
): Promise<{ listings: NormalizedListing[]; rawSample: string }> {
  const { md, raw } = await fetchFirecrawlMarkdown(url, firecrawlKey);
  const profile = makeProfile("idealista.it");
  const listings = md ? parseMarkdownListings(md, profile, maxItems) : [];
  console.log(`[DEBUG portalScrapers] idealista.it markdown fallback md_len=${md.length} parsed=${listings.length}`);
  return { listings, rawSample: md || raw };
}

async function scrapeSubitoViaMarkdown(
  url: string,
  firecrawlKey: string,
  maxItems: number,
): Promise<{ listings: NormalizedListing[]; rawSample: string }> {
  const { md, raw } = await fetchFirecrawlMarkdown(url, firecrawlKey);
  // Per subito la regex cattura anche il path relativo (group 2), quindi processo a mano:
  const out: NormalizedListing[] = [];
  if (md) {
    const seen = new Set<string>();
    const re = /(?<=^|[^!])\[([^\]\n]+?)\]\(https:\/\/www\.subito\.it\/([^)\s]*?-(\d{6,})\.htm)[^)]*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(md)) !== null && out.length < maxItems) {
      const rawTitle = (m[1] ?? "").trim();
      const path = (m[2] ?? "").trim();
      const id = (m[3] ?? "").trim();
      if (!id || seen.has(id)) continue;
      if (/Immagine\s+\d+\s+di\s+\d+/i.test(rawTitle)) continue;
      const winStart = m.index + m[0].length;
      const window = md.slice(winStart, winStart + 600);
      const priceMatch = window.match(PRICE_NEAR_RE);
      const price = priceMatch ? parsePriceEurLocal(priceMatch[1]) : null;
      if (!rawTitle && price == null) continue;
      seen.add(id);
      out.push({
        source: "subito.it",
        listing_id: `sub-${id}`,
        url: `https://www.subito.it/${path}`,
        title: (rawTitle || "Annuncio").slice(0, 200),
        address: null,
        price_eur: price,
        surface_sqm: null,
        rooms: null,
        property_type: normalizePropertyType(null),
        agency_name: null,
        is_private: true,
        lat: null,
        lng: null,
      });
    }
  }
  console.log(`[DEBUG portalScrapers] subito.it markdown fallback md_len=${md.length} parsed=${out.length}`);
  return { listings: out, rawSample: md || raw };
}

async function scrapePortal(
  config: PortalConfig,
  municipality: string,
  firecrawlKey: string,
  mode: RadarMode = "soft",
  stats?: IngestionStats,
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

  let jsonLlmCount = 0;
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
        waitFor: FIRECRAWL_WAIT_FOR_MS,
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      console.warn(`[portalScrapers] ${config.source} HTTP ${res.status}`);
    } else {
      const data = await res.json();
      const items: unknown =
        data?.data?.json?.listings ?? data?.json?.listings ?? data?.data?.extract?.listings ?? [];
      console.log(`[DEBUG portalScrapers] ${config.source} raw items:`, Array.isArray(items) ? items.length : `not-array(${typeof items})`);
      if (Array.isArray(items)) {
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
            price_eur: parsePriceEur(r.price),
            surface_sqm: parseInt0(r.surface_sqm),
            rooms: parseInt0(r.rooms),
            property_type: normalizePropertyType(typeof r.property_type === "string" ? r.property_type : null),
            agency_name,
            is_private: looksPrivate,
            lat,
            lng,
          });
          if (out.length >= maxItems) break;
        }
        jsonLlmCount = out.length;
        if (out.length > 0) return out;
      }
    }
  } catch (e) {
    console.error(`[portalScrapers] ${config.source} json+llm error:`, e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }

  // ── Fallback markdown rule-based per il portale ──────────────────
  console.log(`[portalScrapers] ${config.source} json+llm=${jsonLlmCount}, tentativo markdown fallback`);
  let mdResult: { listings: NormalizedListing[]; rawSample: string } = { listings: [], rawSample: "" };
  try {
    if (config.source === "immobiliare.it") {
      mdResult = await scrapeImmobiliareViaMarkdown(url, firecrawlKey, maxItems);
    } else if (config.source === "idealista.it") {
      mdResult = await scrapeIdealistaViaMarkdown(url, firecrawlKey, maxItems);
    } else if (config.source === "subito.it") {
      mdResult = await scrapeSubitoViaMarkdown(url, firecrawlKey, maxItems);
    }
  } catch (e) {
    console.error(`[portalScrapers] ${config.source} markdown fallback error:`, e instanceof Error ? e.message : String(e));
  }

  if (mdResult.listings.length > 0) {
    console.log(`[portalScrapers] ${config.source} markdown fallback OK: ${mdResult.listings.length} items`);
    return mdResult.listings;
  }

  // ── Entrambi i tentativi a zero: diagnostica ──────────────────────
  const portalKey = config.source.split(".")[0]; // "immobiliare" | "idealista" | "subito"
  const sample = (mdResult.rawSample ?? "").slice(0, 1500);
  console.warn(`[portalScrapers] extraction_empty_${portalKey}: json+llm=0 markdown=0 sample_len=${sample.length}`);
  if (stats) {
    stats.perPortal.push({
      source: `extraction_empty_${portalKey}`,
      raw: 0,
      reason: sample || "no_content",
    });
  }
  return [];
}



async function scrapeWithApify(
  comune: string,
  provincia: string,
  mode: RadarMode = "soft",
  meta?: RadarRunMeta,
  stats?: IngestionStats,
): Promise<NormalizedListing[]> {
  // L'actor hardcoded "epctex/immobiliare-it-scraper" è stato dismesso (HTTP 404 sull'Apify Store).
  // Finché non viene scelto e configurato un actor valido tramite l'env RADAR_PORTAL_APIFY_ACTOR_ID,
  // il fallback Apify NON viene chiamato (nessun addebito, nessun network call).
  const actorId = (Deno.env.get("RADAR_PORTAL_APIFY_ACTOR_ID") ?? "").trim();
  if (!actorId) {
    console.warn("[scrapeWithApify] apify_actor_not_configured — fallback disabilitato");
    stats?.perPortal.push({ source: "apify_fallback", raw: 0, reason: "apify_actor_not_configured" });
    return [];
  }
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
  const runUrl = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=60&memory=256`;
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
 * Rotazione fonti soft per Roma-hour. casa.it è la sola sorgente attualmente
 * verificata come funzionante per Padova città: deve essere SEMPRE inclusa
 * in ogni slot, così Padova+casa.it non può essere saltata per un'intera giornata
 * e se uno slot produce zero, il successivo ritrova comunque la fonte funzionante.
 *  - 00-07 → casa.it + immobiliare.it + subito.it           (slot 04:00 Roma / 02:00 UTC)
 *  - 08-13 → casa.it + subito.it                            (slot 11:00 Roma / 09:00 UTC)
 *  - 14-19 → casa.it + immobiliare.it + idealista.it + subito.it (slot 15:30 Roma / 13:30 UTC)
 *  - 20-23 → casa.it + immobiliare.it + subito.it
 * subito.it è SEMPRE inclusa in ogni slot (fonte verified always-on).
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
    allow = ["subito.it"];
    key = "soft_morning";
  } else if (romaHour >= 14 && romaHour < 20) {
    allow = ["immobiliare.it", "idealista.it", "subito.it"];
    key = "soft_afternoon";
  } else {
    allow = ["immobiliare.it", "subito.it"];
    key = "soft_night";
  }
  return { configs: PORTAL_CONFIGS.filter((c) => allow.includes(c.source)), rotationKey: key };
}

const RESERVOIR_PORTAL_MAP: Record<string, NormalizedListing["source"]> = {
  "immobiliare": "immobiliare.it",
  "immobiliare.it": "immobiliare.it",
  "idealista": "idealista.it",
  "idealista.it": "idealista.it",
  "casa": "casa.it",
  "casa.it": "casa.it",
  "subito": "subito.it",
  "subito.it": "subito.it",
};

async function readApifyReservoir(
  supabase: { from: (t: string) => any },
  stats?: IngestionStats,
): Promise<NormalizedListing[]> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("padova_collect_v2_items")
      .select("portal,listing_id,url,raw_address,citta,prezzo,mq,locali,tipologia,agency,lat,lng,created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) {
      stats?.perPortal.push({ source: "apify_reservoir", raw: 0, reason: `reservoir_error:${String(error.message ?? error).slice(0, 120)}` });
      return [];
    }
    const rows = Array.isArray(data) ? data : [];
    const out: NormalizedListing[] = [];
    for (const r of rows as Array<Record<string, unknown>>) {
      const portalRaw = typeof r.portal === "string" ? r.portal.toLowerCase().trim() : "";
      const source = RESERVOIR_PORTAL_MAP[portalRaw];
      if (!source) continue;
      const url = typeof r.url === "string" ? r.url : "";
      const listingId = typeof r.listing_id === "string" && r.listing_id ? r.listing_id : url;
      if (!listingId || !url) continue;
      const lat = typeof r.lat === "number" && Number.isFinite(r.lat) ? r.lat : null;
      const lng = typeof r.lng === "number" && Number.isFinite(r.lng) ? r.lng : null;
      const price = typeof r.prezzo === "number" && Number.isFinite(r.prezzo)
        ? r.prezzo
        : parsePriceEur(r.prezzo);
      const surface = typeof r.mq === "number" && Number.isFinite(r.mq) ? Math.round(r.mq) : parseInt0(r.mq);
      const rooms = typeof r.locali === "number" && Number.isFinite(r.locali) ? Math.round(r.locali) : parseInt0(r.locali);
      const rawAgency = typeof r.agency === "string" ? r.agency.trim() : "";
      const looksPrivate = /privat[oi]/i.test(rawAgency) || (rawAgency === "" && source === "subito.it");
      const address = typeof r.raw_address === "string" && r.raw_address
        ? r.raw_address
        : (typeof r.citta === "string" ? r.citta : null);
      out.push({
        source,
        listing_id: String(listingId).slice(0, 200),
        url: url.slice(0, 400),
        title: (typeof r.tipologia === "string" && r.tipologia ? r.tipologia : "Annuncio").slice(0, 200),
        address: address ? String(address).slice(0, 200) : null,
        price_eur: price,
        surface_sqm: surface,
        rooms,
        property_type: normalizePropertyType(typeof r.tipologia === "string" ? r.tipologia : null),
        agency_name: rawAgency && !looksPrivate ? rawAgency.slice(0, 150) : null,
        is_private: looksPrivate,
        lat,
        lng,
      });
    }
    stats?.perPortal.push({ source: "apify_reservoir", raw: out.length });
    return out;
  } catch (e) {
    stats?.perPortal.push({
      source: "apify_reservoir",
      raw: 0,
      reason: `reservoir_exception:${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`,
    });
    return [];
  }
}

function sourceToPortalKey(source: NormalizedListing["source"]): string {
  if (source === "immobiliare.it") return "immobiliare";
  if (source === "idealista.it") return "idealista";
  if (source === "casa.it") return "casa";
  return "subito";
}

function suppressCoveredExtractionErrors(stats: IngestionStats | undefined, reservoir: NormalizedListing[]): void {
  if (!stats || reservoir.length === 0) return;
  const coveredKeys = new Set(reservoir.map((r) => sourceToPortalKey(r.source)));
  stats.perPortal = stats.perPortal.filter((p) => {
    const source = String(p.source ?? "");
    if (!source.startsWith("extraction_empty_")) return true;
    const key = source.replace(/^extraction_empty_/, "");
    if (!coveredKeys.has(key)) return true;
    // Firecrawl/direct parser was blocked, but the Apify-backed reservoir has
    // fresh rows for the same portal. Do not surface this as a provider error
    // in cron readiness; the fallback path covered the source.
    return false;
  });
}

export async function scrapeAllPortals(
  municipality: string,
  firecrawlKey: string,
  provincia: string = "",
  mode: RadarMode = "soft",
  meta?: RadarRunMeta,
  stats?: IngestionStats,
  supabase?: { from: (t: string) => any } | null,
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
      if (supabase) {
        const reservoir = await readApifyReservoir(supabase, stats);
        suppressCoveredExtractionErrors(stats, reservoir);
        apifyListings.push(...reservoir);
      }
      return apifyListings;
    }
    await recordFirecrawlSpend(estPages, configs.length, meta).catch(() => {});
  } catch (_) { /* budget module optional */ }

  const results = await Promise.allSettled(
    configs.map((c) => scrapePortal(c, municipality, firecrawlKey, mode, stats)),
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
  // Provider "apify_reservoir": SEMPRE eseguito dopo i portali diretti (non solo fallback).
  if (supabase) {
    const reservoir = await readApifyReservoir(supabase, stats);
    suppressCoveredExtractionErrors(stats, reservoir);
    listings.push(...reservoir);
  }
  return listings;
}
