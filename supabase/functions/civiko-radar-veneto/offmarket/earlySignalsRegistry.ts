// ═══════════════════════════════════════════════════════════════
// Early Off-Market Signals — Registry fonti istituzionali Veneto.
// Solo URL pubblici, no login/SPID/CIE/dati personali.
// Categorie: pre_alienation, public_asset, urban_regeneration,
// zoning_change, public_work, mobility_change, tourism_pressure,
// expression_of_interest, concession_or_lease, project_financing,
// redevelopment_area, municipal_asset_strategy.
// ═══════════════════════════════════════════════════════════════

export type EarlyCategory =
  | "pre_alienation"
  | "public_asset"
  | "urban_regeneration"
  | "zoning_change"
  | "public_work"
  | "mobility_change"
  | "tourism_pressure"
  | "expression_of_interest"
  | "concession_or_lease"
  | "project_financing"
  | "redevelopment_area"
  | "municipal_asset_strategy";

export type CrawlMethod = "firecrawl" | "apify" | "direct_fetch" | "perplexity_discovery";

export interface EarlySignalSource {
  source_key: string;
  source_name: string;
  base_url: string;
  comune: string;
  provincia: string;
  categories: EarlyCategory[];
  allowed_paths: string[];
  excluded_paths: string[];
  crawl_method: CrawlMethod;
  max_pages: number;
  max_depth: number;
  priority: number; // 1 highest
  enabled: boolean;
  compliance_status: "ok" | "review";
  notes?: string;
}

// Excluded paths comuni a tutte le fonti (privacy-by-design)
export const GLOBAL_EXCLUDED_PATHS: string[] = [
  "/login", "/auth", "/spid", "/cie", "/anagrafe", "/stato-civile",
  "/necrologi", "/decessi", "/funebr", "/cimiter",
  "/personale", "/dipendenti", "/curriculum", "/cv-",
  "/privacy", "/cookie", "/admin", "/wp-admin",
  "/concorsi", // selezioni personali
];

function S(extra: string[] = []): string[] {
  return [...GLOBAL_EXCLUDED_PATHS, ...extra];
}

export const EARLY_SIGNALS_REGISTRY: EarlySignalSource[] = [
  // ── Padova ──
  {
    source_key: "padova-urbanistica",
    source_name: "Comune di Padova — Urbanistica",
    base_url: "https://www.padovanet.it/informazione/urbanistica",
    comune: "Padova", provincia: "PD",
    categories: ["zoning_change","urban_regeneration"],
    allowed_paths: ["/informazione/urbanistica","/informazione/piano"],
    excluded_paths: S(),
    crawl_method: "firecrawl", max_pages: 5, max_depth: 2, priority: 1, enabled: true, compliance_status: "ok",
  },
  {
    source_key: "padova-patrimonio",
    source_name: "Comune di Padova — Patrimonio e Alienazioni",
    base_url: "https://www.padovanet.it/informazione/alienazione-immobili",
    comune: "Padova", provincia: "PD",
    categories: ["pre_alienation","public_asset","municipal_asset_strategy"],
    allowed_paths: ["/informazione/alienazion","/informazione/patrimoni","/informazione/bandi"],
    excluded_paths: S(),
    crawl_method: "firecrawl", max_pages: 5, max_depth: 2, priority: 1, enabled: true, compliance_status: "ok",
  },
  {
    source_key: "padova-opere-pubbliche",
    source_name: "Comune di Padova — Opere Pubbliche",
    base_url: "https://www.padovanet.it/informazione/lavori-pubblici",
    comune: "Padova", provincia: "PD",
    categories: ["public_work","mobility_change"],
    allowed_paths: ["/informazione/lavori-pubblici","/informazione/opere"],
    excluded_paths: S(),
    crawl_method: "firecrawl", max_pages: 5, max_depth: 2, priority: 2, enabled: true, compliance_status: "ok",
  },

  // ── Venezia ──
  {
    source_key: "venezia-urbanistica",
    source_name: "Comune di Venezia — Urbanistica",
    base_url: "https://www.comune.venezia.it/it/content/urbanistica",
    comune: "Venezia", provincia: "VE",
    categories: ["zoning_change","urban_regeneration"],
    allowed_paths: ["/content/urbanistica","/content/piano","/content/variant"],
    excluded_paths: S(),
    crawl_method: "firecrawl", max_pages: 5, max_depth: 2, priority: 1, enabled: true, compliance_status: "ok",
  },
  {
    source_key: "venezia-patrimonio",
    source_name: "Comune di Venezia — Patrimonio/Alienazioni",
    base_url: "https://www.comune.venezia.it/it/content/patrimonio-immobiliare",
    comune: "Venezia", provincia: "VE",
    categories: ["pre_alienation","public_asset","municipal_asset_strategy","concession_or_lease"],
    allowed_paths: ["/content/patrimonio","/content/aliena","/content/bando","/content/avviso"],
    excluded_paths: S(),
    crawl_method: "firecrawl", max_pages: 5, max_depth: 2, priority: 1, enabled: true, compliance_status: "ok",
  },
  {
    source_key: "venezia-mobilita",
    source_name: "Comune di Venezia — Mobilità e Contributo Accesso",
    base_url: "https://www.comune.venezia.it/it/content/mobilita",
    comune: "Venezia", provincia: "VE",
    categories: ["mobility_change","tourism_pressure"],
    allowed_paths: ["/content/mobilita","/content/contributo-accesso"],
    excluded_paths: S(),
    crawl_method: "firecrawl", max_pages: 4, max_depth: 1, priority: 2, enabled: true, compliance_status: "ok",
  },

  // ── Verona ──
  {
    source_key: "verona-alienazioni",
    source_name: "Comune di Verona — Alienazione Beni Immobili",
    base_url: "https://www.comune.verona.it/nqcontent.cfm?a_id=1665",
    comune: "Verona", provincia: "VR",
    categories: ["pre_alienation","public_asset","municipal_asset_strategy"],
    allowed_paths: ["/nqcontent.cfm"],
    excluded_paths: S(),
    crawl_method: "firecrawl", max_pages: 5, max_depth: 1, priority: 1, enabled: true, compliance_status: "ok",
    notes: "URL legacy CFM, usare anche perplexity discovery come fallback",
  },
  {
    source_key: "verona-pianificazione",
    source_name: "Comune di Verona — Pianificazione Urbanistica",
    base_url: "https://www.comune.verona.it/nqcontent.cfm?a_id=39",
    comune: "Verona", provincia: "VR",
    categories: ["zoning_change","urban_regeneration"],
    allowed_paths: ["/nqcontent.cfm"],
    excluded_paths: S(),
    crawl_method: "firecrawl", max_pages: 5, max_depth: 1, priority: 2, enabled: true, compliance_status: "ok",
  },

  // ── Vicenza ──
  {
    source_key: "vicenza-patrimonio",
    source_name: "Comune di Vicenza — Patrimonio Immobiliare",
    base_url: "https://www.comune.vicenza.it/albo3/notizie.php/186_patrimonio_immobiliare",
    comune: "Vicenza", provincia: "VI",
    categories: ["pre_alienation","public_asset","municipal_asset_strategy"],
    allowed_paths: ["/albo3","/utilita/documento.php","/amministrazione/trasparente"],
    excluded_paths: S(["/albo/bandi.php"]),
    crawl_method: "firecrawl", max_pages: 5, max_depth: 1, priority: 1, enabled: true, compliance_status: "ok",
  },
  {
    source_key: "vicenza-pianificazione",
    source_name: "Comune di Vicenza — Pianificazione e Governo del Territorio",
    base_url: "https://servizi2.comune.vicenza.it/amministrazione/trasparente/cmsammtrasparente.php/pianificazione_e_governo_del_territorio",
    comune: "Vicenza", provincia: "VI",
    categories: ["zoning_change","urban_regeneration"],
    allowed_paths: ["/amministrazione/trasparente"],
    excluded_paths: S(),
    crawl_method: "firecrawl", max_pages: 5, max_depth: 1, priority: 2, enabled: true, compliance_status: "ok",
  },

  // ── Treviso ──
  {
    source_key: "treviso-urbanistica",
    source_name: "Comune di Treviso — Urbanistica",
    base_url: "https://www.comune.treviso.it/urbanistica/",
    comune: "Treviso", provincia: "TV",
    categories: ["zoning_change","urban_regeneration","redevelopment_area"],
    allowed_paths: ["/urbanistica","/lavori","/patrimonio","/bandi","/news"],
    excluded_paths: S(),
    crawl_method: "firecrawl", max_pages: 5, max_depth: 2, priority: 1, enabled: true, compliance_status: "ok",
  },
  {
    source_key: "treviso-patrimonio",
    source_name: "Comune di Treviso — Patrimonio/Alienazioni",
    base_url: "https://www.comune.treviso.it/patrimonio/",
    comune: "Treviso", provincia: "TV",
    categories: ["pre_alienation","public_asset"],
    allowed_paths: ["/patrimonio","/bandi","/avvisi"],
    excluded_paths: S(),
    crawl_method: "firecrawl", max_pages: 4, max_depth: 1, priority: 2, enabled: true, compliance_status: "ok",
  },

  // ── Belluno ──
  {
    source_key: "belluno-urbanistica",
    source_name: "Comune di Belluno — Urbanistica",
    base_url: "https://www.comune.belluno.it/myportal/C_A757/home",
    comune: "Belluno", provincia: "BL",
    categories: ["zoning_change","urban_regeneration","public_work"],
    allowed_paths: ["/myportal/C_A757"],
    excluded_paths: S(),
    crawl_method: "firecrawl", max_pages: 4, max_depth: 1, priority: 3, enabled: true, compliance_status: "ok",
  },

  // ── Rovigo ──
  {
    source_key: "rovigo-urbanistica",
    source_name: "Comune di Rovigo — Urbanistica",
    base_url: "https://www.comune.rovigo.it/web/rovigo/urbanistica",
    comune: "Rovigo", provincia: "RO",
    categories: ["zoning_change","urban_regeneration","public_asset"],
    allowed_paths: ["/web/rovigo/urbanistica","/web/rovigo/patrimoni","/web/rovigo/bandi"],
    excluded_paths: S(),
    crawl_method: "firecrawl", max_pages: 4, max_depth: 1, priority: 3, enabled: true, compliance_status: "ok",
  },

  // ── Località turistiche ──
  {
    source_key: "jesolo-urbanistica",
    source_name: "Comune di Jesolo — Urbanistica/Rigenerazione",
    base_url: "https://www.comune.jesolo.ve.it/urbanistica",
    comune: "Jesolo", provincia: "VE",
    categories: ["urban_regeneration","tourism_pressure","zoning_change"],
    allowed_paths: ["/urbanistica","/lavori-pubblici","/bandi"],
    excluded_paths: S(),
    crawl_method: "firecrawl", max_pages: 4, max_depth: 1, priority: 2, enabled: true, compliance_status: "ok",
  },
  {
    source_key: "chioggia-urbanistica",
    source_name: "Comune di Chioggia — Urbanistica/Mobilità",
    base_url: "https://www.chioggia.org/urbanistica",
    comune: "Chioggia", provincia: "VE",
    categories: ["urban_regeneration","mobility_change","tourism_pressure"],
    allowed_paths: ["/urbanistica","/lavori","/bandi"],
    excluded_paths: S(),
    crawl_method: "firecrawl", max_pages: 4, max_depth: 1, priority: 3, enabled: true, compliance_status: "ok",
  },
  {
    source_key: "abano-urbanistica",
    source_name: "Comune di Abano Terme — Urbanistica/Turismo",
    base_url: "https://www.abanoterme.net/urbanistica",
    comune: "Abano Terme", provincia: "PD",
    categories: ["urban_regeneration","tourism_pressure"],
    allowed_paths: ["/urbanistica","/bandi"],
    excluded_paths: S(),
    crawl_method: "firecrawl", max_pages: 3, max_depth: 1, priority: 3, enabled: true, compliance_status: "ok",
  },

  // ── Regione Veneto / Demanio ──
  {
    source_key: "regione-veneto-bandi",
    source_name: "Regione Veneto — Bandi e Avvisi",
    base_url: "https://bandi.regione.veneto.it/Public/Elenco",
    comune: "Veneto", provincia: "VEN",
    categories: ["expression_of_interest","project_financing","public_asset"],
    allowed_paths: ["/Public"],
    excluded_paths: S(),
    crawl_method: "firecrawl", max_pages: 5, max_depth: 1, priority: 1, enabled: true, compliance_status: "ok",
  },
  {
    source_key: "demanio-vendite",
    source_name: "Agenzia del Demanio — Vendite e Valorizzazioni",
    base_url: "https://www.agenziademanio.it/it/avvisi-e-bandi/vendita/",
    comune: "Veneto", provincia: "VEN",
    categories: ["pre_alienation","public_asset","public_asset","municipal_asset_strategy"],
    allowed_paths: ["/avvisi-e-bandi","/vendita","/valorizzazione"],
    excluded_paths: S(),
    crawl_method: "firecrawl", max_pages: 5, max_depth: 1, priority: 1, enabled: true, compliance_status: "ok",
  },
];

export function selectEarlySources(opts: {
  comuni?: string[];
  categories?: EarlyCategory[];
  maxSources?: number;
}): EarlySignalSource[] {
  const comuniLow = (opts.comuni ?? []).map((c) => c.toLowerCase());
  const cats = new Set(opts.categories ?? []);
  let list = EARLY_SIGNALS_REGISTRY.filter((s) => s.enabled);
  if (comuniLow.length > 0) list = list.filter((s) => comuniLow.includes(s.comune.toLowerCase()));
  if (cats.size > 0) list = list.filter((s) => s.categories.some((c) => cats.has(c)));
  list.sort((a, b) => a.priority - b.priority);
  return opts.maxSources ? list.slice(0, opts.maxSources) : list;
}
