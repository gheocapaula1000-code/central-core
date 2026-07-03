// Normalization + scoring for b2b-finder POIs.
// Rollback v0.7: supporta SOLO due search_mode:
//   - "clients"   → end-users che consumano coprimacchia TNT
//   - "resellers" → distributori/grossisti/casalinghi che lo rivendono

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
  buyer_type_hint: "Cliente Finale" | "Rivenditore" | "Fornitore" | "Da Verificare";
}

interface KwRule {
  kw: string;
  weight: number;
  label: string;
}

// ── CLIENTS keywords ─────────────────────────────────────────────────────
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

// ── RESELLERS keywords ───────────────────────────────────────────────────
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

// ── CLIENTS base scoring ─────────────────────────────────────────────────
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

// ── RESELLERS base scoring ───────────────────────────────────────────────
function baseScoreResellers(
  cat: string,
  tags: Record<string, string>,
  haystack: string,
): { score: number; label: string; isFoodConsumer: boolean } {
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

export function scoreAndNormalize(
  poi: OverpassPoi,
  ctx: { city: string; province: string; region: string; search_mode?: SearchMode },
): NormalizedCompany | null {
  if (!poi.name) return null;
  const sm = ctx.search_mode;
  const search_mode: SearchMode = sm === "resellers" ? "resellers" : "clients";

  const tags = poi.tags;
  const cat = String(poi.category);
  const haystack =
    `${poi.name} ${tags.cuisine ?? ""} ${tags.description ?? ""} ${tags.amenity ?? ""} ${tags.shop ?? ""} ${tags.office ?? ""} ${tags.craft ?? ""} ${tags.industrial ?? ""}`
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
  if (kwBonus > 45) kwBonus = 45;

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

  // v0.9 — Coprimacchia TNT clients: category penalties / bonuses
  if (search_mode === "clients") {
    const nameLc = (poi.name ?? "").toLowerCase();
    const cuisine = (tags.cuisine ?? "").toLowerCase();
    const capacityNum = parseInt(tags.capacity ?? "", 10);

    // v1.0 — esclusione fascia alta (off-target per monouso)
    const priceLevel = parseInt(tags["price_level"] ?? "", 10);
    if (Number.isFinite(priceLevel) && priceLevel >= 3) {
      score -= 40; strongLabels.push("off-target: fascia alta (price level " + priceLevel + ")");
    }
    if (/\b(gourmet|stellat\w*|michelin|fine\s*dining|degustazion\w*|tasting\s*menu|relais|boutique\s*hotel)\b/i.test(haystack)) {
      score -= 40; strongLabels.push("off-target: cucina gourmet/alta ristorazione");
    }

    // Penalties -30 (off-target for TNT tablecovers)
    if (cat === "ice_cream" || /gelateria/.test(nameLc)) {
      score -= 30; strongLabels.push("off-target: gelateria");
    } else if (cat === "fast_food" && !/tavola[\s_-]?calda/.test(nameLc)) {
      score -= 30; strongLabels.push("off-target: fast_food");
    } else if (cat === "bar" && !/(tavola[\s_-]?calda|pranzo)/.test(nameLc)) {
      score -= 30; strongLabels.push("off-target: bar puro");
    } else if (cat === "nightclub" || cat === "pub" || /birreria/.test(nameLc)) {
      score -= 30; strongLabels.push("off-target: nightlife/pub");
    } else if (
      cat === "bakery" || tags.shop === "bakery" || tags.shop === "pastry" ||
      /pasticceria|panificio/.test(nameLc)
    ) {
      score -= 30; strongLabels.push("off-target: bakery/pasticceria");
    }

    // Bonuses +20 (high-fit for TNT tablecovers)
    if (cat === "food_court" || /\b(mensa|canteen|self[\s-]?service)\b/.test(haystack)) {
      score += 20; strongLabels.push("target: mensa/canteen");
    }
    if (/\b(trattoria|osteria)\b/.test(nameLc) || /\b(trattoria|osteria)\b/.test(cuisine)) {
      score += 20; strongLabels.push("target: trattoria/osteria");
    }
    if (
      cat === "restaurant" && /(italian|pizza)/.test(cuisine) &&
      Number.isFinite(capacityNum) && capacityNum > 30
    ) {
      score += 20; strongLabels.push("target: ristorante italiano capacity>30");
    }
  }

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

  // ── Hard filter (resellers): drop pure food consumers without ANY reseller signal.
  // Coerente con la richiesta "in modalità resellers non voglio ristoranti/bar/pizzerie puri".
  if (search_mode === "resellers" && isFoodConsumer && !hasStrong) {
    const hasResellerShopTag =
      tags.shop === "wholesale" || tags.shop === "houseware" ||
      tags.shop === "trade" || tags.shop === "party" ||
      tags.shop === "department_store" || tags.shop === "variety_store" ||
      tags.shop === "doityourself";
    if (!hasResellerShopTag) return null;
  }

  let priority: "high" | "medium" | "low";
  if (search_mode === "resellers" && isFoodConsumer) {
    priority = "low";
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

  const fit_reason =
    search_mode === "resellers"
      ? buildFitReasonResellers({ catLabel: baseLabel, strongLabels, phone: !!phone, website: websiteOk, priority, isFoodConsumer })
      : buildFitReasonClients({ catLabel: baseLabel, strongLabels, phone: !!phone, website: websiteOk, priority });

  // Buyer-type hint
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
