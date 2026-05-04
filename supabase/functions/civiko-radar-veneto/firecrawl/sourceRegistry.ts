// ═══════════════════════════════════════════════════════════════
// Registry fonti Firecrawl per il Veneto.
// Ogni fonte è pubblica e utilizzabile (no login/paywall/captcha bypass).
// ═══════════════════════════════════════════════════════════════
export type SourceType =
  | "auctions" | "ivg" | "open_data" | "urban_planning"
  | "public_works" | "municipal_notices" | "real_estate_market" | "infrastructure";

export interface FirecrawlSource {
  source_name: string;
  base_url: string;
  source_type: SourceType;
  province: string[];           // codici prov
  comuni?: string[];
  priority: number;             // 1-100
  crawl_depth: number;          // 0 scrape, 1 map+scrape primi N
  max_pages: number;
  allowed_paths?: string[];     // include if substring match
  excluded_paths?: string[];    // exclude if substring match
  expected_entities: string[];  // hint per extractor
  reliability_score: number;
  freshness_score: number;
  notes?: string;
}

// Solo fonti pubbliche tracciabili. Sezioni "amministrazione trasparente"
// dei comuni sono per legge pubbliche (D.Lgs. 33/2013) → utilizzabili.
export const VENETO_SOURCES: FirecrawlSource[] = [
  // === ASTE / PVP (lista pubblica, senza bypass login) ===
  {
    source_name: "pvp_giustizia",
    base_url: "https://pvp.giustizia.it/pvp/it/risultati_ricerca.page",
    source_type: "auctions",
    province: ["VE","VR","VI","PD","TV","BL","RO"],
    priority: 95, crawl_depth: 0, max_pages: 1,
    expected_entities: ["aste","tribunale","prezzo_base","data_vendita"],
    reliability_score: 95, freshness_score: 90,
    notes: "Pagina pubblica risultati. Estrazione solo dati pubblicamente esposti.",
  },
  // === OPEN DATA REGIONE / GEOPORTALE ===
  {
    source_name: "regione_veneto_opendata",
    base_url: "https://dati.veneto.it/",
    source_type: "open_data",
    province: ["VE","VR","VI","PD","TV","BL","RO"],
    priority: 80, crawl_depth: 1, max_pages: 30,
    allowed_paths: ["/dataset","/opendata"],
    expected_entities: ["dataset","trasporti","scuole","sanita","mobilita"],
    reliability_score: 90, freshness_score: 70,
  },
  // === COMUNI PRIORITARI (Amministrazione Trasparente / Bandi) ===
  ...comuneSource("comune_padova", "https://www.padovanet.it/", "PD", "Padova", 90),
  ...comuneSource("comune_vicenza", "https://www.comune.vicenza.it/", "VI", "Vicenza", 88),
  ...comuneSource("comune_verona", "https://www.comune.verona.it/", "VR", "Verona", 88),
  ...comuneSource("comune_venezia", "https://www.comune.venezia.it/", "VE", "Venezia", 88),
  ...comuneSource("comune_treviso", "https://www.comune.treviso.it/", "TV", "Treviso", 85),
  ...comuneSource("comune_belluno", "https://www.comune.belluno.it/", "BL", "Belluno", 75),
  ...comuneSource("comune_rovigo", "https://www.comune.rovigo.it/", "RO", "Rovigo", 75),
  ...comuneSource("comune_bassano", "https://www.comune.bassano.vi.it/", "VI", "Bassano del Grappa", 70),
  ...comuneSource("comune_castelfranco", "https://www.comune.castelfranco-veneto.tv.it/", "TV", "Castelfranco Veneto", 65),
  ...comuneSource("comune_conegliano", "https://www.comune.conegliano.tv.it/", "TV", "Conegliano", 65),
  ...comuneSource("comune_jesolo", "https://www.comune.jesolo.ve.it/", "VE", "Jesolo", 65),
  ...comuneSource("comune_chioggia", "https://www.chioggia.org/", "VE", "Chioggia", 60),
  ...comuneSource("comune_legnago", "https://www.comune.legnago.vr.it/", "VR", "Legnago", 60),
  ...comuneSource("comune_este", "https://www.comune.este.pd.it/", "PD", "Este", 55),
  ...comuneSource("comune_monselice", "https://www.comune.monselice.padova.it/", "PD", "Monselice", 55),
];

function comuneSource(name: string, base: string, prov: string, comune: string, priority: number): FirecrawlSource[] {
  return [{
    source_name: name,
    base_url: base,
    source_type: "municipal_notices",
    province: [prov],
    comuni: [comune],
    priority,
    crawl_depth: 1,
    max_pages: 25,
    allowed_paths: [
      "amministrazione-trasparente","bandi","avvisi","urbanistica",
      "lavori-pubblici","piano-interventi","alienazion","patrimonio",
      "opere-pubbliche","rigenerazione",
    ],
    excluded_paths: ["login","privato","riservato","accedi",".zip"],
    expected_entities: ["bando","alienazione","opera_pubblica","variante","piano_interventi"],
    reliability_score: 88, freshness_score: 70,
    notes: "Solo sezioni pubbliche ex D.Lgs. 33/2013.",
  }];
}

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
