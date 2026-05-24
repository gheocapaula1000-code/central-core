// LuxuRadar source registry — Italy luxury + special situations.
// Only sources we can safely call right now are active=true.
// All others are registered-only (active=false) to document intent without
// fabricating data. Provider names stay internal; client labels are sanitized.

export type SourceCategory =
  | "pvp_judicial"
  | "public_disposal"
  | "public_notice"
  | "special_situation"
  | "hospitality_signal"
  | "luxury_market_signal"
  | "prime_asset_signal";


export type ExtractionMethod = "firecrawl_scrape" | "firecrawl_search" | "perplexity" | "apify" | "public_api" | "manual";

export interface LuxurySource {
  id: string;
  category: SourceCategory;
  label: string;                 // sanitized label exposed to clients
  url?: string;                  // base URL (for scrape)
  query?: string;                // search query (for firecrawl_search / perplexity)
  expectedTypes: string[];       // asset categories likely
  reliability: number;           // 0-100
  extraction: ExtractionMethod;
  active: boolean;               // wired live now
  notes?: string;
  // optional regional hint to bias scoring/dedupe
  regionHint?: string;
  cityHint?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Active sources (safe to call now via Firecrawl)
// ──────────────────────────────────────────────────────────────────────────
export const ACTIVE_SOURCES: LuxurySource[] = [
  // PVP nazionale, top-price IMMOBILI (≥ €3M filter applied downstream)
  {
    id: "pvp_top_price",
    category: "pvp_judicial",
    label: "Judicial auction",
    url: "https://pvp.giustizia.it/pvp/it/lista_annunci.wp?searchType=searchForm&page=0&size=25&sortProperty=prezzoBase,desc&macro=IMMOBILI",
    expectedTypes: ["villa", "palazzo", "castle", "historic_estate", "hotel", "trophy"],
    reliability: 90,
    extraction: "firecrawl_scrape",
    active: true,
    notes: "Italy-wide PVP sorted by base price desc; filter ≥ €3M downstream.",
  },

  // Demanio — valorizzazioni / vendite
  {
    id: "demanio_vendite",
    category: "public_disposal",
    label: "Public disposal",
    query: "site:agenziademanio.it vendita OR valorizzazione immobile storico OR villa OR palazzo",
    expectedTypes: ["villa", "palazzo", "historic_estate", "trophy", "public_disposal"],
    reliability: 92,
    extraction: "firecrawl_search",
    active: true,
  },

  // Comune patrimonio / alienazioni — high-prestige cities
  {
    id: "comune_milano_patrimonio",
    category: "public_disposal",
    label: "Public disposal",
    query: "site:comune.milano.it alienazione OR vendita patrimonio immobile",
    expectedTypes: ["palazzo", "historic_estate", "public_disposal"],
    reliability: 85, extraction: "firecrawl_search", active: true,
    regionHint: "Lombardia", cityHint: "Milano",
  },
  {
    id: "comune_roma_patrimonio",
    category: "public_disposal",
    label: "Public disposal",
    query: "site:comune.roma.it OR site:patrimonio.romacapitale.it alienazione OR bando vendita immobile",
    expectedTypes: ["palazzo", "historic_estate", "public_disposal"],
    reliability: 85, extraction: "firecrawl_search", active: true,
    regionHint: "Lazio", cityHint: "Roma",
  },
  {
    id: "comune_firenze_patrimonio",
    category: "public_disposal",
    label: "Public disposal",
    query: "site:comune.fi.it alienazione OR vendita patrimonio villa OR palazzo",
    expectedTypes: ["villa", "palazzo", "historic_estate", "public_disposal"],
    reliability: 84, extraction: "firecrawl_search", active: true,
    regionHint: "Toscana", cityHint: "Firenze",
  },
  {
    id: "comune_venezia_patrimonio",
    category: "public_disposal",
    label: "Public disposal",
    query: "site:comune.venezia.it alienazione OR vendita patrimonio palazzo OR immobile",
    expectedTypes: ["palazzo", "historic_estate", "public_disposal"],
    reliability: 84, extraction: "firecrawl_search", active: true,
    regionHint: "Veneto", cityHint: "Venezia",
  },
  {
    id: "comune_como_patrimonio",
    category: "public_disposal",
    label: "Public disposal",
    query: "site:comune.como.it alienazione OR vendita patrimonio villa OR immobile",
    expectedTypes: ["villa", "historic_estate", "public_disposal"],
    reliability: 80, extraction: "firecrawl_search", active: true,
    regionHint: "Lombardia", cityHint: "Como",
  },

  // Public notices, broad luxury Italy search
  {
    id: "news_hotel_vendita",
    category: "hospitality_signal", label: "Hospitality asset",
    query: "\"hotel in vendita\" Italia 5 stelle OR luxury OR resort -annunci",
    expectedTypes: ["hotel"], reliability: 65,
    extraction: "firecrawl_search", active: true,
  },
  {
    id: "news_dismissione_hotel",
    category: "special_situation", label: "Special situation",
    query: "dismissione OR cessione hotel Italia gruppo alberghiero",
    expectedTypes: ["hotel"], reliability: 70,
    extraction: "firecrawl_search", active: true,
  },
  {
    id: "news_dimora_storica",
    category: "luxury_market_signal", label: "Luxury market signal",
    query: "\"dimora storica\" in vendita Italia",
    expectedTypes: ["historic_estate", "villa", "palazzo"],
    reliability: 55, extraction: "firecrawl_search", active: true,
  },
  {
    id: "news_castello_vendita",
    category: "luxury_market_signal", label: "Luxury market signal",
    query: "\"castello in vendita\" Italia",
    expectedTypes: ["castle"], reliability: 55,
    extraction: "firecrawl_search", active: true,
  },
  {
    id: "news_palazzo_storico",
    category: "luxury_market_signal", label: "Luxury market signal",
    query: "\"palazzo storico\" in vendita Italia",
    expectedTypes: ["palazzo", "historic_estate"], reliability: 55,
    extraction: "firecrawl_search", active: true,
  },
  {
    id: "news_complesso_immobiliare",
    category: "special_situation", label: "Special situation",
    query: "\"vendita complesso immobiliare\" Italia milioni",
    expectedTypes: ["trophy", "special_situation"], reliability: 60,
    extraction: "firecrawl_search", active: true,
  },
  {
    id: "news_tenuta_vendita",
    category: "luxury_market_signal", label: "Luxury market signal",
    query: "\"vendita tenuta\" Toscana OR Umbria OR Sicilia",
    expectedTypes: ["historic_estate", "masseria"], reliability: 55,
    extraction: "firecrawl_search", active: true,
  },
  {
    id: "news_alienazione_pregio",
    category: "public_disposal", label: "Public disposal",
    query: "\"alienazione immobile di pregio\" OR \"bando vendita villa storica\" comune Italia",
    expectedTypes: ["villa", "palazzo", "historic_estate", "public_disposal"],
    reliability: 75, extraction: "firecrawl_search", active: true,
  },
  {
    id: "news_asta_villa_storica",
    category: "pvp_judicial", label: "Judicial auction",
    query: "\"asta villa storica\" Italia base milioni",
    expectedTypes: ["villa", "historic_estate"], reliability: 70,
    extraction: "firecrawl_search", active: true,
  },
  {
    id: "news_asta_hotel",
    category: "pvp_judicial", label: "Judicial auction",
    query: "\"asta hotel\" Italia base milioni",
    expectedTypes: ["hotel"], reliability: 70,
    extraction: "firecrawl_search", active: true,
  },
  {
    id: "news_asta_palazzo",
    category: "pvp_judicial", label: "Judicial auction",
    query: "\"asta palazzo\" Italia base milioni",
    expectedTypes: ["palazzo", "historic_estate"], reliability: 70,
    extraction: "firecrawl_search", active: true,
  },
];

// ──────────────────────────────────────────────────────────────────────────
// Registered only — known relevant sources, NOT live yet.
// Reasons: per-tribunal IVG portals vary in structure, no licensed press feed,
// some areas lack stable open URLs.
// ──────────────────────────────────────────────────────────────────────────
export const REGISTERED_SOURCES: LuxurySource[] = [
  // Comune patrimonio — luxury areas without stable open registries
  { id: "comune_porto_cervo", category: "public_disposal", label: "Public disposal",
    notes: "Costa Smeralda: comune Arzachena patrimonio non espone registro online stabile.",
    expectedTypes: ["villa","trophy"], reliability: 50, extraction: "manual", active: false,
    regionHint: "Sardegna" },
  { id: "comune_capri", category: "public_disposal", label: "Public disposal",
    notes: "Capri / Costiera: nessun feed strutturato per alienazioni di pregio.",
    expectedTypes: ["villa","historic_estate"], reliability: 50, extraction: "manual", active: false,
    regionHint: "Campania" },
  { id: "comune_cortina", category: "public_disposal", label: "Public disposal",
    notes: "Cortina/Dolomiti: bandi pubblici sporadici, da monitorare manualmente.",
    expectedTypes: ["villa","trophy"], reliability: 50, extraction: "manual", active: false,
    regionHint: "Veneto" },
  { id: "comune_taormina", category: "public_disposal", label: "Public disposal",
    notes: "Taormina/Sicilia luxury: nessun registro pubblico utilizzabile.",
    expectedTypes: ["villa","hotel","historic_estate"], reliability: 50, extraction: "manual", active: false,
    regionHint: "Sicilia" },
  { id: "comune_puglia_luxury", category: "public_disposal", label: "Public disposal",
    notes: "Valle d'Itria / Salento: masserie di pregio via bandi comunali non centralizzati.",
    expectedTypes: ["masseria","historic_estate"], reliability: 50, extraction: "manual", active: false,
    regionHint: "Puglia" },

  // Per-tribunal IVG / aste portals (heterogeneous; registered for later wiring)
  { id: "ivg_milano", category: "pvp_judicial", label: "Judicial auction",
    notes: "Tribunale Milano — IVG: portale dedicato, struttura variabile.",
    expectedTypes: ["palazzo","villa","hotel","trophy"], reliability: 80, extraction: "firecrawl_scrape",
    active: false, regionHint: "Lombardia", cityHint: "Milano" },
  { id: "ivg_roma", category: "pvp_judicial", label: "Judicial auction",
    notes: "Tribunale Roma — IVG: feed non standard.",
    expectedTypes: ["palazzo","villa","historic_estate"], reliability: 78, extraction: "firecrawl_scrape",
    active: false, regionHint: "Lazio", cityHint: "Roma" },
  { id: "ivg_firenze", category: "pvp_judicial", label: "Judicial auction",
    notes: "Tribunale Firenze — IVG: registrato.",
    expectedTypes: ["villa","palazzo","historic_estate"], reliability: 78, extraction: "firecrawl_scrape",
    active: false, regionHint: "Toscana", cityHint: "Firenze" },
  { id: "ivg_como", category: "pvp_judicial", label: "Judicial auction",
    notes: "Tribunale Como — IVG: registrato.",
    expectedTypes: ["villa","trophy"], reliability: 75, extraction: "firecrawl_scrape",
    active: false, regionHint: "Lombardia", cityHint: "Como" },
  { id: "ivg_venezia", category: "pvp_judicial", label: "Judicial auction",
    notes: "Tribunale Venezia — IVG: registrato.",
    expectedTypes: ["palazzo","hotel","historic_estate"], reliability: 75, extraction: "firecrawl_scrape",
    active: false, regionHint: "Veneto", cityHint: "Venezia" },
  { id: "ivg_olbia_tempio", category: "pvp_judicial", label: "Judicial auction",
    notes: "Tribunale Tempio Pausania (Olbia/Sassari) — IVG: registrato.",
    expectedTypes: ["villa","trophy"], reliability: 75, extraction: "firecrawl_scrape",
    active: false, regionHint: "Sardegna" },
  { id: "ivg_napoli_salerno", category: "pvp_judicial", label: "Judicial auction",
    notes: "Tribunali Napoli/Salerno — IVG: registrato.",
    expectedTypes: ["palazzo","villa","historic_estate","hotel"], reliability: 75,
    extraction: "firecrawl_scrape", active: false, regionHint: "Campania" },
  { id: "ivg_belluno", category: "pvp_judicial", label: "Judicial auction",
    notes: "Tribunale Belluno — IVG: registrato (Cortina).",
    expectedTypes: ["villa","trophy"], reliability: 75, extraction: "firecrawl_scrape",
    active: false, regionHint: "Veneto" },
  { id: "ivg_sicilia", category: "pvp_judicial", label: "Judicial auction",
    notes: "Tribunali Messina/Catania/Palermo — IVG: registrato.",
    expectedTypes: ["villa","palazzo","hotel","historic_estate"], reliability: 73,
    extraction: "firecrawl_scrape", active: false, regionHint: "Sicilia" },

  // Hospitality M&A / hotel pipelines (no licensed feed yet)
  { id: "hospitality_ma_pipeline", category: "hospitality_signal", label: "Hospitality asset",
    notes: "M&A pipeline alberghiera: serve feed licenziato o newsletter B2B.",
    expectedTypes: ["hotel"], reliability: 60, extraction: "manual", active: false },
];

export function getActiveSourcesFiltered(opts: {
  categories?: string[];
  regions?: string[];
  sources?: string[];
}): LuxurySource[] {
  return ACTIVE_SOURCES.filter((s) => {
    if (opts.sources?.length && !opts.sources.includes(s.id) && !opts.sources.includes(s.category)) return false;
    if (opts.regions?.length && s.regionHint &&
        !opts.regions.map((r) => r.toLowerCase()).includes(s.regionHint.toLowerCase())) return false;
    if (opts.categories?.length && !s.expectedTypes.some((t) => opts.categories!.includes(t))) return false;
    return true;
  });
}

export function listRegisteredOnly(): Array<{ id: string; reason: string; category: SourceCategory }> {
  return REGISTERED_SOURCES.map((s) => ({
    id: s.id, reason: s.notes ?? "registered only", category: s.category,
  }));
}
