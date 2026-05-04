// ═══════════════════════════════════════════════════════════════
// Perplexity-derived source map for Veneto (sentiment microzone,
// urban planning, OMI, open data, geo/environment, legal/auctions,
// mobility/POI, demographic turnover).
//
// Compliance:
// - public sources only (no login/CAPTCHA/paywall bypass)
// - URLs marked "needs_url_resolution" when not verifiable
// - no personal data
// ═══════════════════════════════════════════════════════════════

export type PxSourceCategory =
  | "open_data"
  | "geo_environment"
  | "omi_market"
  | "demographic_turnover"
  | "urban_planning"
  | "legal_auction"
  | "mobility_services_poi";

export type PxFormat = "csv" | "shp" | "pdf" | "html" | "geojson" | "wms" | "wfs" | "api" | "ckan" | "unknown";
export type PxIngestion =
  | "firecrawl" | "apify" | "ckan" | "manual_csv" | "pdf_parser"
  | "geo_import" | "api" | "needs_agreement" | "needs_url_resolution";

export interface PxSource {
  source_name: string;
  base_url: string;
  source_type: PxSourceCategory;
  priority: number;            // 1-5
  coverage_area: string;       // 'veneto' | provincia | comune
  province: string[];
  comuni?: string[];
  allowed_paths?: string[];
  excluded_paths?: string[];
  expected_entities: string[];
  format_expected: PxFormat;
  ingestion_method: PxIngestion;
  quality_default: "reale" | "parziale" | "stimato";
  reliability_score: number;
  freshness_score: number;
  allowed_use: "libera" | "trasparenza" | "open_data" | "needs_agreement";
  notes?: string;
}

const ALL_VENETO = ["VE","VR","VI","PD","TV","BL","RO"];

// ─────────────────── 1. Open Data ────────────────────────────
const OPEN_DATA: PxSource[] = [
  {
    source_name: "open_data_veneto_ckan",
    base_url: "https://dati.veneto.it/",
    source_type: "open_data", priority: 5, coverage_area: "veneto", province: ALL_VENETO,
    allowed_paths: ["/dataset","/group","/organization"],
    expected_entities: ["dataset","csv","geojson","shp"],
    format_expected: "ckan", ingestion_method: "ckan",
    quality_default: "reale", reliability_score: 92, freshness_score: 75,
    allowed_use: "open_data",
  },
  {
    source_name: "regione_veneto_statistica",
    base_url: "https://statistica.regione.veneto.it/",
    source_type: "open_data", priority: 4, coverage_area: "veneto", province: ALL_VENETO,
    allowed_paths: ["/banche-dati","/pubblicazioni"],
    expected_entities: ["dataset","report","abitazioni","popolazione"],
    format_expected: "html", ingestion_method: "firecrawl",
    quality_default: "reale", reliability_score: 90, freshness_score: 60,
    allowed_use: "open_data",
  },
  {
    source_name: "catalogo_shp_veneto",
    base_url: "https://idt2.regione.veneto.it/idt/downloader/download",
    source_type: "open_data", priority: 3, coverage_area: "veneto", province: ALL_VENETO,
    expected_entities: ["shp","geo_dataset"],
    format_expected: "shp", ingestion_method: "needs_url_resolution",
    quality_default: "parziale", reliability_score: 88, freshness_score: 60,
    allowed_use: "open_data",
    notes: "Risolvere endpoint CKAN puntuale per ciascun layer.",
  },
];

// ─────────────────── 2. Geo / Environment / ARPAV ────────────
const GEO_ENV: PxSource[] = [
  {
    source_name: "geoportale_regione_veneto",
    base_url: "https://idt2.regione.veneto.it/",
    source_type: "geo_environment", priority: 5, coverage_area: "veneto", province: ALL_VENETO,
    allowed_paths: ["/idt","/catalog","/gn"],
    expected_entities: ["wms","wfs","layer","geo"],
    format_expected: "wms", ingestion_method: "geo_import",
    quality_default: "reale", reliability_score: 92, freshness_score: 70,
    allowed_use: "open_data",
  },
  {
    source_name: "arpav_open_data",
    base_url: "https://www.arpa.veneto.it/dati-ambientali",
    source_type: "geo_environment", priority: 5, coverage_area: "veneto", province: ALL_VENETO,
    expected_entities: ["aria","rumore","clima","centraline"],
    format_expected: "html", ingestion_method: "firecrawl",
    quality_default: "reale", reliability_score: 95, freshness_score: 85,
    allowed_use: "open_data",
  },
  {
    source_name: "arpav_geoportale",
    base_url: "https://geoportale.arpa.veneto.it/",
    source_type: "geo_environment", priority: 4, coverage_area: "veneto", province: ALL_VENETO,
    expected_entities: ["layer","webgis","ambiente"],
    format_expected: "wms", ingestion_method: "geo_import",
    quality_default: "reale", reliability_score: 92, freshness_score: 70,
    allowed_use: "open_data",
  },
];

// ─────────────────── 3. OMI / Market ─────────────────────────
const OMI_MARKET: PxSource[] = [
  {
    source_name: "omi_note_territoriali",
    base_url: "https://www.agenziaentrate.gov.it/portale/web/guest/schede/fabbricatiterreni/omi/banche-dati/note-territoriali",
    source_type: "omi_market", priority: 5, coverage_area: "veneto", province: ALL_VENETO,
    expected_entities: ["nota_territoriale","pdf","ntn","imi","quotazioni"],
    format_expected: "pdf", ingestion_method: "pdf_parser",
    quality_default: "reale", reliability_score: 98, freshness_score: 60,
    allowed_use: "trasparenza",
  },
  {
    source_name: "omi_statistiche_regionali_veneto",
    base_url: "https://www.agenziaentrate.gov.it/portale/web/guest/schede/fabbricatiterreni/omi/pubblicazioni/rapporti-immobiliari",
    source_type: "omi_market", priority: 4, coverage_area: "veneto", province: ALL_VENETO,
    expected_entities: ["rapporto","ntn","imi","stock","trend"],
    format_expected: "pdf", ingestion_method: "pdf_parser",
    quality_default: "reale", reliability_score: 95, freshness_score: 50,
    allowed_use: "trasparenza",
  },
];

// ─────────────────── 4. Demographic / Turnover ───────────────
const DEMOG: PxSource[] = [
  {
    source_name: "istat_censimento_abitazioni",
    base_url: "https://www.istat.it/it/censimenti/popolazione-e-abitazioni",
    source_type: "demographic_turnover", priority: 5, coverage_area: "veneto", province: ALL_VENETO,
    expected_entities: ["abitazioni","non_occupate","epoca_costruzione","stock"],
    format_expected: "csv", ingestion_method: "manual_csv",
    quality_default: "reale", reliability_score: 98, freshness_score: 40,
    allowed_use: "open_data",
  },
  {
    source_name: "istat_dcis_popres1",
    base_url: "https://esploradati.istat.it/databrowser/",
    source_type: "demographic_turnover", priority: 5, coverage_area: "veneto", province: ALL_VENETO,
    expected_entities: ["popolazione","fasce_eta","over85","indice_vecchiaia"],
    format_expected: "api", ingestion_method: "api",
    quality_default: "reale", reliability_score: 98, freshness_score: 80,
    allowed_use: "open_data",
    notes: "Già usato da edge function istat-sdmx-fetch.",
  },
  {
    source_name: "ires_veneto_condizione_abitativa",
    base_url: "https://www.iresveneto.it/",
    source_type: "demographic_turnover", priority: 3, coverage_area: "veneto", province: ALL_VENETO,
    expected_entities: ["report","condizione_abitativa","qualita"],
    format_expected: "pdf", ingestion_method: "pdf_parser",
    quality_default: "parziale", reliability_score: 80, freshness_score: 50,
    allowed_use: "trasparenza",
  },
];

// ─────────────────── 5. Urban Planning ───────────────────────
function urbSource(name: string, base: string, prov: string, comune: string, paths: string[]): PxSource {
  return {
    source_name: name, base_url: base, source_type: "urban_planning",
    priority: 5, coverage_area: comune, province: [prov], comuni: [comune],
    allowed_paths: paths,
    excluded_paths: ["login","accedi","privato","riservato","abbonati","spid-only"],
    expected_entities: ["pi","pat","pua","variante","piano_interventi","sit","alienazione","opera_pubblica"],
    format_expected: "html", ingestion_method: "firecrawl",
    quality_default: "parziale", reliability_score: 88, freshness_score: 70,
    allowed_use: "trasparenza",
  };
}
const URBAN: PxSource[] = [
  urbSource("padova_piano_interventi", "https://www.padovanet.it/informazione/piano-degli-interventi-pi", "PD", "Padova",
    ["/informazione/piano-degli-interventi-pi","/urbanistica","/pi"]),
  urbSource("venezia_pi_vprg", "https://www.comune.venezia.it/it/content/piano-interventi", "VE", "Venezia",
    ["/content/piano-interventi","/urbanistica","/vprg"]),
  urbSource("verona_sit_pi", "https://sit.comune.verona.it/", "VR", "Verona",
    ["/portal","/PianiInterventi","/cartografia"]),
  urbSource("treviso_geoportale_pi", "https://geoportale.comune.treviso.it/", "TV", "Treviso",
    ["/pi","/piano-interventi","/cartografia","/urbanistica"]),
  urbSource("vicenza_pat_pi_pua", "https://www.comune.vicenza.it/", "VI", "Vicenza",
    ["/uffici/dipserv/urbanistica","/urbanistica","/pi","/pat","/pua"]),
  {
    source_name: "open_data_veneto_pi_vicenza",
    base_url: "https://dati.veneto.it/dataset?q=piano+interventi+vicenza",
    source_type: "urban_planning", priority: 4, coverage_area: "Vicenza", province: ["VI"], comuni: ["Vicenza"],
    expected_entities: ["pi","piano","dataset"],
    format_expected: "ckan", ingestion_method: "ckan",
    quality_default: "reale", reliability_score: 92, freshness_score: 70,
    allowed_use: "open_data",
  },
];

// ─────────────────── 6. Legal / Auctions ─────────────────────
const LEGAL: PxSource[] = [
  {
    source_name: "pvp_veneto",
    base_url: "https://pvp.giustizia.it/pvp/it/risultati_ricerca.page",
    source_type: "legal_auction", priority: 5, coverage_area: "veneto", province: ALL_VENETO,
    expected_entities: ["asta","pvp","tribunale","prezzo_base"],
    format_expected: "html", ingestion_method: "firecrawl",
    quality_default: "reale", reliability_score: 98, freshness_score: 92,
    allowed_use: "trasparenza",
  },
  {
    source_name: "fallco_veneto",
    base_url: "https://www.fallcoaste.it/",
    source_type: "legal_auction", priority: 3, coverage_area: "veneto", province: ALL_VENETO,
    expected_entities: ["asta","fallimento"],
    format_expected: "html", ingestion_method: "needs_agreement",
    quality_default: "parziale", reliability_score: 85, freshness_score: 80,
    allowed_use: "needs_agreement",
    notes: "Verifica TOS prima di scraping massivo.",
  },
  {
    source_name: "demanio_alienazioni",
    base_url: "https://www.agenziademanio.it/it/vendita-immobili/",
    source_type: "legal_auction", priority: 3, coverage_area: "veneto", province: ALL_VENETO,
    expected_entities: ["alienazione","patrimonio_pubblico"],
    format_expected: "html", ingestion_method: "firecrawl",
    quality_default: "parziale", reliability_score: 90, freshness_score: 60,
    allowed_use: "trasparenza",
  },
  {
    source_name: "anbsc_beni_confiscati",
    base_url: "https://benisequestraticonfiscati.it/",
    source_type: "legal_auction", priority: 2, coverage_area: "veneto", province: ALL_VENETO,
    expected_entities: ["bene_confiscato","destinazione"],
    format_expected: "html", ingestion_method: "firecrawl",
    quality_default: "parziale", reliability_score: 90, freshness_score: 50,
    allowed_use: "trasparenza",
  },
  {
    source_name: "ater_veneto",
    base_url: "https://www.ater.pd.it/",
    source_type: "legal_auction", priority: 2, coverage_area: "veneto", province: ALL_VENETO,
    expected_entities: ["alienazione","ater","patrimonio"],
    format_expected: "html", ingestion_method: "needs_url_resolution",
    quality_default: "parziale", reliability_score: 80, freshness_score: 50,
    allowed_use: "trasparenza",
    notes: "Risolvere URL provinciali ATER (PD/VR/VI/TV/VE/BL/RO).",
  },
];

// ─────────────────── 7. Mobility / POI ───────────────────────
const MOBILITY: PxSource[] = [
  {
    source_name: "tpl_veneto_gtfs",
    base_url: "https://transitfeeds.com/l/471-italy-veneto",
    source_type: "mobility_services_poi", priority: 3, coverage_area: "veneto", province: ALL_VENETO,
    expected_entities: ["gtfs","fermate","linee"],
    format_expected: "api", ingestion_method: "needs_url_resolution",
    quality_default: "parziale", reliability_score: 82, freshness_score: 60,
    allowed_use: "open_data",
    notes: "Selezionare feed ufficiali per ciascun gestore (Busitalia, ACTV, ATV...).",
  },
  {
    source_name: "rfi_stazioni",
    base_url: "https://www.rfi.it/it/stazioni.html",
    source_type: "mobility_services_poi", priority: 3, coverage_area: "veneto", province: ALL_VENETO,
    expected_entities: ["stazione","ferrovia"],
    format_expected: "html", ingestion_method: "firecrawl",
    quality_default: "parziale", reliability_score: 90, freshness_score: 50,
    allowed_use: "trasparenza",
  },
  {
    source_name: "mim_scuole_veneto",
    base_url: "https://dati.istruzione.it/opendata/",
    source_type: "mobility_services_poi", priority: 4, coverage_area: "veneto", province: ALL_VENETO,
    expected_entities: ["scuola","istituto","grado"],
    format_expected: "csv", ingestion_method: "api",
    quality_default: "reale", reliability_score: 95, freshness_score: 70,
    allowed_use: "open_data",
    notes: "Già parzialmente importato in mim_schools.",
  },
];

export const PERPLEXITY_VENETO_SOURCES: PxSource[] = [
  ...OPEN_DATA, ...GEO_ENV, ...OMI_MARKET, ...DEMOG, ...URBAN, ...LEGAL, ...MOBILITY,
];

export function pxRegistryStats() {
  const byCat: Record<string, number> = {};
  const byMethod: Record<string, number> = {};
  for (const s of PERPLEXITY_VENETO_SOURCES) {
    byCat[s.source_type] = (byCat[s.source_type] ?? 0) + 1;
    byMethod[s.ingestion_method] = (byMethod[s.ingestion_method] ?? 0) + 1;
  }
  return { total: PERPLEXITY_VENETO_SOURCES.length, by_category: byCat, by_ingestion: byMethod };
}
