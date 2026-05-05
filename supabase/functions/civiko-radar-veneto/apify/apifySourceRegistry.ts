// Apify source registry — only safe, real/partial sources.
// No login bypass, no CAPTCHA bypass, no paywalls.

export type ApifyImportTarget =
  | "source_documents"
  | "territorial_signals"
  | "legal_property_signals"
  | "auction_signals"
  | "listing_price_snapshots"
  | "microzone_sentiment"
  | "turnover_signals";

export interface ApifySourceBinding {
  source_name: string;
  source_type: "open_data" | "urban_planning" | "public_assets" | "auction_public" | "geoportal" | "pdf_index";
  actor_id: string;
  input_template: Record<string, unknown>;
  expected_schema: string;
  allowed_use: string;
  compliance_notes: string;
  output_mapping: string;
  quality_rules: string[];
  import_target: ApifyImportTarget;
}

export const APIFY_VENETO_REGISTRY: ApifySourceBinding[] = [
  {
    source_name: "open_data_veneto_discovery",
    source_type: "open_data",
    actor_id: "apify/website-content-crawler",
    input_template: {
      startUrls: [
        { url: "https://dati.veneto.it/dataset" },
        { url: "https://dati.veneto.it/organization" },
        { url: "https://dati.veneto.it/group" },
      ],
      maxCrawlDepth: 2,
      maxCrawlPages: 30,
      crawlerType: "cheerio",
      respectRobotsTxtFile: true,
      includeUrlGlobs: [
        "**/dataset**",
        "**/organization**",
        "**/group**",
        "**/resource**",
      ],
      excludeUrlGlobs: [
        "**/user/**",
        "**/user/login**",
        "**/login**",
        "**/register**",
        "**/signin**",
        "**/signup**",
        "**/comment**",
        "**/comment-form**",
        "**/node/*comment*",
        "**/privacy**",
        "**/cookie**",
        "**/contatti**",
        "**/contact**",
        "**/search**",
        "**/admin**",
      ],
    },
    expected_schema: "url,title,markdown",
    allowed_use: "Discovery dataset CKAN pubblici Regione Veneto",
    compliance_notes: "Open data pubblici, robots.txt rispettato.",
    output_mapping: "url->source_url; title->title; markdown->content",
    quality_rules: ["require:source_url", "require:title", "reject:demo|mock|seed"],
    import_target: "source_documents",
  },
  {
    source_name: "comune_padova_urbanistica",
    source_type: "urban_planning",
    actor_id: "apify/website-content-crawler",
    input_template: {
      startUrls: [{ url: "https://www.padovanet.it/informazione/urbanistica" }],
      maxCrawlDepth: 2,
      maxCrawlPages: 50,
      crawlerType: "cheerio",
      respectRobotsTxtFile: true,
    },
    expected_schema: "url,title,markdown",
    allowed_use: "Pagine pubbliche urbanistica Comune di Padova",
    compliance_notes: "Solo contenuti pubblici, no login.",
    output_mapping: "url->source_url; title->title; markdown->content",
    quality_rules: ["require:source_url", "reject:personal_data"],
    import_target: "source_documents",
  },
  {
    source_name: "comune_vicenza_alienazioni",
    source_type: "public_assets",
    actor_id: "apify/website-content-crawler",
    input_template: {
      startUrls: [{ url: "https://www.comune.vicenza.it/" }],
      maxCrawlDepth: 2,
      maxCrawlPages: 40,
      crawlerType: "cheerio",
      includeUrlGlobs: ["**alienazion**", "**patrimonio**", "**bandi**"],
      respectRobotsTxtFile: true,
    },
    expected_schema: "url,title,markdown",
    allowed_use: "Avvisi alienazione/patrimonio pubblico Comune Vicenza",
    compliance_notes: "Atti pubblici, no dati personali.",
    output_mapping: "url->source_url; title->title; markdown->content",
    quality_rules: ["require:source_url", "reject:personal_data"],
    import_target: "source_documents",
  },
  {
    source_name: "comune_verona_pdf_index",
    source_type: "pdf_index",
    actor_id: "apify/website-content-crawler",
    input_template: {
      startUrls: [{ url: "https://www.comune.verona.it/nqcontent.cfm?a_id=39" }],
      maxCrawlDepth: 1,
      maxCrawlPages: 30,
      crawlerType: "cheerio",
      includeUrlGlobs: ["**.pdf"],
      respectRobotsTxtFile: true,
    },
    expected_schema: "url,title",
    allowed_use: "Indice PDF pubblici Comune Verona",
    compliance_notes: "Documenti pubblici.",
    output_mapping: "url->source_url; title->title",
    quality_rules: ["require:source_url"],
    import_target: "source_documents",
  },
  {
    source_name: "geoportale_veneto_layers",
    source_type: "geoportal",
    actor_id: "apify/website-content-crawler",
    input_template: {
      startUrls: [{ url: "https://idt2.regione.veneto.it/" }],
      maxCrawlDepth: 1,
      maxCrawlPages: 30,
      crawlerType: "cheerio",
      respectRobotsTxtFile: true,
    },
    expected_schema: "url,title,markdown",
    allowed_use: "Discovery layer pubblici geoportale Veneto",
    compliance_notes: "Solo metadata pubblici.",
    output_mapping: "url->source_url; title->title; markdown->content",
    quality_rules: ["require:source_url"],
    import_target: "territorial_signals",
  },
];

export function findApifySource(source_name: string): ApifySourceBinding | null {
  return APIFY_VENETO_REGISTRY.find((s) => s.source_name === source_name) ?? null;
}

export function isApifyActorAllowed(source_name: string, actor_id: string): ApifySourceBinding | null {
  const s = findApifySource(source_name);
  if (!s) return null;
  if (actor_id && s.actor_id !== actor_id) return null;
  return s;
}
