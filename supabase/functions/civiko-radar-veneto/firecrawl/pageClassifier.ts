// ═══════════════════════════════════════════════════════════════
// pageClassifier — classifica una pagina/documento in base a URL e markdown.
// ═══════════════════════════════════════════════════════════════
export type PageClass =
  | "auction" | "pvp" | "ivg" | "urban_planning" | "public_work"
  | "open_data" | "municipal_notice" | "territorial_service"
  | "infrastructure" | "transport" | "school" | "tourism"
  | "business_area" | "real_estate_market" | "irrelevant";

const RULES: Array<{ cls: PageClass; tokens: string[] }> = [
  { cls: "pvp",                tokens: ["pvp.giustizia","portale vendite pubbliche"] },
  { cls: "ivg",                tokens: ["ivg ","istituto vendite giudiziarie"] },
  { cls: "auction",            tokens: ["asta","aste immobiliari","vendita giudiziaria","perizia"] },
  { cls: "urban_planning",     tokens: ["pat ","piano interventi","variante urbanistica","p.i.","puc","prg"] },
  { cls: "public_work",        tokens: ["lavori pubblici","opera pubblica","appalto","cantiere"] },
  { cls: "municipal_notice",   tokens: ["avviso pubblico","bando","alienazione","patrimonio comunale"] },
  { cls: "infrastructure",     tokens: ["infrastruttura","autostrada","tangenziale","sr ","ss "] },
  { cls: "transport",          tokens: ["trasporto pubblico","sfmr","stazione ferroviaria","trenitalia"] },
  { cls: "school",             tokens: ["scuola","istituto comprensivo","plesso scolastico"] },
  { cls: "tourism",            tokens: ["turismo","presenze turistiche"] },
  { cls: "business_area",      tokens: ["zona industriale","zai","area produttiva"] },
  { cls: "real_estate_market", tokens: ["mercato immobiliare","quotazioni","osservatorio immobiliare"] },
  { cls: "open_data",          tokens: ["dataset","open data","csv","geojson"] },
  { cls: "territorial_service",tokens: ["servizio territoriale","mobilità urbana"] },
];

export function classifyPage(url: string, markdown: string | null): PageClass {
  const hay = `${url}\n${(markdown ?? "").slice(0, 4000)}`.toLowerCase();
  for (const r of RULES) {
    if (r.tokens.some((t) => hay.includes(t))) return r.cls;
  }
  return "irrelevant";
}
