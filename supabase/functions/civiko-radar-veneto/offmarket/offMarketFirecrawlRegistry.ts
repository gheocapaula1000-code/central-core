// ═══════════════════════════════════════════════════════════════
// Off-Market & Microzone Firecrawl Source Registry
// Fonti pubbliche territoriali Veneto per agenti immobiliari.
// Categorie: urbanistica, opere pubbliche, patrimonio, alienazioni,
// rigenerazione, mobilità, servizi, verde, turismo, quartieri, PNRR.
// NESSUNA fonte aste in priorità — quelle restano in legal/.
// Compliance: solo URL pubblici, no login/CAPTCHA, no dati personali.
// ═══════════════════════════════════════════════════════════════

export type OffMarketCategory =
  | "urbanistica"
  | "piano_interventi"
  | "varianti_urbanistiche"
  | "opere_pubbliche"
  | "rigenerazione_urbana"
  | "patrimonio_pubblico"
  | "alienazioni"
  | "mobilita"
  | "servizi"
  | "verde"
  | "turismo"
  | "quartieri"
  | "sicurezza_urbana_aggregata"
  | "report_comunali"
  | "pnrr_locale";

export type OffMarketSourceType =
  | "comune_albo"
  | "comune_urbanistica"
  | "comune_avvisi"
  | "comune_news"
  | "regione"
  | "geoportale"
  | "ente_strumentale";

export interface OffMarketFirecrawlSource {
  source_key: string;
  source_name: string;
  base_url: string;
  comune: string;
  provincia: string;
  source_type: OffMarketSourceType;
  category: OffMarketCategory;
  allowed_paths: string[];   // path prefixes accettati
  excluded_paths: string[];  // pattern che escludono (login, anagrafe, necrologi)
  keywords: string[];        // termini per fcMap search e scoring
  max_depth: number;
  max_pages: number;
  crawl_method: "firecrawl";
  priority: 1 | 2 | 3 | 4 | 5; // 5 = top
  expected_signals: string[];
  compliance_notes: string;
  enabled: boolean;
}

// ── Excluded paths globali (PII / non-utili / paywall) ─────────
const GLOBAL_EXCLUDED = [
  "/login", "/accedi", "/area-riservata", "/spid", "/cie",
  "/anagrafe", "/stato-civile", "/necrologi", "/decessi",
  "/contatti-personali", "/dipendenti/",
  "/cookie", "/privacy-policy",
];

// Helper: union dei path esclusi globali + extra
const X = (extra: string[] = []) => [...GLOBAL_EXCLUDED, ...extra];

export const OFFMARKET_FIRECRAWL_REGISTRY: OffMarketFirecrawlSource[] = [
  // ─── PADOVA ────────────────────────────────────────────────
  {
    source_key: "padova-urbanistica",
    source_name: "Comune di Padova — Urbanistica",
    base_url: "https://www.comune.padova.it/urbanistica",
    comune: "Padova", provincia: "PD",
    source_type: "comune_urbanistica", category: "urbanistica",
    allowed_paths: ["/informazione/urbanistica", "/informazione/piano", "/urbanistica/", "/urbanistica", "/piano-degli-interventi", "/varianti", "/prgc"],
    excluded_paths: X(),
    keywords: ["piano interventi", "PI", "PAT", "variante", "rigenerazione", "comparto"],
    max_depth: 2, max_pages: 25, crawl_method: "firecrawl",
    priority: 5, expected_signals: ["urban_planning_signal", "regeneration_signal"],
    compliance_notes: "Pagine pubbliche istituzionali",
    enabled: true,
  },
  {
    source_key: "padova-opere-pubbliche",
    source_name: "Comune di Padova — Opere Pubbliche",
    base_url: "https://www.comune.padova.it/lavori-pubblici",
    comune: "Padova", provincia: "PD",
    source_type: "comune_avvisi", category: "opere_pubbliche",
    allowed_paths: ["/informazione/lavori-pubblici", "/informazione/cantieri", "/notizia/", "/informazione/gara", "/lavori-pubblici", "/opere-pubbliche", "/cantieri", "/appalti"],
    excluded_paths: X(),
    keywords: ["cantiere", "appalto", "lavori pubblici", "riqualificazione", "gara"],
    max_depth: 2, max_pages: 20, crawl_method: "firecrawl",
    priority: 4, expected_signals: ["public_work_signal"],
    compliance_notes: "Pagine pubbliche istituzionali",
    enabled: true,
  },
  {
    source_key: "padova-patrimonio-alienazioni",
    source_name: "Comune di Padova — Patrimonio e Alienazioni",
    base_url: "https://www.comune.padova.it/patrimonio",
    comune: "Padova", provincia: "PD",
    source_type: "comune_avvisi", category: "alienazioni",
    allowed_paths: ["/informazione/avvisi", "/informazione/patrimonio", "/informazione/aste", "/informazione/bandi", "/patrimonio", "/alienazioni", "/aste", "/bandi-alienazione", "/avvisi-pubblici"],
    excluded_paths: X(),
    keywords: ["alienazione", "patrimonio comunale", "vendita immobile", "asta pubblica"],
    max_depth: 2, max_pages: 20, crawl_method: "firecrawl",
    priority: 5, expected_signals: ["public_asset_signal", "alienation_signal"],
    compliance_notes: "Avvisi pubblici di alienazione patrimonio comunale",
    enabled: true,
  },
  {
    source_key: "ivg-padova-aste",
    source_name: "IVG Padova — Aste Giudiziarie",
    base_url: "https://www.ivgpadova.it",
    comune: "Padova", provincia: "PD",
    source_type: "ente_strumentale", category: "patrimonio_pubblico",
    allowed_paths: ["/aste", "/immobili", "/vendite", "/ricerca"],
    excluded_paths: X(["/login", "/registrazione"]),
    keywords: ["immobile", "residenziale", "commerciale", "terreno", "asta", "base d'asta", "prezzo minimo", "lotto"],
    max_depth: 2, max_pages: 5, crawl_method: "firecrawl",
    priority: 5, expected_signals: ["alienation_signal"],
    compliance_notes: "Aste giudiziarie pubbliche IVG Padova",
    enabled: true,
  },
  {
    source_key: "ater-padova",
    source_name: "ATER Padova — Dismissioni patrimonio ERP",
    base_url: "https://www.ater.padova.it",
    comune: "Padova", provincia: "PD",
    source_type: "ente_strumentale", category: "patrimonio_pubblico",
    allowed_paths: ["/vendita", "/alienazione", "/patrimonio", "/bandi", "/avvisi"],
    excluded_paths: X(),
    keywords: ["vendita", "alienazione", "patrimonio", "alloggio", "bando", "avviso pubblico"],
    max_depth: 2, max_pages: 3, crawl_method: "firecrawl",
    priority: 4, expected_signals: ["public_asset_signal", "alienation_signal"],
    compliance_notes: "Dismissioni patrimonio ERP ATER Padova",
    enabled: true,
  },
  {
    source_key: "tribunale-padova-pvp",
    source_name: "PVP Giustizia — Tribunale di Padova",
    base_url: "https://pvp.giustizia.it",
    comune: "Padova", provincia: "PD",
    source_type: "ente_strumentale", category: "patrimonio_pubblico",
    allowed_paths: ["/pvp/it/risultati_ricerca.page", "/vetrine-giudiziarie/tribunale-di-padova"],
    excluded_paths: X(["/pvp/it/login"]),
    keywords: ["immobile", "residenziale", "appartamento", "terreno", "capannone", "base d'asta", "lotto", "Padova"],
    max_depth: 2, max_pages: 5, crawl_method: "firecrawl",
    priority: 5, expected_signals: ["alienation_signal"],
    compliance_notes: "Aste giudiziarie pubbliche PVP Tribunale Padova",
    enabled: true,
  },
  // ─── VENEZIA / MESTRE ──────────────────────────────────────
  // URL aggiornati a CMS Drupal pubblico /it/content/* (validati 2026-05).
  {
    source_key: "venezia-urbanistica",
    source_name: "Comune di Venezia — Piani Urbanistici",
    base_url: "https://www.comune.venezia.it/it/content/piani-urbanistici",
    comune: "Venezia", provincia: "VE",
    source_type: "comune_urbanistica", category: "urbanistica",
    allowed_paths: ["/it/content/piani", "/it/content/territorio", "/it/urbanistica", "/it/content/pat", "/it/content/pi-"],
    excluded_paths: X(),
    keywords: ["PAT", "PI", "variante", "piani urbanistici", "rigenerazione"],
    max_depth: 2, max_pages: 25, crawl_method: "firecrawl",
    priority: 5, expected_signals: ["urban_planning_signal", "regeneration_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },
  {
    source_key: "venezia-mobilita-pums",
    source_name: "Comune di Venezia — Mobilità e Viabilità",
    base_url: "https://www.comune.venezia.it/it/content/mobilita-e-viabilita",
    comune: "Venezia", provincia: "VE",
    source_type: "comune_news", category: "mobilita",
    allowed_paths: ["/it/content/mobilita", "/it/content/pums", "/it/content/viabilita", "/it/content/priorit"],
    excluded_paths: X(),
    keywords: ["PUMS", "mobilità", "tram", "ZTL", "ciclabile", "viabilità"],
    max_depth: 2, max_pages: 15, crawl_method: "firecrawl",
    priority: 4, expected_signals: ["mobility_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },
  {
    source_key: "venezia-patrimonio",
    source_name: "Comune di Venezia — Dismissioni Patrimoniali",
    base_url: "https://www.comune.venezia.it/it/content/dismissioni-patrimoniali",
    comune: "Venezia", provincia: "VE",
    source_type: "comune_avvisi", category: "patrimonio_pubblico",
    allowed_paths: ["/it/content/dismissioni", "/it/content/bando-asta", "/it/content/patrimonio", "/it/taxonomy/term/51"],
    excluded_paths: X(["/concorsi/", "/cod-", "/ispettore"]),
    keywords: ["alienazione", "dismissione", "patrimonio", "bando asta", "vendita immobile", "concessione"],
    max_depth: 2, max_pages: 20, crawl_method: "firecrawl",
    priority: 5, expected_signals: ["public_asset_signal", "alienation_signal"],
    compliance_notes: "Avvisi pubblici",
    enabled: true,
  },
  {
    source_key: "venezia-turismo",
    source_name: "Comune di Venezia — Contributo di Accesso",
    base_url: "https://www.comune.venezia.it/it/cda-info",
    comune: "Venezia", provincia: "VE",
    source_type: "comune_news", category: "turismo",
    allowed_paths: ["/it/cda", "/it/content/contributo-accesso", "/it/content/clone-regolamento"],
    excluded_paths: X(),
    keywords: ["contributo accesso", "turismo", "flussi turistici", "regolamento"],
    max_depth: 2, max_pages: 12, crawl_method: "firecrawl",
    priority: 4, expected_signals: ["tourism_pressure_signal"],
    compliance_notes: "Pagine pubbliche aggregate",
    enabled: true,
  },

  // ─── VERONA ────────────────────────────────────────────────
  // Vecchio nqcontent.cfm ritorna 410 + kernel error: sostituito con nuovo portale
  // /Amministrazione, /Servizi, /Novita (validati 2026-05).
  {
    source_key: "verona-urbanistica",
    source_name: "Comune di Verona — Pianificazione e Governo del Territorio",
    base_url: "https://www.comune.verona.it/Amministrazione-Trasparente/Pianificazione-e-governo-del-territorio",
    comune: "Verona", provincia: "VR",
    source_type: "comune_urbanistica", category: "urbanistica",
    allowed_paths: ["/Amministrazione-Trasparente/Pianificazione", "/Servizi/PUA", "/Novita/Notizie/Piano-degli-Interventi", "/Servizi/Variante"],
    excluded_paths: X(["/nqcontent.cfm"]),
    keywords: ["PAT", "PI", "piano degli interventi", "variante", "PUA", "rigenerazione"],
    max_depth: 2, max_pages: 20, crawl_method: "firecrawl",
    priority: 5, expected_signals: ["urban_planning_signal", "regeneration_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },
  {
    source_key: "verona-opere-pubbliche",
    source_name: "Comune di Verona — Programmazione e Lavori Pubblici",
    base_url: "https://www.comune.verona.it/Amministrazione/Documenti-e-dati/Documenti-di-programmazione-e-rendicontazione",
    comune: "Verona", provincia: "VR",
    source_type: "comune_avvisi", category: "opere_pubbliche",
    allowed_paths: ["/Amministrazione/Documenti", "/Amministrazione-Trasparente/Opere-pubbliche", "/Servizi/Lavori"],
    excluded_paths: X(["/nqcontent.cfm"]),
    keywords: ["lavori pubblici", "cantiere", "opere", "programma triennale", "riqualificazione"],
    max_depth: 2, max_pages: 15, crawl_method: "firecrawl",
    priority: 4, expected_signals: ["public_work_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },
  {
    source_key: "verona-patrimonio",
    source_name: "Comune di Verona — Alienazione Beni Immobili",
    base_url: "https://www.comune.verona.it/Amministrazione-Trasparente/Bandi-di-gara-e-contratti/Altri-avvisi-bandi-e-concorsi2/Alienazione-beni-immobili",
    comune: "Verona", provincia: "VR",
    source_type: "comune_avvisi", category: "alienazioni",
    allowed_paths: ["/Amministrazione-Trasparente/Bandi", "/Amministrazione/Aree-amministrative-e-Direzioni/Direzione-Patrimonio", "/Servizi/Acquisizione", "/Servizi/Concessione-patrimoniale"],
    excluded_paths: X(["/nqcontent.cfm", "/concorsi", "/Concorsi"]),
    keywords: ["alienazione", "patrimonio", "vendita immobile", "asta pubblica", "concessione"],
    max_depth: 2, max_pages: 15, crawl_method: "firecrawl",
    priority: 5, expected_signals: ["public_asset_signal", "alienation_signal"],
    compliance_notes: "Avvisi pubblici",
    enabled: true,
  },

  // ─── VICENZA ───────────────────────────────────────────────
  // Vecchio comune.vicenza.it/aree/* e /albo/* ritornano kernel error 410.
  // Contenuti reali su servizi2.comune.vicenza.it (utilita/documento.php, albo3/altri.php).
  {
    source_key: "vicenza-urbanistica",
    source_name: "Comune di Vicenza — Urbanistica e Piano degli Interventi",
    base_url: "https://servizi2.comune.vicenza.it/amministrazione/trasparente/cmsammtrasparente.php/pianificazione_e_governo_del_territorio",
    comune: "Vicenza", provincia: "VI",
    source_type: "comune_urbanistica", category: "piano_interventi",
    allowed_paths: ["/amministrazione/trasparente", "/utilita/documento.php"],
    excluded_paths: X(["/albo/bandi.php", "/aree/a_urbanistica"]),
    keywords: ["piano interventi", "PI", "variante", "PAT", "urbanistica"],
    max_depth: 2, max_pages: 20, crawl_method: "firecrawl",
    priority: 5, expected_signals: ["urban_planning_signal"],
    compliance_notes: "Portale istituzionale servizi2",
    enabled: true,
  },
  {
    source_key: "vicenza-patrimonio",
    source_name: "Comune di Vicenza — Beni Immobili e Bandi Alienazione",
    base_url: "https://servizi2.comune.vicenza.it/amministrazione/trasparente/cmsammtrasparente.php/beni_immobili_e_gestione_patrimonio",
    comune: "Vicenza", provincia: "VI",
    source_type: "comune_albo", category: "alienazioni",
    allowed_paths: ["/amministrazione/trasparente", "/albo3/altri.php", "/utilita/documento.php"],
    excluded_paths: X(["/albo/bandi.php", "/concorsi/"]),
    keywords: ["alienazione", "patrimonio", "vendita immobile", "asta pubblica", "bando"],
    max_depth: 2, max_pages: 15, crawl_method: "firecrawl",
    priority: 4, expected_signals: ["public_asset_signal", "alienation_signal"],
    compliance_notes: "Albo pretorio pubblico servizi2",
    enabled: true,
  },

  // ─── TREVISO ───────────────────────────────────────────────
  // Treviso usa myPortal (Regione Veneto): URL reali sotto /amministrazionetrasparente/_18_*.
  {
    source_key: "treviso-urbanistica",
    source_name: "Comune di Treviso — Pianificazione e Governo del Territorio",
    base_url: "https://www.comune.treviso.it/amministrazionetrasparente/_18_pianificazione_e_governo_del_territorio",
    comune: "Treviso", provincia: "TV",
    source_type: "comune_urbanistica", category: "urbanistica",
    allowed_paths: ["/amministrazionetrasparente/_18_pianificazione", "/myportal/C_L407"],
    excluded_paths: X(["/sitemap.xml", "/sitemap"]),
    keywords: ["PAT", "PI", "piano degli interventi", "variante", "rigenerazione"],
    max_depth: 2, max_pages: 20, crawl_method: "firecrawl",
    priority: 5, expected_signals: ["urban_planning_signal"],
    compliance_notes: "Portale istituzionale myPortal",
    enabled: true,
  },
  {
    source_key: "treviso-opere-pubbliche",
    source_name: "Comune di Treviso — Opere Pubbliche",
    base_url: "https://www.comune.treviso.it/amministrazionetrasparente/_19_opere_pubbliche",
    comune: "Treviso", provincia: "TV",
    source_type: "comune_avvisi", category: "opere_pubbliche",
    allowed_paths: ["/amministrazionetrasparente/_19_opere_pubbliche", "/myportal/C_L407"],
    excluded_paths: X(["/sitemap.xml", "/sitemap"]),
    keywords: ["opere pubbliche", "cantiere", "lavori", "riqualificazione", "programma triennale"],
    max_depth: 2, max_pages: 15, crawl_method: "firecrawl",
    priority: 4, expected_signals: ["public_work_signal"],
    compliance_notes: "Portale istituzionale myPortal",
    enabled: true,
  },

  // ─── BELLUNO ───────────────────────────────────────────────
  {
    source_key: "belluno-urbanistica",
    source_name: "Comune di Belluno — Urbanistica e Lavori Pubblici",
    base_url: "https://www.comune.belluno.it/web/belluno/urbanistica",
    comune: "Belluno", provincia: "BL",
    source_type: "comune_urbanistica", category: "urbanistica",
    allowed_paths: ["/web/belluno/urbanistica", "/web/belluno/lavori"],
    excluded_paths: X(),
    keywords: ["PAT", "PI", "variante", "lavori pubblici", "rigenerazione"],
    max_depth: 2, max_pages: 18, crawl_method: "firecrawl",
    priority: 4, expected_signals: ["urban_planning_signal", "public_work_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },

  // ─── ROVIGO ────────────────────────────────────────────────
  {
    source_key: "rovigo-urbanistica-patrimonio",
    source_name: "Comune di Rovigo — Urbanistica e Patrimonio",
    base_url: "https://www.comune.rovigo.it/myportal/C_H620/home",
    comune: "Rovigo", provincia: "RO",
    source_type: "comune_urbanistica", category: "urbanistica",
    allowed_paths: ["/myportal/C_H620"],
    excluded_paths: X(),
    keywords: ["urbanistica", "PAT", "PI", "patrimonio", "alienazione"],
    max_depth: 2, max_pages: 18, crawl_method: "firecrawl",
    priority: 4, expected_signals: ["urban_planning_signal", "public_asset_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },

  // ─── JESOLO (turismo) ──────────────────────────────────────
  {
    source_key: "jesolo-turismo-urbanistica",
    source_name: "Comune di Jesolo — Urbanistica e Turismo",
    base_url: "https://www.comune.jesolo.ve.it/",
    comune: "Jesolo", provincia: "VE",
    source_type: "comune_news", category: "turismo",
    allowed_paths: ["/urbanistica", "/turismo", "/lavori-pubblici"],
    excluded_paths: X(),
    keywords: ["PAT", "PI", "turismo", "stagione balneare", "rigenerazione"],
    max_depth: 2, max_pages: 15, crawl_method: "firecrawl",
    priority: 4, expected_signals: ["tourism_pressure_signal", "urban_planning_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },

  // ─── CHIOGGIA ──────────────────────────────────────────────
  {
    source_key: "chioggia-urbanistica-mobilita",
    source_name: "Comune di Chioggia — Urbanistica/Mobilità/Turismo",
    base_url: "https://www.chioggia.org/",
    comune: "Chioggia", provincia: "VE",
    source_type: "comune_news", category: "urbanistica",
    allowed_paths: ["/urbanistica", "/mobilita", "/turismo"],
    excluded_paths: X(),
    keywords: ["PAT", "PI", "mobilità", "turismo", "rigenerazione"],
    max_depth: 2, max_pages: 12, crawl_method: "firecrawl",
    priority: 3, expected_signals: ["urban_planning_signal", "mobility_signal", "tourism_pressure_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },

  // ─── BASSANO DEL GRAPPA ────────────────────────────────────
  {
    source_key: "bassano-urbanistica",
    source_name: "Comune di Bassano del Grappa — Urbanistica",
    base_url: "https://www.comune.bassano.vi.it/",
    comune: "Bassano del Grappa", provincia: "VI",
    source_type: "comune_urbanistica", category: "urbanistica",
    allowed_paths: ["/urbanistica", "/lavori-pubblici"],
    excluded_paths: X(),
    keywords: ["PAT", "PI", "variante", "lavori pubblici"],
    max_depth: 2, max_pages: 12, crawl_method: "firecrawl",
    priority: 3, expected_signals: ["urban_planning_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },

  // ─── SCHIO / THIENE / ARZIGNANO / MONTECCHIO ───────────────
  {
    source_key: "schio-urbanistica",
    source_name: "Comune di Schio — Urbanistica/Patrimonio",
    base_url: "https://www.comune.schio.vi.it/",
    comune: "Schio", provincia: "VI",
    source_type: "comune_urbanistica", category: "urbanistica",
    allowed_paths: ["/urbanistica", "/patrimonio", "/lavori-pubblici"],
    excluded_paths: X(),
    keywords: ["PAT", "PI", "patrimonio", "alienazione"],
    max_depth: 2, max_pages: 12, crawl_method: "firecrawl",
    priority: 3, expected_signals: ["urban_planning_signal", "public_asset_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },
  {
    source_key: "thiene-urbanistica",
    source_name: "Comune di Thiene — Urbanistica/Patrimonio",
    base_url: "https://www.comune.thiene.vi.it/",
    comune: "Thiene", provincia: "VI",
    source_type: "comune_urbanistica", category: "urbanistica",
    allowed_paths: ["/urbanistica", "/patrimonio"],
    excluded_paths: X(),
    keywords: ["PAT", "PI", "patrimonio", "alienazione"],
    max_depth: 2, max_pages: 10, crawl_method: "firecrawl",
    priority: 3, expected_signals: ["urban_planning_signal", "public_asset_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },
  {
    source_key: "arzignano-urbanistica",
    source_name: "Comune di Arzignano — Urbanistica",
    base_url: "https://www.comune.arzignano.vi.it/",
    comune: "Arzignano", provincia: "VI",
    source_type: "comune_urbanistica", category: "urbanistica",
    allowed_paths: ["/urbanistica", "/patrimonio"],
    excluded_paths: X(),
    keywords: ["PAT", "PI", "patrimonio"],
    max_depth: 2, max_pages: 10, crawl_method: "firecrawl",
    priority: 2, expected_signals: ["urban_planning_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },
  {
    source_key: "montecchio-urbanistica",
    source_name: "Comune di Montecchio Maggiore — Urbanistica",
    base_url: "https://www.comune.montecchio-maggiore.vi.it/",
    comune: "Montecchio Maggiore", provincia: "VI",
    source_type: "comune_urbanistica", category: "urbanistica",
    allowed_paths: ["/urbanistica", "/patrimonio"],
    excluded_paths: X(),
    keywords: ["PAT", "PI", "patrimonio"],
    max_depth: 2, max_pages: 10, crawl_method: "firecrawl",
    priority: 2, expected_signals: ["urban_planning_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },

  // ─── CONEGLIANO / CASTELFRANCO / VITTORIO VENETO ───────────
  {
    source_key: "conegliano-urbanistica",
    source_name: "Comune di Conegliano — Urbanistica",
    base_url: "https://www.comune.conegliano.tv.it/",
    comune: "Conegliano", provincia: "TV",
    source_type: "comune_urbanistica", category: "urbanistica",
    allowed_paths: ["/urbanistica", "/patrimonio", "/lavori-pubblici"],
    excluded_paths: X(),
    keywords: ["PAT", "PI", "rigenerazione", "patrimonio"],
    max_depth: 2, max_pages: 12, crawl_method: "firecrawl",
    priority: 3, expected_signals: ["urban_planning_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },
  {
    source_key: "castelfranco-urbanistica",
    source_name: "Comune di Castelfranco Veneto — Urbanistica",
    base_url: "https://www.comune.castelfrancoveneto.tv.it/",
    comune: "Castelfranco Veneto", provincia: "TV",
    source_type: "comune_urbanistica", category: "urbanistica",
    allowed_paths: ["/urbanistica", "/patrimonio"],
    excluded_paths: X(),
    keywords: ["PAT", "PI", "patrimonio"],
    max_depth: 2, max_pages: 10, crawl_method: "firecrawl",
    priority: 3, expected_signals: ["urban_planning_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },
  {
    source_key: "vittorio-veneto-urbanistica",
    source_name: "Comune di Vittorio Veneto — Urbanistica",
    base_url: "https://www.comune.vittorio-veneto.tv.it/",
    comune: "Vittorio Veneto", provincia: "TV",
    source_type: "comune_urbanistica", category: "urbanistica",
    allowed_paths: ["/urbanistica", "/patrimonio"],
    excluded_paths: X(),
    keywords: ["PAT", "PI", "patrimonio", "rigenerazione"],
    max_depth: 2, max_pages: 10, crawl_method: "firecrawl",
    priority: 3, expected_signals: ["urban_planning_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },

  // ─── ABANO / MONTEGROTTO (turismo termale) ────────────────
  {
    source_key: "abano-turismo-urbanistica",
    source_name: "Comune di Abano Terme — Urbanistica/Turismo/Verde",
    base_url: "https://www.abanoterme.net/",
    comune: "Abano Terme", provincia: "PD",
    source_type: "comune_news", category: "turismo",
    allowed_paths: ["/urbanistica", "/turismo", "/verde", "/lavori-pubblici"],
    excluded_paths: X(),
    keywords: ["turismo termale", "PAT", "PI", "verde pubblico", "rigenerazione"],
    max_depth: 2, max_pages: 12, crawl_method: "firecrawl",
    priority: 3, expected_signals: ["tourism_pressure_signal", "urban_planning_signal", "green_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },
  {
    source_key: "montegrotto-turismo-urbanistica",
    source_name: "Comune di Montegrotto Terme — Urbanistica/Turismo",
    base_url: "https://www.comune.montegrotto-terme.pd.it/",
    comune: "Montegrotto Terme", provincia: "PD",
    source_type: "comune_news", category: "turismo",
    allowed_paths: ["/urbanistica", "/turismo", "/verde"],
    excluded_paths: X(),
    keywords: ["turismo termale", "PAT", "PI", "verde", "rigenerazione"],
    max_depth: 2, max_pages: 10, crawl_method: "firecrawl",
    priority: 3, expected_signals: ["tourism_pressure_signal", "urban_planning_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },
];

export function selectOffMarketSources(opts: {
  categories?: OffMarketCategory[];
  comuni?: string[];
  province?: string[];
  maxSources?: number;
}): OffMarketFirecrawlSource[] {
  const cats = opts.categories?.length ? new Set(opts.categories) : null;
  const comuni = opts.comuni?.length ? new Set(opts.comuni.map((c) => c.toLowerCase())) : null;
  const prov = opts.province?.length ? new Set(opts.province.map((p) => p.toUpperCase())) : null;

  const filtered = OFFMARKET_FIRECRAWL_REGISTRY.filter((s) => {
    if (!s.enabled) return false;
    if (cats && !cats.has(s.category)) return false;
    if (comuni && !comuni.has(s.comune.toLowerCase())) return false;
    if (prov && !prov.has(s.provincia.toUpperCase())) return false;
    return true;
  });

  filtered.sort((a, b) => b.priority - a.priority);
  return opts.maxSources && opts.maxSources > 0 ? filtered.slice(0, opts.maxSources) : filtered;
}
