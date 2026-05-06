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
    base_url: "https://www.padovanet.it/informazione/urbanistica",
    comune: "Padova", provincia: "PD",
    source_type: "comune_urbanistica", category: "urbanistica",
    allowed_paths: ["/informazione/urbanistica", "/informazione/piano"],
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
    base_url: "https://www.padovanet.it/informazione/lavori-pubblici",
    comune: "Padova", provincia: "PD",
    source_type: "comune_avvisi", category: "opere_pubbliche",
    allowed_paths: ["/informazione/lavori-pubblici", "/informazione/cantieri"],
    excluded_paths: X(),
    keywords: ["cantiere", "appalto", "lavori pubblici", "riqualificazione"],
    max_depth: 2, max_pages: 20, crawl_method: "firecrawl",
    priority: 4, expected_signals: ["public_work_signal"],
    compliance_notes: "Pagine pubbliche istituzionali",
    enabled: true,
  },
  {
    source_key: "padova-patrimonio-alienazioni",
    source_name: "Comune di Padova — Patrimonio e Alienazioni",
    base_url: "https://www.padovanet.it/informazione/avvisi-aste-immobiliari-e-bandi-di-alienazione",
    comune: "Padova", provincia: "PD",
    source_type: "comune_avvisi", category: "alienazioni",
    allowed_paths: ["/informazione/avvisi", "/informazione/patrimonio"],
    excluded_paths: X(),
    keywords: ["alienazione", "patrimonio comunale", "vendita immobile", "asta pubblica"],
    max_depth: 2, max_pages: 20, crawl_method: "firecrawl",
    priority: 5, expected_signals: ["public_asset_signal", "alienation_signal"],
    compliance_notes: "Avvisi pubblici di alienazione patrimonio comunale",
    enabled: true,
  },

  // ─── VENEZIA / MESTRE ──────────────────────────────────────
  {
    source_key: "venezia-urbanistica",
    source_name: "Comune di Venezia — Pianificazione Urbanistica",
    base_url: "https://www.comune.venezia.it/it/pianificazione-territoriale",
    comune: "Venezia", provincia: "VE",
    source_type: "comune_urbanistica", category: "urbanistica",
    allowed_paths: ["/it/pianificazione", "/it/urbanistica", "/it/content/piano"],
    excluded_paths: X(),
    keywords: ["PAT", "PI", "variante", "PUMS", "rigenerazione"],
    max_depth: 2, max_pages: 25, crawl_method: "firecrawl",
    priority: 5, expected_signals: ["urban_planning_signal", "regeneration_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },
  {
    source_key: "venezia-mobilita-pums",
    source_name: "Comune di Venezia — Mobilità e PUMS",
    base_url: "https://www.comune.venezia.it/it/mobilita",
    comune: "Venezia", provincia: "VE",
    source_type: "comune_news", category: "mobilita",
    allowed_paths: ["/it/mobilita", "/it/content/pums"],
    excluded_paths: X(),
    keywords: ["PUMS", "mobilità sostenibile", "tram", "ZTL", "isola pedonale"],
    max_depth: 2, max_pages: 15, crawl_method: "firecrawl",
    priority: 4, expected_signals: ["mobility_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },
  {
    source_key: "venezia-patrimonio",
    source_name: "Comune di Venezia — Patrimonio e Avvisi",
    base_url: "https://www.comune.venezia.it/it/avvisi-bandi-gare",
    comune: "Venezia", provincia: "VE",
    source_type: "comune_avvisi", category: "patrimonio_pubblico",
    allowed_paths: ["/it/avvisi", "/it/bandi", "/it/content/patrimonio"],
    excluded_paths: X(["/concorsi/"]),
    keywords: ["alienazione", "patrimonio", "vendita immobile", "concessione"],
    max_depth: 2, max_pages: 20, crawl_method: "firecrawl",
    priority: 5, expected_signals: ["public_asset_signal", "alienation_signal"],
    compliance_notes: "Avvisi pubblici",
    enabled: true,
  },
  {
    source_key: "venezia-turismo",
    source_name: "Comune di Venezia — Turismo e Contributo Accesso",
    base_url: "https://www.comune.venezia.it/it/turismo",
    comune: "Venezia", provincia: "VE",
    source_type: "comune_news", category: "turismo",
    allowed_paths: ["/it/turismo", "/it/content/contributo-accesso"],
    excluded_paths: X(),
    keywords: ["contributo accesso", "turismo", "flussi turistici", "regolamento turistico"],
    max_depth: 2, max_pages: 12, crawl_method: "firecrawl",
    priority: 4, expected_signals: ["tourism_pressure_signal"],
    compliance_notes: "Pagine pubbliche aggregate",
    enabled: true,
  },

  // ─── VERONA ────────────────────────────────────────────────
  {
    source_key: "verona-urbanistica",
    source_name: "Comune di Verona — Urbanistica",
    base_url: "https://www.comune.verona.it/nqcontent.cfm?a_id=42",
    comune: "Verona", provincia: "VR",
    source_type: "comune_urbanistica", category: "urbanistica",
    allowed_paths: ["/nqcontent.cfm"],
    excluded_paths: X(),
    keywords: ["PAT", "PI", "variante urbanistica", "rigenerazione", "comparto"],
    max_depth: 2, max_pages: 20, crawl_method: "firecrawl",
    priority: 5, expected_signals: ["urban_planning_signal", "regeneration_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },
  {
    source_key: "verona-opere-pubbliche",
    source_name: "Comune di Verona — Lavori Pubblici",
    base_url: "https://www.comune.verona.it/nqcontent.cfm?a_id=2117",
    comune: "Verona", provincia: "VR",
    source_type: "comune_avvisi", category: "opere_pubbliche",
    allowed_paths: ["/nqcontent.cfm"],
    excluded_paths: X(),
    keywords: ["lavori pubblici", "cantiere", "opere", "riqualificazione"],
    max_depth: 2, max_pages: 15, crawl_method: "firecrawl",
    priority: 4, expected_signals: ["public_work_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },
  {
    source_key: "verona-patrimonio",
    source_name: "Comune di Verona — Patrimonio e Alienazioni",
    base_url: "https://www.comune.verona.it/nqcontent.cfm?a_id=12",
    comune: "Verona", provincia: "VR",
    source_type: "comune_avvisi", category: "alienazioni",
    allowed_paths: ["/nqcontent.cfm"],
    excluded_paths: X(),
    keywords: ["alienazione", "patrimonio", "vendita immobile", "asta pubblica"],
    max_depth: 2, max_pages: 15, crawl_method: "firecrawl",
    priority: 5, expected_signals: ["public_asset_signal", "alienation_signal"],
    compliance_notes: "Avvisi pubblici",
    enabled: true,
  },

  // ─── VICENZA ───────────────────────────────────────────────
  {
    source_key: "vicenza-urbanistica",
    source_name: "Comune di Vicenza — Urbanistica e PI",
    base_url: "https://www.comune.vicenza.it/aree/a_urbanistica/index.php",
    comune: "Vicenza", provincia: "VI",
    source_type: "comune_urbanistica", category: "piano_interventi",
    allowed_paths: ["/aree/a_urbanistica", "/uffici/cms"],
    excluded_paths: X(),
    keywords: ["piano interventi", "PI", "variante", "PAT"],
    max_depth: 2, max_pages: 20, crawl_method: "firecrawl",
    priority: 5, expected_signals: ["urban_planning_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },
  {
    source_key: "vicenza-patrimonio",
    source_name: "Comune di Vicenza — Patrimonio e Bandi",
    base_url: "https://www.comune.vicenza.it/albo/bandi.php",
    comune: "Vicenza", provincia: "VI",
    source_type: "comune_albo", category: "alienazioni",
    allowed_paths: ["/albo/bandi", "/aree/a_patrimonio"],
    excluded_paths: X(["/concorsi/"]),
    keywords: ["alienazione", "patrimonio", "vendita immobile"],
    max_depth: 2, max_pages: 15, crawl_method: "firecrawl",
    priority: 4, expected_signals: ["public_asset_signal", "alienation_signal"],
    compliance_notes: "Albo pretorio pubblico",
    enabled: true,
  },

  // ─── TREVISO ───────────────────────────────────────────────
  {
    source_key: "treviso-urbanistica",
    source_name: "Comune di Treviso — Urbanistica",
    base_url: "https://www.comune.treviso.it/urbanistica/",
    comune: "Treviso", provincia: "TV",
    source_type: "comune_urbanistica", category: "urbanistica",
    allowed_paths: ["/urbanistica", "/pat", "/pi"],
    excluded_paths: X(),
    keywords: ["PAT", "PI", "variante", "rigenerazione"],
    max_depth: 2, max_pages: 20, crawl_method: "firecrawl",
    priority: 5, expected_signals: ["urban_planning_signal"],
    compliance_notes: "Portale istituzionale",
    enabled: true,
  },
  {
    source_key: "treviso-opere-pubbliche",
    source_name: "Comune di Treviso — Opere Pubbliche",
    base_url: "https://www.comune.treviso.it/lavoripubblici/",
    comune: "Treviso", provincia: "TV",
    source_type: "comune_avvisi", category: "opere_pubbliche",
    allowed_paths: ["/lavoripubblici", "/cantieri"],
    excluded_paths: X(),
    keywords: ["cantiere", "lavori pubblici", "riqualificazione"],
    max_depth: 2, max_pages: 15, crawl_method: "firecrawl",
    priority: 4, expected_signals: ["public_work_signal"],
    compliance_notes: "Portale istituzionale",
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
