// ═══════════════════════════════════════════════════════════════
// auctionSourceRegistry — Veneto auction/legal sources
// Compliance-safe: no CAPTCHA bypass, no login, no aggressive scraping.
// Discovery only — fonti pubbliche elencate qui sono il punto di partenza
// per dry run. Le effettive verifiche vengono fatte runtime.
// ═══════════════════════════════════════════════════════════════

export type AuctionSourceType =
  | "pvp"
  | "ivg"
  | "tribunal"
  | "delegated_auction_portal"
  | "public_asset_disposal"
  | "municipal_alienation"
  | "demanio"
  | "ater"
  | "other";

export type CrawlMethod =
  | "firecrawl"
  | "apify"
  | "direct_fetch"
  | "pdf_fetch"
  | "manual_only";

export type ComplianceStatus =
  | "allowed_public"
  | "needs_review"
  | "manual_only"
  | "blocked";

export type ExtractionStrategy =
  | "html_cards"
  | "pdf_links"
  | "table_rows"
  | "search_results"
  | "metadata_only";

export type ProvCode = "PD" | "VE" | "VR" | "VI" | "TV" | "BL" | "RO";

export interface ProvincialSeed {
  province: ProvCode;
  paths: string[];
}

export interface AuctionSource {
  source_key: string;
  source_name: string;
  base_url: string;
  source_type: AuctionSourceType;
  province_scope: ProvCode[] | "ALL_VENETO";
  allowed_paths: string[];
  /** Optional verified provincial seed URLs (HTTP 200 confirmed). */
  provincial_seeds?: ProvincialSeed[];
  excluded_paths: string[];
  allowed_content_types: string[];
  crawl_method: CrawlMethod;
  max_depth: number;
  max_pages: number;
  rate_limit_ms: number;
  priority: 1 | 2 | 3 | 4 | 5;
  enabled: boolean;
  compliance_status: ComplianceStatus;
  extraction_strategy: ExtractionStrategy;
  keywords: string[];
  notes?: string;
}

export const AUCTION_KEYWORDS = [
  "asta",
  "vendita giudiziaria",
  "vendita immobiliare",
  "avviso vendita",
  "avviso di vendita",
  "delegato vendita",
  "delegato alla vendita",
  "procedura esecutiva",
  "esecuzione immobiliare",
  "lotto",
  "prezzo base",
  "offerta minima",
  "vendita telematica",
  "vendita senza incanto",
  "vendita con incanto",
  "alienazione",
  "dismissione patrimonio",
  "bando alienazione",
];

// Registry conservativo. PVP è marcato manual_only perché ha form di ricerca
// dinamica e protezioni che renderebbero lo scraping non compliant.
export const AUCTION_SOURCE_REGISTRY: AuctionSource[] = [
  // ── PVP Ministero Giustizia (manual_only: form-based, no bypass)
  {
    source_key: "pvp_giustizia",
    source_name: "Portale Vendite Pubbliche (Ministero Giustizia)",
    base_url: "https://pvp.giustizia.it",
    source_type: "pvp",
    province_scope: "ALL_VENETO",
    allowed_paths: ["/pvp/it/risultati_ricerca.page"],
    excluded_paths: ["/pvp/it/login"],
    allowed_content_types: ["text/html"],
    crawl_method: "manual_only",
    max_depth: 0,
    max_pages: 0,
    rate_limit_ms: 5000,
    priority: 5,
    enabled: false,
    compliance_status: "manual_only",
    extraction_strategy: "search_results",
    keywords: AUCTION_KEYWORDS,
    notes: "Form-based search + token. Solo import manuale via export ufficiale.",
  },
  // ── Aste Giudiziarie .it (portale pubblico, robots permissive su listings)
  {
    source_key: "astegiudiziarie_it_veneto",
    source_name: "AsteGiudiziarie.it (Veneto)",
    base_url: "https://www.astegiudiziarie.it",
    source_type: "delegated_auction_portal",
    province_scope: "ALL_VENETO",
    allowed_paths: [
      "/immobili",
      "/immobili/provincia-di-padova",
      "/immobili/provincia-di-venezia",
      "/immobili/provincia-di-verona",
      "/immobili/provincia-di-vicenza",
      "/immobili/provincia-di-treviso",
      "/immobili/provincia-di-belluno",
      "/immobili/provincia-di-rovigo",
      "/vetrine-giudiziarie/tribunale-di-padova",
      "/vetrine-giudiziarie/tribunale-di-venezia",
      "/vetrine-giudiziarie/tribunale-di-verona",
      "/vetrine-giudiziarie/tribunale-di-vicenza",
      "/vetrine-giudiziarie/tribunale-di-treviso",
      "/vetrine-giudiziarie/tribunale-di-belluno",
      "/vetrine-giudiziarie/tribunale-di-rovigo",
    ],
    provincial_seeds: [
      { province: "PD", paths: ["/immobili/provincia-di-padova", "/vetrine-giudiziarie/tribunale-di-padova"] },
      { province: "VE", paths: ["/immobili/provincia-di-venezia", "/vetrine-giudiziarie/tribunale-di-venezia"] },
      { province: "VR", paths: ["/immobili/provincia-di-verona", "/vetrine-giudiziarie/tribunale-di-verona"] },
      { province: "VI", paths: ["/immobili/provincia-di-vicenza", "/vetrine-giudiziarie/tribunale-di-vicenza"] },
      { province: "TV", paths: ["/immobili/provincia-di-treviso", "/vetrine-giudiziarie/tribunale-di-treviso"] },
      { province: "BL", paths: ["/immobili/provincia-di-belluno", "/vetrine-giudiziarie/tribunale-di-belluno"] },
      { province: "RO", paths: ["/immobili/provincia-di-rovigo", "/vetrine-giudiziarie/tribunale-di-rovigo"] },
    ],
    excluded_paths: ["/login", "/account", "/carrello", "/user/", "/news/", "/assets/"],
    allowed_content_types: ["text/html", "application/pdf"],
    crawl_method: "apify",
    max_depth: 1,
    max_pages: 8,
    rate_limit_ms: 1500,
    priority: 1,
    enabled: true,
    compliance_status: "needs_review",
    extraction_strategy: "html_cards",
    keywords: AUCTION_KEYWORDS,
    notes: "Validato 2026-05: HTML statico ricco. Preferire cheerio + maxPages basso per evitare poll_timeout Playwright.",
  },
  // ── Aste Telematiche — DISABILITATA: nessun seed regionale/provinciale valido (tutti i pattern testati restituiscono 404). Sito orientato a ricerca form-based, non navigabile per regione.
  {
    source_key: "astetelematiche_veneto",
    source_name: "Aste Telematiche Veneto",
    base_url: "https://www.astetelematiche.it",
    source_type: "delegated_auction_portal",
    province_scope: "ALL_VENETO",
    allowed_paths: [],
    excluded_paths: ["/login", "/StatusCode/404"],
    allowed_content_types: ["text/html"],
    crawl_method: "manual_only",
    max_depth: 0,
    max_pages: 0,
    rate_limit_ms: 2000,
    priority: 5,
    enabled: false,
    compliance_status: "manual_only",
    extraction_strategy: "search_results",
    keywords: AUCTION_KEYWORDS,
    notes: "Disabilitata 2026-05: nessuna pagina regionale/provinciale pubblica esiste. Solo form ricerca dinamica.",
  },
  // ── Rete Aste (Condotte Immobiliare) — homepage utile, regionali 404. Per ora solo entry point.
  {
    source_key: "reteaste_veneto",
    source_name: "Rete Aste (Condotte Immobiliare)",
    base_url: "https://www.reteaste.it",
    source_type: "delegated_auction_portal",
    province_scope: "ALL_VENETO",
    allowed_paths: ["/vendite-condotte"],
    excluded_paths: ["/login"],
    allowed_content_types: ["text/html", "application/pdf"],
    crawl_method: "apify",
    max_depth: 1,
    max_pages: 5,
    rate_limit_ms: 2000,
    priority: 4,
    enabled: false,
    compliance_status: "needs_review",
    extraction_strategy: "html_cards",
    keywords: AUCTION_KEYWORDS,
    notes: "Homepage 200 ma niente filtro regionale pubblico. Tenere disabilitata finché non si trova seed VE valido.",
  },
  // ── IVG / Tribunali Veneto — domini ufficiali giustizia.it
  // Verificato 2026-05: i domini "tribunale.<città>.it" NON esistono → DNS fail.
  // Domini reali: tribunale-<città>.giustizia.it
  {
    source_key: "tribunale_padova_vendite",
    source_name: "Tribunale di Padova — Vendite Giudiziarie",
    base_url: "https://tribunale-padova.giustizia.it",
    source_type: "tribunal",
    province_scope: ["PD"],
    allowed_paths: ["/it/paginadettaglio.page", "/it/delegati_alle_vendite.page"],
    excluded_paths: ["/login"],
    allowed_content_types: ["text/html", "application/pdf"],
    crawl_method: "firecrawl",
    max_depth: 1,
    max_pages: 5,
    rate_limit_ms: 2000,
    priority: 3,
    enabled: true,
    compliance_status: "allowed_public",
    extraction_strategy: "pdf_links",
    keywords: AUCTION_KEYWORDS,
    notes: "Pagina 'Vendite Giudiziarie' verificata in homepage.",
  },
  {
    source_key: "tribunale_venezia_vendite",
    source_name: "Tribunale di Venezia — Procedure Esecutive e Fallimentari",
    base_url: "https://tribunale-venezia.giustizia.it",
    source_type: "tribunal",
    province_scope: ["VE"],
    allowed_paths: ["/it/procedure_esecutive_fall.page", "/it/delegati_vendite.page"],
    excluded_paths: ["/login"],
    allowed_content_types: ["text/html", "application/pdf"],
    crawl_method: "firecrawl",
    max_depth: 1,
    max_pages: 5,
    rate_limit_ms: 2000,
    priority: 3,
    enabled: true,
    compliance_status: "allowed_public",
    extraction_strategy: "pdf_links",
    keywords: AUCTION_KEYWORDS,
  },
  {
    source_key: "tribunale_verona_vendite",
    source_name: "Tribunale di Verona — Aste Giudiziarie",
    base_url: "https://tribunale-verona.giustizia.it",
    source_type: "tribunal",
    province_scope: ["VR"],
    allowed_paths: ["/it/aste_giudiziarie.page", "/it/delegati_alle_vendite.page"],
    excluded_paths: ["/login"],
    allowed_content_types: ["text/html", "application/pdf"],
    crawl_method: "firecrawl",
    max_depth: 1,
    max_pages: 5,
    rate_limit_ms: 2000,
    priority: 3,
    enabled: true,
    compliance_status: "allowed_public",
    extraction_strategy: "pdf_links",
    keywords: AUCTION_KEYWORDS,
  },
  {
    source_key: "tribunale_vicenza_vendite",
    source_name: "Tribunale di Vicenza — Vendite",
    base_url: "https://tribunale-vicenza.giustizia.it",
    source_type: "tribunal",
    province_scope: ["VI"],
    allowed_paths: ["/"],
    excluded_paths: ["/login"],
    allowed_content_types: ["text/html", "application/pdf"],
    crawl_method: "firecrawl",
    max_depth: 1,
    max_pages: 5,
    rate_limit_ms: 2000,
    priority: 4,
    enabled: false,
    compliance_status: "needs_review",
    extraction_strategy: "pdf_links",
    keywords: AUCTION_KEYWORDS,
    notes: "Homepage 200 ma nessuna sezione vendite trovata in primo livello. Da rivedere.",
  },
  {
    source_key: "tribunale_treviso_vendite",
    source_name: "Tribunale di Treviso — Vendite",
    base_url: "https://tribunale-treviso.giustizia.it",
    source_type: "tribunal",
    province_scope: ["TV"],
    allowed_paths: ["/"],
    excluded_paths: ["/login"],
    allowed_content_types: ["text/html", "application/pdf"],
    crawl_method: "firecrawl",
    max_depth: 1,
    max_pages: 5,
    rate_limit_ms: 2000,
    priority: 4,
    enabled: false,
    compliance_status: "needs_review",
    extraction_strategy: "pdf_links",
    keywords: AUCTION_KEYWORDS,
    notes: "Homepage 200 ma nessuna sezione vendite trovata in primo livello. Da rivedere.",
  },
  {
    source_key: "tribunale_belluno_vendite",
    source_name: "Tribunale di Belluno — Vendite",
    base_url: "https://www.tribunale.belluno.giustizia.it",
    source_type: "tribunal",
    province_scope: ["BL"],
    allowed_paths: ["/"],
    excluded_paths: ["/login"],
    allowed_content_types: ["text/html", "application/pdf"],
    crawl_method: "firecrawl",
    max_depth: 1,
    max_pages: 5,
    rate_limit_ms: 2000,
    priority: 4,
    enabled: false,
    compliance_status: "needs_review",
    extraction_strategy: "pdf_links",
    keywords: AUCTION_KEYWORDS,
    notes: "Solo dominio www.tribunale.belluno.giustizia.it risolve. Sezione vendite da mappare.",
  },
  {
    source_key: "tribunale_rovigo_vendite",
    source_name: "Tribunale di Rovigo — Vendite",
    base_url: "https://tribunale-rovigo.giustizia.it",
    source_type: "tribunal",
    province_scope: ["RO"],
    allowed_paths: ["/"],
    excluded_paths: ["/login"],
    allowed_content_types: ["text/html", "application/pdf"],
    crawl_method: "firecrawl",
    max_depth: 1,
    max_pages: 5,
    rate_limit_ms: 2000,
    priority: 4,
    enabled: false,
    compliance_status: "needs_review",
    extraction_strategy: "pdf_links",
    keywords: AUCTION_KEYWORDS,
    notes: "Homepage 200 ma sezione vendite non identificata. Da rivedere.",
  },
  // ── Demanio — DISABILITATA: path /opencms/it/vendite/ restituisce 404. Sito ristrutturato. Da rimappare.
  {
    source_key: "demanio_vendite",
    source_name: "Agenzia del Demanio — Vendite",
    base_url: "https://www.agenziademanio.it",
    source_type: "demanio",
    province_scope: "ALL_VENETO",
    allowed_paths: [],
    excluded_paths: ["/login"],
    allowed_content_types: ["text/html", "application/pdf"],
    crawl_method: "manual_only",
    max_depth: 0,
    max_pages: 0,
    rate_limit_ms: 2000,
    priority: 5,
    enabled: false,
    compliance_status: "manual_only",
    extraction_strategy: "pdf_links",
    keywords: ["alienazione", "vendita", "bando", "asta", "lotto"],
    notes: "Disabilitata 2026-05: vecchi path opencms tutti 404. Necessita rimappatura sezione vendite attuale.",
  },
];

export function listEnabledSources(opts?: {
  province?: ProvCode[];
  sourceTypes?: AuctionSourceType[];
}): AuctionSource[] {
  return AUCTION_SOURCE_REGISTRY.filter((s) => {
    if (!s.enabled) return false;
    if (s.compliance_status === "blocked" || s.compliance_status === "manual_only") return false;
    if (opts?.sourceTypes && !opts.sourceTypes.includes(s.source_type)) return false;
    if (opts?.province && Array.isArray(s.province_scope)) {
      const ok = s.province_scope.some((p) => opts.province!.includes(p));
      if (!ok) return false;
    }
    return true;
  });
}
