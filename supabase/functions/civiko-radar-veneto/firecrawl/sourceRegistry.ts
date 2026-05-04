// ═══════════════════════════════════════════════════════════════
// Registry fonti Firecrawl per il Veneto.
// Solo fonti pubbliche, consultabili senza login/CAPTCHA/paywall.
// Sezioni "Amministrazione Trasparente" sono pubbliche ex D.Lgs. 33/2013.
// ═══════════════════════════════════════════════════════════════
export type SourceType =
  | "auctions" | "ivg" | "pvp" | "open_data" | "urban_planning"
  | "public_works" | "municipal_notices" | "real_estate_market"
  | "infrastructure" | "public_assets";

export interface FirecrawlSource {
  source_name: string;
  base_url: string;
  source_type: SourceType;
  province: string[];
  comuni?: string[];
  priority: number;             // 1-100
  crawl_depth: number;          // 0 scrape, 1 map+scrape primi N
  max_pages: number;
  allowed_paths?: string[];
  excluded_paths?: string[];
  expected_entities: string[];
  reliability_score: number;
  freshness_score: number;
  allowed_use?: string;         // libera | trasparenza | open_data
  notes?: string;
}

// ═══════════════════════════════════════════════════════════════
// IVG / PVP / portali aste pubblici
// ═══════════════════════════════════════════════════════════════
const AUCTION_SOURCES: FirecrawlSource[] = [
  {
    source_name: "pvp_giustizia_veneto",
    base_url: "https://pvp.giustizia.it/pvp/it/risultati_ricerca.page",
    source_type: "pvp",
    province: ["VE","VR","VI","PD","TV","BL","RO"],
    priority: 96, crawl_depth: 0, max_pages: 1,
    expected_entities: ["aste","tribunale","prezzo_base","data_vendita","lotto"],
    reliability_score: 98, freshness_score: 92,
    allowed_use: "trasparenza",
    notes: "Pagina pubblica risultati PVP. Niente login.",
  },
  {
    source_name: "asteannunci_veneto",
    base_url: "https://www.asteannunci.it/aste-immobiliari/veneto/",
    source_type: "auctions",
    province: ["VE","VR","VI","PD","TV","BL","RO"],
    priority: 88, crawl_depth: 1, max_pages: 60,
    allowed_paths: ["/aste-immobiliari/veneto","/lotto","/dettaglio"],
    excluded_paths: ["login","registrati","abbonati","privato"],
    expected_entities: ["asta","lotto","prezzo_base","data_vendita","tribunale"],
    reliability_score: 88, freshness_score: 88,
    allowed_use: "libera",
  },
  {
    source_name: "astegiudiziarie_veneto",
    base_url: "https://www.astegiudiziarie.it/Lista/RegioneVeneto",
    source_type: "auctions",
    province: ["VE","VR","VI","PD","TV","BL","RO"],
    priority: 90, crawl_depth: 1, max_pages: 80,
    allowed_paths: ["RegioneVeneto","/Lotto","/Procedura","/Asta"],
    excluded_paths: ["login","abbonati","riservato"],
    expected_entities: ["asta","lotto","tribunale","prezzo_base","offerta_minima","data_vendita"],
    reliability_score: 92, freshness_score: 90,
    allowed_use: "libera",
  },
  // IVG provinciali (siti pubblici)
  ivgSource("ivg_padova",  "https://www.ivgpadova.it/",  "PD", "Padova"),
  ivgSource("ivg_vicenza", "https://www.ivgvicenza.it/", "VI", "Vicenza"),
  ivgSource("ivg_verona",  "https://www.ivgverona.it/",  "VR", "Verona"),
  ivgSource("ivg_venezia", "https://www.ivgvenezia.it/", "VE", "Venezia"),
  ivgSource("ivg_treviso", "https://www.tribunaletreviso.it/", "TV", "Treviso"),
  ivgSource("ivg_belluno", "https://www.tribunale.belluno.it/", "BL", "Belluno"),
  ivgSource("ivg_rovigo",  "https://www.tribunale.rovigo.it/",  "RO", "Rovigo"),
  // Tribunali — sezione vendite/avvisi pubblici
  tribunalSource("tribunale_padova",   "https://www.tribunale.padova.it/",   "PD", "Padova"),
  tribunalSource("tribunale_vicenza",  "https://www.tribunale.vicenza.it/",  "VI", "Vicenza"),
  tribunalSource("tribunale_verona",   "https://www.tribunale.verona.it/",   "VR", "Verona"),
  tribunalSource("tribunale_venezia",  "https://www.tribunale.venezia.it/",  "VE", "Venezia"),
];

function ivgSource(name: string, base: string, prov: string, comune: string): FirecrawlSource {
  return {
    source_name: name, base_url: base, source_type: "ivg",
    province: [prov], comuni: [comune],
    priority: 92, crawl_depth: 1, max_pages: 60,
    allowed_paths: ["asta","aste","vendita","vendite","lotto","procedura","immobiliar","pignoramento","avviso"],
    excluded_paths: ["login","accedi","registrati","abbonati","riservato","privato",".zip"],
    expected_entities: ["asta","lotto","prezzo_base","offerta_minima","data_vendita","tribunale","perizia"],
    reliability_score: 92, freshness_score: 88,
    allowed_use: "libera",
    notes: "Istituto Vendite Giudiziarie provinciale.",
  };
}

function tribunalSource(name: string, base: string, prov: string, comune: string): FirecrawlSource {
  return {
    source_name: name, base_url: base, source_type: "auctions",
    province: [prov], comuni: [comune],
    priority: 85, crawl_depth: 1, max_pages: 50,
    allowed_paths: ["vendite-giudiziarie","vendite","avvisi","aste","procedure-esecutive","fallimenti","liquidazion","concordat"],
    excluded_paths: ["login","accedi","privato","riservato",".zip","amministrazione-giustizia"],
    expected_entities: ["asta","tribunale","procedura","fallimento","liquidazione","avviso_vendita"],
    reliability_score: 90, freshness_score: 80,
    allowed_use: "trasparenza",
    notes: "Sezione pubblica vendite del Tribunale.",
  };
}

// ═══════════════════════════════════════════════════════════════
// Open Data / Geoportali
// ═══════════════════════════════════════════════════════════════
const OPENDATA_SOURCES: FirecrawlSource[] = [
  {
    source_name: "regione_veneto_opendata",
    base_url: "https://dati.veneto.it/",
    source_type: "open_data",
    province: ["VE","VR","VI","PD","TV","BL","RO"],
    priority: 80, crawl_depth: 1, max_pages: 60,
    allowed_paths: ["/dataset","/opendata","/group"],
    expected_entities: ["dataset","trasporti","scuole","sanita","mobilita","urbanistica"],
    reliability_score: 92, freshness_score: 75,
    allowed_use: "open_data",
  },
  {
    source_name: "geoportale_veneto",
    base_url: "https://idt2.regione.veneto.it/",
    source_type: "open_data",
    province: ["VE","VR","VI","PD","TV","BL","RO"],
    priority: 75, crawl_depth: 1, max_pages: 30,
    allowed_paths: ["catalog","dataset","layer","geoportal"],
    expected_entities: ["geo_dataset","cartografia","ptcp","prg"],
    reliability_score: 90, freshness_score: 70,
    allowed_use: "open_data",
  },
];

// ═══════════════════════════════════════════════════════════════
// Comuni: sezioni Amministrazione Trasparente (pubbliche per legge)
// ═══════════════════════════════════════════════════════════════
const COMUNE_PATHS_ALLOWED = [
  "amministrazione-trasparente","bandi","bandi-di-gara","bandi-di-concorso","avvisi","avvisi-pubblici",
  "urbanistica","piano-degli-interventi","piano-interventi","pat","pi","varianti","varianti-urbanistiche",
  "lavori-pubblici","opere-pubbliche","appalti","gare","cantieri",
  "alienazion","patrimonio","patrimonio-immobiliare","dismission","concession","valorizzazion",
  "vendite","vendita-immobili","aste","aste-immobiliari","beni-immobili",
  "delibere","delibera","atti","provvediment","determine",
  "rigenerazione","mobilita","trasporti","servizi-pubblici",
];
const COMUNE_PATHS_EXCLUDED = [
  "login","accedi","registrati","privato","riservato","abbonati","spid-only",".zip",".rar",
  "modulistica/privacy","trattamento-dati","cookie","pec-amministrazione","privacy-policy",
];

function comuneSource(name: string, base: string, prov: string, comune: string, priority: number): FirecrawlSource {
  return {
    source_name: name,
    base_url: base,
    source_type: "municipal_notices",
    province: [prov],
    comuni: [comune],
    priority,
    crawl_depth: 1,
    max_pages: 80,
    allowed_paths: COMUNE_PATHS_ALLOWED,
    excluded_paths: COMUNE_PATHS_EXCLUDED,
    expected_entities: ["bando","alienazione","opera_pubblica","variante","piano_interventi","delibera","asta_pubblica","avviso_vendita"],
    reliability_score: 88, freshness_score: 72,
    allowed_use: "trasparenza",
    notes: "Solo sezioni pubbliche ex D.Lgs. 33/2013.",
  };
}

const COMUNE_SOURCES: FirecrawlSource[] = [
  comuneSource("comune_padova",            "https://www.padovanet.it/",                          "PD", "Padova",            95),
  comuneSource("comune_vicenza",           "https://www.comune.vicenza.it/",                     "VI", "Vicenza",           93),
  comuneSource("comune_verona",            "https://www.comune.verona.it/",                      "VR", "Verona",            93),
  comuneSource("comune_venezia",           "https://www.comune.venezia.it/",                     "VE", "Venezia",           93),
  comuneSource("comune_mestre",            "https://www.comune.venezia.it/it/mestre",            "VE", "Mestre",            85),
  comuneSource("comune_treviso",           "https://www.comune.treviso.it/",                     "TV", "Treviso",           90),
  comuneSource("comune_belluno",           "https://www.comune.belluno.it/",                     "BL", "Belluno",           80),
  comuneSource("comune_rovigo",            "https://www.comune.rovigo.it/",                      "RO", "Rovigo",            80),
  comuneSource("comune_bassano",           "https://www.comune.bassano.vi.it/",                  "VI", "Bassano del Grappa",78),
  comuneSource("comune_schio",             "https://www.comune.schio.vi.it/",                    "VI", "Schio",             72),
  comuneSource("comune_thiene",            "https://www.comune.thiene.vi.it/",                   "VI", "Thiene",            70),
  comuneSource("comune_montecchio_mag",    "https://www.comune.montecchio-maggiore.vi.it/",      "VI", "Montecchio Maggiore",65),
  comuneSource("comune_arzignano",         "https://www.comune.arzignano.vi.it/",                "VI", "Arzignano",         65),
  comuneSource("comune_castelfranco",      "https://www.comune.castelfranco-veneto.tv.it/",      "TV", "Castelfranco Veneto",70),
  comuneSource("comune_conegliano",        "https://www.comune.conegliano.tv.it/",               "TV", "Conegliano",        70),
  comuneSource("comune_chioggia",          "https://www.chioggia.org/",                          "VE", "Chioggia",          65),
  comuneSource("comune_legnago",           "https://www.comune.legnago.vr.it/",                  "VR", "Legnago",           65),
  comuneSource("comune_san_bonifacio",     "https://www.comunesanbonifacio.vr.it/",              "VR", "San Bonifacio",     60),
  comuneSource("comune_este",              "https://www.comune.este.pd.it/",                     "PD", "Este",              60),
  comuneSource("comune_monselice",         "https://www.comune.monselice.padova.it/",            "PD", "Monselice",         60),
  comuneSource("comune_cittadella",        "https://www.comune.cittadella.pd.it/",               "PD", "Cittadella",        60),
  comuneSource("comune_abano",             "https://www.abanoterme.net/",                        "PD", "Abano Terme",       60),
  comuneSource("comune_montegrotto",       "https://www.comune.montegrotto-terme.pd.it/",        "PD", "Montegrotto Terme", 58),
  comuneSource("comune_jesolo",            "https://www.comune.jesolo.ve.it/",                   "VE", "Jesolo",            70),
  comuneSource("comune_san_dona",          "https://www.comunesandonadipiave.it/",               "VE", "San Donà di Piave", 65),
  comuneSource("comune_mirano",            "https://www.comune.mirano.ve.it/",                   "VE", "Mirano",            60),
  comuneSource("comune_dolo",              "https://www.comune.dolo.ve.it/",                     "VE", "Dolo",              58),
  comuneSource("comune_villafranca",       "https://www.comune.villafrancadiverona.vr.it/",      "VR", "Villafranca di Verona",60),
  comuneSource("comune_bussolengo",        "https://www.comune.bussolengo.vr.it/",               "VR", "Bussolengo",        58),
  comuneSource("comune_valdagno",          "https://www.comune.valdagno.vi.it/",                 "VI", "Valdagno",          58),
  comuneSource("comune_marostica",         "https://www.comune.marostica.vi.it/",                "VI", "Marostica",         55),
  comuneSource("comune_oderzo",            "https://www.comune.oderzo.tv.it/",                   "TV", "Oderzo",            58),
  comuneSource("comune_vittorio_veneto",   "https://www.comune.vittorio-veneto.tv.it/",          "TV", "Vittorio Veneto",   60),
  comuneSource("comune_feltre",            "https://www.comune.feltre.bl.it/",                   "BL", "Feltre",            58),
  comuneSource("comune_adria",             "https://www.comune.adria.ro.it/",                    "RO", "Adria",             58),
];

export const VENETO_SOURCES: FirecrawlSource[] = [
  ...AUCTION_SOURCES,
  ...OPENDATA_SOURCES,
  ...COMUNE_SOURCES,
];

export function filterSources(opts: {
  province?: string[];
  comuni?: string[];
  sourceTypes?: string[];
}): FirecrawlSource[] {
  const provSet = opts.province && opts.province.length ? new Set(opts.province.map((p) => p.toUpperCase())) : null;
  const typeSet = opts.sourceTypes && opts.sourceTypes.length ? new Set(opts.sourceTypes) : null;
  const comuniSet = opts.comuni && opts.comuni.length ? new Set(opts.comuni.map((c) => c.toLowerCase())) : null;
  return VENETO_SOURCES.filter((s) => {
    if (typeSet && !typeSet.has(s.source_type)) return false;
    if (provSet && !s.province.some((p) => provSet.has(p))) return false;
    if (comuniSet && s.comuni && !s.comuni.some((c) => comuniSet.has(c.toLowerCase()))) return false;
    return true;
  }).sort((a, b) => b.priority - a.priority);
}

export function registryStats() {
  const byType: Record<string, number> = {};
  for (const s of VENETO_SOURCES) byType[s.source_type] = (byType[s.source_type] ?? 0) + 1;
  return { total: VENETO_SOURCES.length, by_type: byType };
}
