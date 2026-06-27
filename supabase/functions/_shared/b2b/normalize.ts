// Normalization + scoring for b2b-finder POIs.
// Supports two search_mode:
//   - "clients"   → end-users that consume coprimacchia TNT (trattorie, mense, ...)
//   - "resellers" → distributors / wholesalers / housewares retailers that resell it.

import type { OverpassPoi, SearchMode } from "./overpass.ts";

export type { SearchMode };

export interface NormalizedCompany {
  name: string;
  category: string;
  city: string;
  province: string;
  region: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  lat: number | null;
  lng: number | null;
  source: "overpass";
  source_ref: string;
  fit_reason: string;
  priority: "high" | "medium" | "low";
  score: number;
  search_mode: SearchMode;
  buyer_type_hint: "Cliente Finale" | "Rivenditore" | "Fornitore" | "Produttore" | "Importatore" | "Distributore" | "Da Verificare";
}

interface KwRule {
  kw: string;
  weight: number;
  label: string;
}

// ── CLIENTS keywords (existing v0.2 set) ─────────────────────────────────
const STRONG_KEYWORDS_CLIENTS: KwRule[] = [
  { kw: "pranzo di lavoro", weight: 25, label: "pranzo di lavoro" },
  { kw: "pranzo lavoro", weight: 25, label: "pranzo lavoro" },
  { kw: "pranzo", weight: 25, label: "pranzo" },
  { kw: "operai", weight: 25, label: "operai" },
  { kw: "mensa", weight: 25, label: "mensa" },
  { kw: "tavola calda", weight: 25, label: "tavola calda" },
  { kw: "self service", weight: 25, label: "self service" },
  { kw: "self-service", weight: 25, label: "self-service" },
  { kw: "selfservice", weight: 25, label: "self service" },
  { kw: "buffet", weight: 20, label: "buffet" },
  { kw: "trattoria", weight: 20, label: "trattoria" },
  { kw: "ristorante pizzeria", weight: 15, label: "ristorante pizzeria" },
  { kw: "pizzeria ristorante", weight: 15, label: "pizzeria ristorante" },
  { kw: "agriturismo", weight: 15, label: "agriturismo" },
];

// ── RESELLERS keywords (new) ─────────────────────────────────────────────
const STRONG_KEYWORDS_RESELLERS: KwRule[] = [
  { kw: "ingrosso", weight: 30, label: "ingrosso" },
  { kw: "cash and carry", weight: 30, label: "cash and carry" },
  { kw: "cash & carry", weight: 30, label: "cash and carry" },
  { kw: "c&c", weight: 25, label: "cash and carry" },
  { kw: "grossist", weight: 28, label: "grossista" },
  { kw: "distribut", weight: 22, label: "distribuzione" },
  { kw: "horeca", weight: 28, label: "horeca" },
  { kw: "forniture", weight: 22, label: "forniture" },
  { kw: "fornitura", weight: 20, label: "forniture" },
  { kw: "articoli per ristorant", weight: 25, label: "articoli ristorazione" },
  { kw: "articoli per bar", weight: 22, label: "articoli bar" },
  { kw: "articoli per pizzer", weight: 22, label: "articoli pizzeria" },
  { kw: "catering", weight: 18, label: "catering" },
  { kw: "monouso", weight: 25, label: "monouso" },
  { kw: "packaging", weight: 20, label: "packaging" },
  { kw: "casaling", weight: 18, label: "casalinghi" },
  { kw: "biancheria", weight: 15, label: "biancheria" },
  { kw: "tovagliato", weight: 22, label: "tovagliato" },
  { kw: "party", weight: 15, label: "party" },
  { kw: "eventi", weight: 12, label: "eventi" },
  { kw: "detergenza", weight: 12, label: "detergenza" },
  { kw: "professional", weight: 10, label: "professionale" },
];

// ── SUPPLIERS keywords (new) ─────────────────────────────────────────────
// Cerco fornitori da cui acquistare il prodotto (non clienti).
const STRONG_KEYWORDS_SUPPLIERS: KwRule[] = [
  { kw: "produttore", weight: 35, label: "produttore" },
  { kw: "produttori", weight: 35, label: "produttore" },
  { kw: "produzione", weight: 28, label: "produzione" },
  { kw: "manifattur", weight: 30, label: "manifattura" },
  { kw: "fabbric", weight: 25, label: "fabbrica" },
  { kw: "stabilimento", weight: 22, label: "stabilimento" },
  { kw: "importator", weight: 30, label: "importatore" },
  { kw: "import", weight: 22, label: "import" },
  { kw: "distribut", weight: 28, label: "distribuzione" },
  { kw: "grossist", weight: 30, label: "grossista" },
  { kw: "ingrosso", weight: 30, label: "ingrosso" },
  { kw: "cash and carry", weight: 28, label: "cash and carry" },
  { kw: "cash & carry", weight: 28, label: "cash and carry" },
  { kw: "c&c", weight: 22, label: "cash and carry" },
  { kw: "horeca", weight: 26, label: "horeca" },
  { kw: "forniture", weight: 22, label: "forniture" },
  { kw: "fornitura", weight: 20, label: "forniture" },
  { kw: "carta", weight: 18, label: "carta" },
  { kw: "tissue", weight: 22, label: "tissue/airlaid" },
  { kw: "airlaid", weight: 35, label: "airlaid" },
  { kw: "tnt", weight: 28, label: "tnt" },
  { kw: "tessuto non tessuto", weight: 28, label: "tessuto non tessuto" },
  { kw: "tovagli", weight: 22, label: "tovagliato" },
  { kw: "portaposate", weight: 35, label: "portaposate" },
  { kw: "monouso", weight: 28, label: "monouso" },
  { kw: "packaging", weight: 22, label: "packaging" },
  { kw: "imballagg", weight: 20, label: "imballaggi" },
  { kw: "logistic", weight: 12, label: "logistica" },
];

function pickAddress(tags: Record<string, string>): string | null {
  const street = tags["addr:street"];
  const num = tags["addr:housenumber"];
  const city = tags["addr:city"];
  const parts = [
    [street, num].filter(Boolean).join(" "),
    city,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function pickCity(tags: Record<string, string>, fallback: string): string {
  return tags["addr:city"] || fallback;
}

function isValidWebsite(w: string | null): boolean {
  if (!w) return false;
  const s = w.trim().toLowerCase();
  if (s.length < 4) return false;
  return s.startsWith("http://") || s.startsWith("https://") || s.includes(".");
}

// ── CLIENTS base scoring (unchanged) ─────────────────────────────────────
function baseScoreClients(
  cat: string,
  haystack: string,
): { score: number; label: string; isFoodCourtLike: boolean } {
  const foodCourtLike =
    cat === "food_court" ||
    /\b(mensa|self[\s-]?service|tavola calda)\b/.test(haystack);
  if (foodCourtLike) return { score: 70, label: "food court / mensa / self service", isFoodCourtLike: true };
  if (cat === "restaurant") return { score: 55, label: "ristorante", isFoodCourtLike: false };
  if (cat === "fast_food") return { score: 45, label: "fast food", isFoodCourtLike: false };
  if (cat === "pub")       return { score: 42, label: "pub", isFoodCourtLike: false };
  if (cat === "bar")       return { score: 40, label: "bar", isFoodCourtLike: false };
  if (cat === "cafe")      return { score: 40, label: "caffetteria", isFoodCourtLike: false };
  return { score: 30, label: `categoria ${cat}`, isFoodCourtLike: false };
}

// ── RESELLERS base scoring (new) ─────────────────────────────────────────
function baseScoreResellers(
  cat: string,
  tags: Record<string, string>,
  haystack: string,
): { score: number; label: string; isFoodConsumer: boolean } {
  // If the POI is actually a pure consumer (restaurant/bar/pizzeria/cafe),
  // it is NOT a reseller → cap base low.
  const isFoodConsumer =
    /(restaurant|bar|cafe|fast_food|pub|food_court|pizzeria|ice_cream)/.test(cat) ||
    /(ristorante|trattoria|pizzeria|gelateria)/.test(haystack);
  if (isFoodConsumer && !/ingrosso|grossist|forniture|distribut|cash/.test(haystack)) {
    return { score: 18, label: `attività di consumo (${cat})`, isFoodConsumer: true };
  }

  const shop = tags.shop ?? "";
  const office = tags.office ?? "";
  if (shop === "wholesale")              return { score: 80, label: "ingrosso (wholesale)", isFoodConsumer: false };
  if (shop === "houseware")              return { score: 65, label: "casalinghi", isFoodConsumer: false };
  if (shop === "department_store")       return { score: 55, label: "department store", isFoodConsumer: false };
  if (shop === "supermarket")            return { score: 50, label: "supermercato / cash&carry-like", isFoodConsumer: false };
  if (shop === "trade")                  return { score: 65, label: "rivendita trade", isFoodConsumer: false };
  if (shop === "doityourself")           return { score: 45, label: "DIY / bricolage", isFoodConsumer: false };
  if (shop === "variety_store")          return { score: 55, label: "variety store", isFoodConsumer: false };
  if (shop === "party")                  return { score: 70, label: "negozio articoli party", isFoodConsumer: false };
  if (shop === "interior_decoration")    return { score: 45, label: "interior decoration", isFoodConsumer: false };
  if (shop === "hardware")               return { score: 40, label: "ferramenta", isFoodConsumer: false };
  if (shop === "convenience")            return { score: 35, label: "minimarket", isFoodConsumer: false };
  if (shop)                              return { score: 40, label: `negozio ${shop}`, isFoodConsumer: false };
  if (office === "company")              return { score: 45, label: "azienda (office)", isFoodConsumer: false };
  if (office)                            return { score: 38, label: `office ${office}`, isFoodConsumer: false };
  return { score: 30, label: `categoria ${cat}`, isFoodConsumer: false };
}

function buildFitReasonClients(args: {
  catLabel: string; strongLabels: string[]; phone: boolean; website: boolean; priority: "high" | "medium" | "low";
}): string {
  const { catLabel, strongLabels, phone, website, priority } = args;
  const contacts: string[] = [];
  if (phone) contacts.push("telefono");
  if (website) contacts.push("sito");
  const contactsTxt = contacts.length
    ? `${contacts.join(" e ")} ${contacts.length > 1 ? "presenti" : "presente"}`
    : "contatti limitati";

  if (priority === "high") {
    if (strongLabels.some((l) => l.includes("trattoria"))) return `Trattoria coerente con uso frequente di Coprimacchia TNT; ${contactsTxt}.`;
    if (strongLabels.some((l) => /(mensa|self service|tavola calda|operai|pranzo)/.test(l)))
      return `Locale con servizio pranzo / molti coperti (${strongLabels.join(", ")}); ${contactsTxt}.`;
    if (strongLabels.some((l) => l.includes("pizzeria"))) return `Ristorante/Pizzeria adatto a pranzi e coperti ricorrenti; ${contactsTxt}.`;
    if (strongLabels.some((l) => l.includes("agriturismo"))) return `Agriturismo con coperti ricorrenti; ${contactsTxt}.`;
    return `${catLabel} con segnali forti (${strongLabels.join(", ")}); ${contactsTxt}.`;
  }
  if (priority === "medium") {
    if (strongLabels.length) return `${catLabel} con segnali (${strongLabels.join(", ")}); ${contactsTxt}.`;
    return `${catLabel} coerente con il target; ${contactsTxt}.`;
  }
  return `Locale food generico (${catLabel}): utile da verificare, ${contactsTxt}.`;
}

function buildFitReasonResellers(args: {
  catLabel: string; strongLabels: string[]; phone: boolean; website: boolean;
  priority: "high" | "medium" | "low"; isFoodConsumer: boolean;
}): string {
  const { catLabel, strongLabels, phone, website, priority, isFoodConsumer } = args;
  const contacts: string[] = [];
  if (phone) contacts.push("telefono");
  if (website) contacts.push("sito");
  const contactsTxt = contacts.length
    ? `${contacts.join(" e ")} ${contacts.length > 1 ? "presenti" : "presente"}`
    : "contatti limitati";

  if (isFoodConsumer) {
    return `Attività di consumo (${catLabel}): non è un canale di rivendita; ${contactsTxt}.`;
  }
  if (priority === "high") {
    if (strongLabels.some((l) => /(ingrosso|cash and carry|grossista|horeca|distribuzione)/.test(l)))
      return `Canale di distribuzione coerente (${strongLabels.join(", ")}): può rivendere Coprimacchia TNT al proprio catalogo; ${contactsTxt}.`;
    if (strongLabels.some((l) => /(monouso|tovagliato|packaging|articoli ristorazione|articoli bar|articoli pizzeria)/.test(l)))
      return `Negozio specializzato (${strongLabels.join(", ")}) con assortimento compatibile; ${contactsTxt}.`;
    return `${catLabel} con segnali di rivendita (${strongLabels.join(", ")}); ${contactsTxt}.`;
  }
  if (priority === "medium") {
    if (strongLabels.length) return `${catLabel} con segnali (${strongLabels.join(", ")}) compatibili con la rivendita; ${contactsTxt}.`;
    return `${catLabel} potenzialmente compatibile come rivenditore; ${contactsTxt}.`;
  }
  return `${catLabel}: possibile rivenditore da verificare, ${contactsTxt}.`;
}

function baseScoreSuppliers(
  cat: string,
  tags: Record<string, string>,
  haystack: string,
): { score: number; label: string; isFoodConsumer: boolean } {
  const isFoodConsumer =
    /(restaurant|bar|cafe|fast_food|pub|food_court|pizzeria|ice_cream)/.test(cat) ||
    /(ristorante|trattoria|pizzeria|gelateria)/.test(haystack);
  if (isFoodConsumer && !/ingrosso|grossist|forniture|distribut|cash|produttor|import|airlaid|tnt|tovagli|portaposate/.test(haystack)) {
    return { score: 12, label: `attività di consumo (${cat})`, isFoodConsumer: true };
  }

  const shop = tags.shop ?? "";
  const office = tags.office ?? "";
  const industrial = tags.industrial ?? "";
  const craft = tags.craft ?? "";
  const manMade = tags.man_made ?? "";

  // Industrial / production wins (probabili produttori reali)
  if (industrial === "paper")          return { score: 85, label: "produzione carta/airlaid", isFoodConsumer: false };
  if (industrial === "packaging")      return { score: 82, label: "produzione packaging", isFoodConsumer: false };
  if (industrial === "manufacturing")  return { score: 75, label: "manifattura", isFoodConsumer: false };
  if (industrial === "factory")        return { score: 70, label: "stabilimento produttivo", isFoodConsumer: false };
  if (industrial === "warehouse")      return { score: 60, label: "magazzino/logistica", isFoodConsumer: false };
  if (industrial)                      return { score: 55, label: `industriale ${industrial}`, isFoodConsumer: false };
  if (manMade === "works")             return { score: 65, label: "impianto produttivo", isFoodConsumer: false };

  // Distribuzione / ingrosso
  if (shop === "wholesale")            return { score: 80, label: "ingrosso (wholesale)", isFoodConsumer: false };
  if (shop === "trade")                return { score: 65, label: "rivendita trade", isFoodConsumer: false };
  if (office === "wholesale")          return { score: 75, label: "ufficio ingrosso", isFoodConsumer: false };
  if (office === "logistics")          return { score: 60, label: "logistica/distribuzione", isFoodConsumer: false };
  if (office === "company")            return { score: 50, label: "azienda (office)", isFoodConsumer: false };
  if (office)                          return { score: 42, label: `office ${office}`, isFoodConsumer: false };
  if (craft)                           return { score: 45, label: `artigianato ${craft}`, isFoodConsumer: false };
  if (shop)                            return { score: 38, label: `negozio ${shop}`, isFoodConsumer: false };
  return { score: 28, label: `categoria ${cat}`, isFoodConsumer: false };
}

function buildFitReasonSuppliers(args: {
  catLabel: string; strongLabels: string[]; phone: boolean; website: boolean;
  priority: "high" | "medium" | "low"; isFoodConsumer: boolean;
}): string {
  const { catLabel, strongLabels, phone, website, priority, isFoodConsumer } = args;
  const contacts: string[] = [];
  if (phone) contacts.push("telefono");
  if (website) contacts.push("sito");
  const contactsTxt = contacts.length
    ? `${contacts.join(" e ")} ${contacts.length > 1 ? "presenti" : "presente"}`
    : "contatti limitati";

  if (isFoodConsumer) {
    return `Attività di consumo (${catLabel}): non è un fornitore; ${contactsTxt}.`;
  }
  if (priority === "high") {
    if (strongLabels.some((l) => /(airlaid|tnt|tovagliato|portaposate|monouso|tissue)/.test(l)))
      return `Possibile produttore/fornitore di tovagliato monouso (${strongLabels.join(", ")}); ${contactsTxt}.`;
    if (strongLabels.some((l) => /(produttore|manifattura|fabbrica|produzione|stabilimento)/.test(l)))
      return `Realtà produttiva coerente (${strongLabels.join(", ")}); ${contactsTxt}.`;
    if (strongLabels.some((l) => /(ingrosso|grossista|distribuzione|horeca|cash and carry|forniture|importatore)/.test(l)))
      return `Canale ingrosso/distribuzione (${strongLabels.join(", ")}); ${contactsTxt}.`;
    return `${catLabel} con segnali forti (${strongLabels.join(", ")}); ${contactsTxt}.`;
  }
  if (priority === "medium") {
    if (strongLabels.length) return `${catLabel} con segnali (${strongLabels.join(", ")}) compatibili con un fornitore; ${contactsTxt}.`;
    return `${catLabel} potenzialmente compatibile come fornitore; ${contactsTxt}.`;
  }
  return `${catLabel}: possibile fornitore da verificare, ${contactsTxt}.`;
}


export function scoreAndNormalize(
  poi: OverpassPoi,
  ctx: { city: string; province: string; region: string; search_mode?: SearchMode },
): NormalizedCompany | null {
  if (!poi.name) return null;
  const search_mode: SearchMode = ctx.search_mode === "resellers" ? "resellers" : "clients";

  const tags = poi.tags;
  const cat = String(poi.category);
  const haystack =
    `${poi.name} ${tags.cuisine ?? ""} ${tags.description ?? ""} ${tags.amenity ?? ""} ${tags.shop ?? ""} ${tags.office ?? ""} ${tags.craft ?? ""}`
      .toLowerCase();

  const KW = search_mode === "resellers" ? STRONG_KEYWORDS_RESELLERS : STRONG_KEYWORDS_CLIENTS;
  const matched = new Map<string, number>();
  for (const r of KW) {
    if (haystack.includes(r.kw)) {
      const prev = matched.get(r.label) ?? 0;
      if (r.weight > prev) matched.set(r.label, r.weight);
    }
  }
  const strongLabels = [...matched.keys()];
  let kwBonus = 0;
  for (const w of matched.values()) kwBonus += w;
  if (kwBonus > 40) kwBonus = 40;

  let baseLabel: string;
  let baseScore: number;
  let isFoodConsumer = false;
  if (search_mode === "resellers") {
    const b = baseScoreResellers(cat, tags, haystack);
    baseScore = b.score; baseLabel = b.label; isFoodConsumer = b.isFoodConsumer;
  } else {
    const b = baseScoreClients(cat, haystack);
    baseScore = b.score; baseLabel = b.label;
  }
  let score = baseScore + kwBonus;

  const phone = tags.phone || tags["contact:phone"] || null;
  const email = tags.email || tags["contact:email"] || null;
  const websiteRaw = tags.website || tags["contact:website"] || null;
  const websiteOk = isValidWebsite(websiteRaw);

  if (phone) score += 10;
  if (websiteOk) score += 8;
  if (email) score += 5;

  if (score < 0) score = 0;
  if (score > 100) score = 100;

  const hasStrong = strongLabels.length > 0;
  const hasContact = !!phone || websiteOk;

  let priority: "high" | "medium" | "low";
  if (search_mode === "resellers" && isFoodConsumer) {
    priority = "low"; // never promote pure consumers in reseller mode
  } else if (score >= 82 && hasStrong && hasContact) {
    priority = "high";
  } else if (score >= 60) {
    priority = "medium";
  } else if (
    search_mode === "clients" && hasContact && (cat === "restaurant" || cat === "fast_food")
  ) {
    priority = score >= 55 ? "medium" : "low";
  } else {
    priority = "low";
  }

  const fit_reason = search_mode === "resellers"
    ? buildFitReasonResellers({ catLabel: baseLabel, strongLabels, phone: !!phone, website: websiteOk, priority, isFoodConsumer })
    : buildFitReasonClients({ catLabel: baseLabel, strongLabels, phone: !!phone, website: websiteOk, priority });

  // Buyer-type hint (cheap heuristic, GPT may refine later)
  let buyer_type_hint: NormalizedCompany["buyer_type_hint"] = "Da Verificare";
  if (search_mode === "resellers") {
    if (isFoodConsumer) buyer_type_hint = "Cliente Finale";
    else if (/(ingrosso|grossist|cash and carry|distribut|horeca)/.test(haystack) || tags.shop === "wholesale")
      buyer_type_hint = "Fornitore";
    else if (tags.shop || tags.office) buyer_type_hint = "Rivenditore";
  } else {
    if (/(restaurant|fast_food|food_court|cafe|bar|pub)/.test(cat)) buyer_type_hint = "Cliente Finale";
  }

  return {
    name: poi.name,
    category: cat,
    city: pickCity(tags, ctx.city),
    province: ctx.province,
    region: ctx.region,
    address: pickAddress(tags),
    phone,
    email,
    website: websiteOk ? websiteRaw : null,
    lat: poi.lat,
    lng: poi.lng,
    source: "overpass",
    source_ref: poi.osm_id,
    fit_reason,
    priority,
    score,
    search_mode,
    buyer_type_hint,
  };
}
