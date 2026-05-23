// ═══════════════════════════════════════════════════════════════
// pageClassifier — classifica una pagina/documento in base a URL e markdown.
// ═══════════════════════════════════════════════════════════════
export type PageClass =
  | "auction" | "pvp" | "ivg" | "urban_planning" | "public_work"
  | "open_data" | "municipal_notice" | "territorial_service"
  | "infrastructure" | "transport" | "school" | "tourism"
  | "business_area" | "real_estate_market" | "commercial_retail" | "irrelevant";

const RULES: Array<{ cls: PageClass; tokens: string[] }> = [
  { cls: "pvp",                tokens: ["pvp.giustizia","portale vendite pubbliche"] },
  { cls: "ivg",                tokens: ["ivg ","istituto vendite giudiziarie"] },
  { cls: "auction",            tokens: ["asta","aste immobiliari","vendita giudiziaria","perizia"] },
  { cls: "urban_planning",     tokens: ["pat ","piano interventi","variante urbanistica","p.i.","puc","prg","zoning"] },
  { cls: "public_work",        tokens: ["lavori pubblici","opera pubblica","appalto","cantiere","manutenzione straordinaria","rotatoria","viabilità","viabilita","parcheggio"] },
  { cls: "municipal_notice",   tokens: ["avviso pubblico","bando","alienazione","patrimonio comunale","dismissione"] },
  { cls: "infrastructure",     tokens: ["infrastruttura","autostrada","tangenziale","sr ","ss ","pista ciclabile","ciclabile"] },
  { cls: "transport",          tokens: ["trasporto pubblico","sfmr","stazione ferroviaria","trenitalia","tram","fermata tram","metropolitana"] },
  { cls: "school",             tokens: ["scuola","istituto comprensivo","plesso scolastico","università","universita","polo universitario","ospedale","asl","ulss"] },
  { cls: "tourism",            tokens: ["turismo","presenze turistiche"] },
  { cls: "business_area",      tokens: ["zona industriale","zai","area produttiva"] },
  { cls: "commercial_retail",  tokens: ["centro commerciale","retail park","parco commerciale","outlet"] },
  { cls: "real_estate_market", tokens: ["mercato immobiliare","quotazioni","osservatorio immobiliare"] },
  { cls: "open_data",          tokens: ["dataset","open data","csv","geojson"] },
  { cls: "territorial_service",tokens: ["servizio territoriale","mobilità urbana","rigenerazione urbana","brownfield"] },
];

export function classifyPage(url: string, markdown: string | null): PageClass {
  const hay = `${url}\n${(markdown ?? "").slice(0, 4000)}`.toLowerCase();
  for (const r of RULES) {
    if (r.tokens.some((t) => hay.includes(t))) return r.cls;
  }
  return "irrelevant";
}
