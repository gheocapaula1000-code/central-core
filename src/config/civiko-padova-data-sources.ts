// ═══════════════════════════════════════════════════════════════
// Civiko One Padova — Registro Fonti Dati (PROMPT 0)
// ───────────────────────────────────────────────────────────────
// Lista canonica delle 32 fonti dati Civiko Padova.
// Sorgente di verità per il seed di public.civiko_data_sources.
//
// Regole inderogabili:
//  - Nessuna fonte "premium" viene chiamata in automatico dal Dossier base.
//  - Nessuna fonte "manual_or_phase_2" può essere mostrata come collegata.
//  - OpenAPI.it Real Estate resta dormiente (token NOT_CONFIGURED).
// ═══════════════════════════════════════════════════════════════

export type CivikoSourceCategory = "free" | "premium" | "manual_or_phase_2";

export type CivikoSourceStatus =
  | "connected"          // fonte attiva, già usata nel flusso
  | "connectable"        // tecnicamente pronta, non ancora cablata
  | "account_required"   // richiede credenziali/consenso esplicito
  | "manual"             // import manuale (CSV/notarile)
  | "not_yet_available"  // nessuna API/dataset pubblico oggi
  | "phase_2";           // bloccata da policy / rimandata

export interface CivikoDataSource {
  code: string;
  label: string;
  description: string;
  category: CivikoSourceCategory;
  status: CivikoSourceStatus;
  provider?: string;
  base_url?: string;
  env_var?: string;
  coverage: string;
  requires_premium_consent: boolean;
  estimated_cost_eur?: number;
  notes?: string;
  display_order: number;
}

export const CIVIKO_PADOVA_DATA_SOURCES: CivikoDataSource[] = [
  // ── FREE / CONNECTED (già operative nel Core) ──────────────────
  {
    code: "omi_agenzia_entrate",
    label: "OMI — Agenzia delle Entrate",
    description: "Quotazioni e geometrie zone OMI semestrali.",
    category: "free", status: "connected",
    provider: "Agenzia delle Entrate",
    base_url: "https://wwwt.agenziaentrate.gov.it/geopoi_omi",
    coverage: "Italia (Padova mappato)",
    requires_premium_consent: false, display_order: 10,
  },
  {
    code: "istat_sdmx_demografia",
    label: "ISTAT SDMX — Demografia",
    description: "Popolazione, classi età, indice vecchiaia per comune.",
    category: "free", status: "connected",
    provider: "ISTAT",
    base_url: "https://sdmx.istat.it/SDMXWS/rest",
    coverage: "Italia / Veneto",
    requires_premium_consent: false, display_order: 20,
  },
  {
    code: "ispra_ambiente",
    label: "ISPRA — Ambiente e suolo",
    description: "Consumo di suolo, dissesto idrogeologico, qualità ambientale.",
    category: "free", status: "connected",
    provider: "ISPRA",
    base_url: "https://www.isprambiente.gov.it",
    coverage: "Italia",
    requires_premium_consent: false, display_order: 30,
  },
  {
    code: "osm_cantieri",
    label: "OpenStreetMap — Cantieri e POI",
    description: "Cantieri, POI, infrastrutture mappate dalla community.",
    category: "free", status: "connected",
    provider: "OpenStreetMap / Overpass",
    base_url: "https://overpass-api.de/api/interpreter",
    coverage: "Mondiale",
    requires_premium_consent: false, display_order: 40,
  },
  {
    code: "mim_scuole",
    label: "MIM — Anagrafe Scuole",
    description: "Anagrafe scuole statali e paritarie, indirizzi e tipologie.",
    category: "free", status: "connected",
    provider: "Ministero Istruzione e Merito",
    base_url: "https://dati.istruzione.it",
    coverage: "Italia",
    requires_premium_consent: false, display_order: 50,
  },
  {
    code: "infratel_banda_larga",
    label: "Infratel — Banda larga",
    description: "Copertura BUL/FTTH per civico.",
    category: "free", status: "connected",
    provider: "Infratel Italia",
    base_url: "https://bandaultralarga.italia.it",
    coverage: "Italia",
    requires_premium_consent: false, display_order: 60,
  },
  {
    code: "openpnrr",
    label: "OpenPNRR — Progetti PNRR",
    description: "Progetti PNRR per comune/area: importi, stato, ambito.",
    category: "free", status: "connectable",
    provider: "OpenPNRR",
    base_url: "https://openpnrr.it/api",
    env_var: "OPENPNRR_BASE_URL",
    coverage: "Italia",
    requires_premium_consent: false, display_order: 70,
    notes: "Base URL configurato. Cablare endpoint specifici per Padova.",
  },
  {
    code: "arpav_aria",
    label: "ARPAV — Qualità aria Veneto",
    description: "PM10, PM2.5, NO2, ozono — centraline ARPAV.",
    category: "free", status: "connectable",
    provider: "ARPAV",
    base_url: "https://www.arpa.veneto.it/dati-ambientali",
    env_var: "ARPAV_PADOVA_BASE_URL",
    coverage: "Veneto",
    requires_premium_consent: false, display_order: 80,
    notes: "Importer import-arpav-air-quality previsto (WFS).",
  },
  {
    code: "tram_padova",
    label: "Tram Padova — Rete e fermate",
    description: "Tracciato e fermate SIR1/2/3, dati di servizio.",
    category: "free", status: "connectable",
    provider: "Busitalia Veneto",
    base_url: "https://www.trampadova.it",
    env_var: "TRAM_PADOVA_DATA_URL",
    coverage: "Padova",
    requires_premium_consent: false, display_order: 90,
    notes: "Solo sito istituzionale: GTFS non pubblicato, parsing manuale.",
  },

  // ── FREE / CONNECTABLE (API pubbliche, da cablare) ─────────────
  {
    code: "comune_padova_open_data",
    label: "Comune di Padova — Open Data",
    description: "Portale dati aperti del Comune di Padova (CKAN).",
    category: "free", status: "connectable",
    provider: "Comune di Padova",
    base_url: "https://dati.padovanet.it",
    coverage: "Padova",
    requires_premium_consent: false, display_order: 100,
  },
  {
    code: "regione_veneto_open_data",
    label: "Regione Veneto — dati.veneto.it",
    description: "Catalogo open data regionale (CKAN).",
    category: "free", status: "connectable",
    provider: "Regione Veneto",
    base_url: "https://dati.veneto.it",
    coverage: "Veneto",
    requires_premium_consent: false, display_order: 110,
  },
  {
    code: "sit_padova_geoportale",
    label: "SIT Padova — Geoportale comunale",
    description: "WMS/WFS comunali: PRG, vincoli, toponomastica.",
    category: "free", status: "connected",
    provider: "Comune di Padova",
    base_url: "https://cartografia.comune.padova.it/server/rest/services/pat/MapServer",
    coverage: "Padova",
    requires_premium_consent: false, display_order: 120,
    notes: "Registry host sit.padovanet.it does not resolve. Official PAT/PI MapServers live on cartografia.comune.padova.it. Wired by civiko-piano-regolatore-collect.",
  },
  {
    code: "anac_appalti",
    label: "ANAC — Appalti pubblici",
    description: "Bandi e contratti pubblici per stazione appaltante.",
    category: "free", status: "connectable",
    provider: "ANAC",
    base_url: "https://dati.anticorruzione.it",
    coverage: "Italia",
    requires_premium_consent: false, display_order: 130,
  },
  {
    code: "inail_cantieri",
    label: "INAIL — Cantieri e sicurezza",
    description: "Notifiche preliminari cantieri ex art. 99 D.Lgs 81/08.",
    category: "free", status: "connectable",
    provider: "INAIL",
    base_url: "https://www.inail.it",
    coverage: "Italia",
    requires_premium_consent: false, display_order: 140,
  },
  {
    code: "enea_ape",
    label: "ENEA — Attestati Prestazione Energetica",
    description: "Statistiche aggregate APE per comune/classe.",
    category: "free", status: "connectable",
    provider: "ENEA",
    base_url: "https://siape.enea.it",
    coverage: "Italia",
    requires_premium_consent: false, display_order: 150,
  },
  {
    code: "catasto_ade_cartografia",
    label: "Catasto — Cartografia AdE",
    description: "Servizio consultazione cartografia catastale (WMS).",
    category: "free", status: "connectable",
    provider: "Agenzia delle Entrate",
    base_url: "https://wms.cartografia.agenziaentrate.gov.it",
    coverage: "Italia",
    requires_premium_consent: false, display_order: 160,
  },
  {
    code: "arpav_rumore",
    label: "ARPAV — Rumore ambientale",
    description: "Mappature acustiche e segnalazioni rumore.",
    category: "free", status: "connectable",
    provider: "ARPAV",
    base_url: "https://www.arpa.veneto.it",
    coverage: "Veneto",
    requires_premium_consent: false, display_order: 170,
  },
  {
    code: "mobilita_padova",
    label: "Mobilità Padova — Piste ciclabili",
    description: "Tracciati ciclabili e ZTL del Comune di Padova.",
    category: "free", status: "connectable",
    provider: "Comune di Padova",
    base_url: "https://www.padovanet.it/informazione/mobilita-sostenibile",
    coverage: "Padova",
    requires_premium_consent: false, display_order: 180,
  },

  // ── PREMIUM / ACCOUNT REQUIRED (mai chiamate automaticamente) ──
  {
    code: "openapi_it_real_estate",
    label: "OpenAPI.it — Real Estate (premium)",
    description: "SQM, RMV, catasto-lista. A consumo, NON inclusa nel Dossier base.",
    category: "premium", status: "account_required",
    provider: "OpenAPI.it",
    base_url: "https://realestate.openapi.com",
    env_var: "OPENAPI_IT_TOKEN",
    coverage: "Italia",
    requires_premium_consent: true,
    estimated_cost_eur: 0.5,
    display_order: 200,
    notes: "Token attualmente NOT_CONFIGURED — helper dormiente, mai chiamato automaticamente.",
  },
  {
    code: "google_maps_places",
    label: "Google Maps / Places",
    description: "Geocoding, Places, Distance Matrix.",
    category: "premium", status: "account_required",
    provider: "Google",
    base_url: "https://maps.googleapis.com",
    env_var: "GOOGLE_MAPS_API_KEY",
    coverage: "Mondiale",
    requires_premium_consent: true,
    estimated_cost_eur: 0.005,
    display_order: 210,
    notes: "Chiave configurata. Uso parsimonioso, solo on-demand.",
  },
  {
    code: "mapbox",
    label: "Mapbox — Tiles e geocoding",
    description: "Tile rendering e geocoding alternativo.",
    category: "premium", status: "account_required",
    provider: "Mapbox",
    base_url: "https://api.mapbox.com",
    env_var: "MAPBOX_API_KEY",
    coverage: "Mondiale",
    requires_premium_consent: true,
    estimated_cost_eur: 0.0005,
    display_order: 220,
  },
  {
    code: "firecrawl_scraping",
    label: "Firecrawl — Scraping markdown",
    description: "Scraping markdown di pagine web pubbliche.",
    category: "premium", status: "account_required",
    provider: "Firecrawl",
    base_url: "https://api.firecrawl.dev",
    env_var: "FIRECRAWL_API_KEY",
    coverage: "Mondiale",
    requires_premium_consent: true,
    estimated_cost_eur: 0.002,
    display_order: 230,
  },
  {
    code: "apify_actors",
    label: "Apify — Actor scraping",
    description: "Esecuzione actor pre-confezionati per dataset web.",
    category: "premium", status: "account_required",
    provider: "Apify",
    base_url: "https://api.apify.com",
    env_var: "APIFY_API_TOKEN",
    coverage: "Mondiale",
    requires_premium_consent: true,
    estimated_cost_eur: 0.05,
    display_order: 240,
  },
  {
    code: "perplexity_search",
    label: "Perplexity — Ricerca contestuale",
    description: "Ricerca semantica con citazioni.",
    category: "premium", status: "account_required",
    provider: "Perplexity",
    base_url: "https://api.perplexity.ai",
    env_var: "PERPLEXITY_API_KEY",
    coverage: "Mondiale",
    requires_premium_consent: true,
    estimated_cost_eur: 0.005,
    display_order: 250,
  },
  {
    code: "openai_llm",
    label: "OpenAI — LLM",
    description: "Modelli GPT per normalizzazione e generazione testi.",
    category: "premium", status: "account_required",
    provider: "OpenAI",
    base_url: "https://api.openai.com",
    env_var: "OPENAI_API_KEY",
    coverage: "Mondiale",
    requires_premium_consent: true,
    estimated_cost_eur: 0.01,
    display_order: 260,
  },
  {
    code: "anthropic_llm",
    label: "Anthropic — Claude",
    description: "Modelli Claude per ragionamento e sintesi.",
    category: "premium", status: "account_required",
    provider: "Anthropic",
    base_url: "https://api.anthropic.com",
    env_var: "ANTHROPIC_API_KEY",
    coverage: "Mondiale",
    requires_premium_consent: true,
    estimated_cost_eur: 0.015,
    display_order: 270,
  },
  {
    code: "resend_email",
    label: "Resend — Email transazionali",
    description: "Invio email transazionali (inviti agenzia, notifiche operatori).",
    category: "premium", status: "account_required",
    provider: "Resend",
    base_url: "https://api.resend.com",
    env_var: "RESEND_API_KEY",
    coverage: "Mondiale",
    requires_premium_consent: true,
    estimated_cost_eur: 0.0004,
    display_order: 280,
    notes: "Chiave configurata. Uso solo on-demand per inviti/notifiche, mai per il Dossier.",
  },

  // ── MANUAL_OR_PHASE_2 (mai mostrate come collegate) ────────────
  {
    code: "unipd_open_data",
    label: "UniPD — Open Data",
    description: "Dataset studenti/residenze universitarie.",
    category: "manual_or_phase_2", status: "not_yet_available",
    provider: "Università di Padova",
    coverage: "Padova",
    requires_premium_consent: false, display_order: 300,
    notes: "Nessuna API/dataset pubblico immediatamente disponibile. Fonte da collegare quando emergerà.",
  },
  {
    code: "necrologi_obituaries",
    label: "Necrologi — Segnali successione",
    description: "Indicatore aggregato di pressione successoria per area.",
    category: "manual_or_phase_2", status: "phase_2",
    coverage: "Padova",
    requires_premium_consent: false, display_order: 310,
    notes: "Bloccato da policy (privacy/compliance). Tabelle obituaries_* lockate.",
  },
  {
    code: "aste_giudiziarie",
    label: "Aste giudiziarie",
    description: "Immobili in asta dai tribunali competenti.",
    category: "manual_or_phase_2", status: "phase_2",
    provider: "Tribunale di Padova / portali aste",
    coverage: "Padova",
    requires_premium_consent: false, display_order: 320,
    notes: "Richiede scraping mirato + compliance, rimandato a fase 2.",
  },
  {
    code: "successioni_catastali",
    label: "Successioni catastali",
    description: "Volture per successione tramite SISTER/AdE.",
    category: "manual_or_phase_2", status: "manual",
    provider: "Agenzia delle Entrate (SISTER)",
    coverage: "Italia",
    requires_premium_consent: false, display_order: 330,
    notes: "Accesso professionale, import manuale CSV per ora.",
  },
  {
    code: "visure_ipocatastali",
    label: "Visure ipocatastali",
    description: "Visure ipotecarie e catastali per singolo immobile.",
    category: "manual_or_phase_2", status: "manual",
    provider: "Agenzia delle Entrate (SISTER)",
    coverage: "Italia",
    requires_premium_consent: false, display_order: 340,
    notes: "Accesso a pagamento, on-demand manuale.",
  },
];

// Helper: classificazione rapida per UI/endpoint.
export function groupCivikoSources(sources: CivikoDataSource[] = CIVIKO_PADOVA_DATA_SOURCES) {
  const byStatus: Record<CivikoSourceStatus, CivikoDataSource[]> = {
    connected: [], connectable: [], account_required: [],
    manual: [], not_yet_available: [], phase_2: [],
  };
  const byCategory: Record<CivikoSourceCategory, CivikoDataSource[]> = {
    free: [], premium: [], manual_or_phase_2: [],
  };
  for (const s of sources) {
    byStatus[s.status].push(s);
    byCategory[s.category].push(s);
  }
  return { byStatus, byCategory };
}

// Hard rule: una fonte manual_or_phase_2 NON può mai essere mostrata come "connected".
export function assertNoManualConnected(sources: CivikoDataSource[] = CIVIKO_PADOVA_DATA_SOURCES): void {
  const violations = sources.filter(
    (s) => s.category === "manual_or_phase_2" && s.status === "connected",
  );
  if (violations.length > 0) {
    throw new Error(
      `[civiko-data-sources] integrity violation: manual_or_phase_2 marked as connected: ${
        violations.map((v) => v.code).join(", ")
      }`,
    );
  }
}

// Validazione eager allo import del modulo.
assertNoManualConnected();
