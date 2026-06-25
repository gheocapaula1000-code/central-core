// Normalization + simple scoring for b2b-finder POIs (Coprimacchia TNT vertical).

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

const HIGH_KEYWORDS = [
  "pranzo",
  "operai",
  "mensa",
  "trattoria",
  "tavola calda",
  "self service",
  "self-service",
  "selfservice",
  "industriale",
  "agriturismo",
  "pizzeria",
];

const HIGH_CATEGORIES = new Set(["restaurant", "food_court"]);
const MED_CATEGORIES = new Set(["fast_food", "cafe", "bar", "pub"]);

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

export function scoreAndNormalize(
  poi: OverpassPoi,
  ctx: { city: string; province: string; region: string },
): NormalizedCompany | null {
  if (!poi.name) return null;

  const tags = poi.tags;
  const cat = String(poi.category);
  const haystack = `${poi.name} ${tags.cuisine ?? ""} ${tags.description ?? ""}`
    .toLowerCase();

  let score = 0;
  let priority: "high" | "medium" | "low" = "low";
  const reasons: string[] = [];

  if (HIGH_CATEGORIES.has(cat)) {
    score += 45;
    priority = "medium";
    reasons.push(`categoria ${cat}`);
  } else if (MED_CATEGORIES.has(cat)) {
    score += 25;
    reasons.push(`categoria ${cat}`);
  } else {
    score += 10;
    reasons.push(`categoria ${cat}`);
  }

  const matchedKw = HIGH_KEYWORDS.filter((k) => haystack.includes(k));
  if (matchedKw.length) {
    score += 25 + Math.min(matchedKw.length - 1, 3) * 5;
    priority = "high";
    reasons.push(`keyword: ${matchedKw.join(", ")}`);
  }

  const phone = tags.phone || tags["contact:phone"] || null;
  const email = tags.email || tags["contact:email"] || null;
  const website = tags.website || tags["contact:website"] || null;

  if (phone) {
    score += 8;
    reasons.push("telefono presente");
  }
  if (website) {
    score += 8;
    reasons.push("sito presente");
  }
  if (email) {
    score += 4;
    reasons.push("email presente");
  }

  if (score >= 70 && priority !== "high") priority = "high";
  else if (score >= 45 && priority === "low") priority = "medium";

  score = Math.max(0, Math.min(100, score));

  return {
    name: poi.name,
    category: cat,
    city: pickCity(tags, ctx.city),
    province: ctx.province,
    region: ctx.region,
    address: pickAddress(tags),
    phone,
    email,
    website,
    lat: poi.lat,
    lng: poi.lng,
    source: "overpass",
    source_ref: poi.osm_id,
    fit_reason: reasons.join("; "),
    priority,
    score,
  };
}
