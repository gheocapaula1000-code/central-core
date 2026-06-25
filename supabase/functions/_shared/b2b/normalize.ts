// Normalization + scoring for b2b-finder POIs (Coprimacchia TNT vertical).
// Scoring v0.2: stricter priority bands to be commercially useful.

import type { OverpassPoi } from "./overpass.ts";

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
}

// Strong keywords that indicate frequent lunch / many covers / mensa-style usage,
// i.e. ideal customers for Coprimacchia TNT.
// Each entry: { kw, weight, label } — kw matched as substring (lowercased).
interface KwRule {
  kw: string;
  weight: number;
  label: string;
}

const STRONG_KEYWORDS: KwRule[] = [
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

function baseScoreForCategory(
  cat: string,
  haystack: string,
): { score: number; label: string; isFoodCourtLike: boolean } {
  // food_court / mensa-like signal from category OR text
  const foodCourtLike =
    cat === "food_court" ||
    /\b(mensa|self[\s-]?service|tavola calda)\b/.test(haystack);

  if (foodCourtLike) {
    return { score: 70, label: "food court / mensa / self service", isFoodCourtLike: true };
  }
  if (cat === "restaurant") {
    return { score: 55, label: "ristorante", isFoodCourtLike: false };
  }
  if (cat === "fast_food") {
    return { score: 45, label: "fast food", isFoodCourtLike: false };
  }
  if (cat === "pub") {
    return { score: 42, label: "pub", isFoodCourtLike: false };
  }
  if (cat === "bar") {
    return { score: 40, label: "bar", isFoodCourtLike: false };
  }
  if (cat === "cafe") {
    return { score: 40, label: "caffetteria", isFoodCourtLike: false };
  }
  return { score: 30, label: `categoria ${cat}`, isFoodCourtLike: false };
}

function buildFitReason(args: {
  catLabel: string;
  strongLabels: string[];
  phone: boolean;
  website: boolean;
  priority: "high" | "medium" | "low";
}): string {
  const { catLabel, strongLabels, phone, website, priority } = args;
  const contacts: string[] = [];
  if (phone) contacts.push("telefono");
  if (website) contacts.push("sito");
  const contactsTxt = contacts.length
    ? `${contacts.join(" e ")} ${contacts.length > 1 ? "presenti" : "presente"}`
    : "contatti limitati";

  if (priority === "high") {
    if (strongLabels.some((l) => l.includes("trattoria"))) {
      return `Trattoria coerente con uso frequente di Coprimacchia TNT; ${contactsTxt}.`;
    }
    if (
      strongLabels.some((l) =>
        /(mensa|self service|tavola calda|operai|pranzo)/.test(l)
      )
    ) {
      return `Locale con servizio pranzo / molti coperti (${strongLabels.join(", ")}); ${contactsTxt}.`;
    }
    if (strongLabels.some((l) => l.includes("pizzeria"))) {
      return `Ristorante/Pizzeria adatto a pranzi e coperti ricorrenti; ${contactsTxt}.`;
    }
    if (strongLabels.some((l) => l.includes("agriturismo"))) {
      return `Agriturismo con coperti ricorrenti; ${contactsTxt}.`;
    }
    return `${catLabel} con segnali forti (${strongLabels.join(", ")}); ${contactsTxt}.`;
  }

  if (priority === "medium") {
    if (strongLabels.length) {
      return `${catLabel} con segnali (${strongLabels.join(", ")}); ${contactsTxt}.`;
    }
    return `${catLabel} coerente con il target; ${contactsTxt}.`;
  }

  return `Locale food generico (${catLabel}): utile da verificare, ${contactsTxt}.`;
}

export function scoreAndNormalize(
  poi: OverpassPoi,
  ctx: { city: string; province: string; region: string },
): NormalizedCompany | null {
  if (!poi.name) return null;

  const tags = poi.tags;
  const cat = String(poi.category);
  const haystack =
    `${poi.name} ${tags.cuisine ?? ""} ${tags.description ?? ""} ${tags.amenity ?? ""}`
      .toLowerCase();

  const base = baseScoreForCategory(cat, haystack);
  let score = base.score;

  // Strong keywords (deduped by label, weights summed but capped).
  const matched = new Map<string, number>();
  for (const r of STRONG_KEYWORDS) {
    if (haystack.includes(r.kw)) {
      // keep highest weight per label
      const prev = matched.get(r.label) ?? 0;
      if (r.weight > prev) matched.set(r.label, r.weight);
    }
  }
  const strongLabels = [...matched.keys()];
  let kwBonus = 0;
  for (const w of matched.values()) kwBonus += w;
  // Cap keyword bonus to avoid runaway scores.
  if (kwBonus > 35) kwBonus = 35;
  score += kwBonus;

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
  if (score >= 82 && hasStrong && hasContact) {
    priority = "high";
  } else if (score >= 60) {
    priority = "medium";
  } else if (hasContact && (cat === "restaurant" || cat === "fast_food")) {
    // restaurant/fast_food with at least a contact is at least medium-ish floor
    priority = score >= 55 ? "medium" : "low";
  } else {
    priority = "low";
  }

  const fit_reason = buildFitReason({
    catLabel: base.label,
    strongLabels,
    phone: !!phone,
    website: websiteOk,
    priority,
  });

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
  };
}
