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
        { url: "https://dati.veneto.it/dataset?groups=territorio" },
        { url: "https://dati.veneto.it/dataset?groups=ambiente" },
        { url: "https://dati.veneto.it/dataset?groups=trasporti" },
        { url: "https://dati.veneto.it/dataset?groups=urbanistica" },
        { url: "https://dati.veneto.it/organization/regione-del-veneto" },
      ],
      maxCrawlDepth: 3,
      maxCrawlPages: 80,
      crawlerType: "cheerio",
      respectRobotsTxtFile: true,
      saveMarkdown: true,
      saveHtml: false,
      removeElementsCssSelector: "nav, header, footer, .sidebar, .comments, form",
      includeUrlGlobs: [
        "**/dataset/**",
        "**/dataset?**",
        "**/resource/**",
        "**/organization/regione-del-veneto**",
        "**/group/**",
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
    // Alternate deeper-discovery binding using cheerio-scraper, which is better at
    // following links and emitting structured URL/title pairs when wcc is too shallow.
    source_name: "open_data_veneto_deep_discovery",
    source_type: "open_data",
    actor_id: "apify/cheerio-scraper",
    input_template: {
      startUrls: [
        { url: "https://dati.veneto.it/dataset" },
        { url: "https://dati.veneto.it/dataset?groups=territorio" },
        { url: "https://dati.veneto.it/dataset?groups=ambiente" },
        { url: "https://dati.veneto.it/dataset?groups=trasporti" },
        { url: "https://dati.veneto.it/dataset?groups=urbanistica" },
        { url: "https://dati.veneto.it/organization/regione-del-veneto" },
      ],
      linkSelector: "a[href]",
      pseudoUrls: [
        { purl: "https://dati.veneto.it/dataset/[.+]" },
        { purl: "https://dati.veneto.it/dataset/[.+]/resource/[.+]" },
        { purl: "https://dati.veneto.it/organization/[.+]" },
        { purl: "https://dati.veneto.it/group/[.+]" },
      ],
      maxCrawlingDepth: 3,
      maxPagesPerCrawl: 80,
      maxConcurrency: 5,
      respectRobotsTxtFile: true,
      pageFunction: `async function pageFunction(context) {
  const { request, $ } = context;
  const url = request.url;
  const title = ($('h1').first().text() || $('title').text() || '').trim();
  const description = ($('meta[name="description"]').attr('content') || $('.notes').text() || '').trim();
  const organization = ($('.organization-name').first().text() || '').trim();
  const license = ($('.license-name').first().text() || $('a[rel="license"]').first().text() || '').trim();
  const updated_at = ($('th:contains("Ultimo aggiornamento") + td').first().text() || $('.dataset-details .automatic-local-datetime').first().text() || '').trim();
  const tags = $('.tag-list a, .tags a').map((_, el) => $(el).text().trim()).get();
  const groups = $('.group-list a, .groups a').map((_, el) => $(el).text().trim()).get();
  const resource_urls = $('a.resource-url-analytics, a[href*="/resource/"]').map((_, el) => $(el).attr('href')).get().filter(Boolean);
  const formats = $('.format-label, .resource-format').map((_, el) => $(el).text().trim().toLowerCase()).get();
  const download_urls = $('a.resource-url-analytics[href$=".csv"], a[href$=".geojson"], a[href$=".json"], a[href$=".zip"], a[href$=".xls"], a[href$=".xlsx"], a[href$=".pdf"], a[href$=".kml"], a[href$=".shp"]').map((_, el) => $(el).attr('href')).get().filter(Boolean);
  return { url, title, description, organization, license, updated_at, tags, groups, resource_urls, formats, download_urls };
}`,
    },
    expected_schema: "url,title,description,organization,license,updated_at,tags,groups,resource_urls,formats,download_urls",
    allowed_use: "Discovery profonda dataset CKAN pubblici Regione Veneto",
    compliance_notes: "Open data pubblici, robots.txt rispettato.",
    output_mapping: "url->source_url; title->title; description->content; resource_urls->resource_urls",
    quality_rules: ["require:source_url", "reject:demo|mock|seed"],
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
