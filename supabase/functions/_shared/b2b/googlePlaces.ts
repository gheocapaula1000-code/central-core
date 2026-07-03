// Google Places Text Search provider for b2b-finder.
// Returns POIs shaped like Overpass results (OverpassPoi) so the existing
// scope filter, normalization, and scoring pipeline keeps working unchanged.

import type { OverpassPoi, SearchMode } from "./overpass.ts";

const TEXT_SEARCH_URL =
  "https://maps.googleapis.com/maps/api/place/textsearch/json";

// Map Google Places "types" → Overpass category strings used by scoreAndNormalize.
// CLIENTS path needs amenity-like categories (restaurant, cafe, bar, fast_food, pub, food_court).
function mapClientCategory(types: string[]): string {
  if (types.includes("meal_takeaway") || types.includes("meal_delivery")) return "fast_food";
  if (types.includes("bakery")) return "cafe";
  if (types.includes("cafe")) return "cafe";
  if (types.includes("bar") || types.includes("night_club")) return "bar";
  if (types.includes("restaurant") || types.includes("food")) return "restaurant";
  return "restaurant";
}

// RESELLERS path: scoreAndNormalize keys off tags.shop/office. We try to
// produce a shop tag matching one of the buckets it recognises.
function mapResellerShop(types: string[]): string | null {
  if (types.includes("home_goods_store")) return "houseware";
  if (types.includes("hardware_store")) return "hardware";
  if (types.includes("department_store")) return "department_store";
  if (types.includes("supermarket") || types.includes("grocery_or_supermarket")) return "supermarket";
  if (types.includes("convenience_store")) return "convenience";
  if (types.includes("furniture_store") || types.includes("home_furnishings_store"))
    return "interior_decoration";
  if (types.includes("store")) return "trade";
  return null;
}

interface GooglePlace {
  place_id: string;
  name?: string;
  formatted_address?: string;
  geometry?: { location?: { lat?: number; lng?: number } };
  types?: string[];
  international_phone_number?: string;
  formatted_phone_number?: string;
  website?: string;
  price_level?: number;
}

export interface GooglePlacesQueryArgs {
  query: string;
  center: { lat: number; lng: number };
  radiusMeters: number;
  apiKey: string;
  searchMode: SearchMode;
  city: string;
  maxPages?: number; // default 1 (≤20 results)
  timeoutMs?: number;
}

async function fetchPage(
  url: string,
  timeoutMs: number,
): Promise<{ results: GooglePlace[]; next_page_token?: string; status: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`google_places http ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function queryGooglePlaces(
  args: GooglePlacesQueryArgs,
): Promise<OverpassPoi[]> {
  const {
    query, center, radiusMeters, apiKey, searchMode, city,
    maxPages = 1, timeoutMs = 8000,
  } = args;

  const baseParams = new URLSearchParams({
    query,
    location: `${center.lat},${center.lng}`,
    radius: String(Math.max(500, Math.min(50000, Math.round(radiusMeters)))),
    language: "it",
    region: "it",
    key: apiKey,
  });

  const pois: OverpassPoi[] = [];
  let url = `${TEXT_SEARCH_URL}?${baseParams}`;
  let pageToken: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    if (pageToken) {
      // Google requires a short delay before pagetoken becomes valid.
      await new Promise((r) => setTimeout(r, 2100));
      url = `${TEXT_SEARCH_URL}?${new URLSearchParams({ pagetoken: pageToken, key: apiKey })}`;
    }
    let payload;
    try {
      payload = await fetchPage(url, timeoutMs);
    } catch {
      break;
    }
    if (payload.status !== "OK" && payload.status !== "ZERO_RESULTS") break;

    for (const r of payload.results ?? []) {
      if (!r.name) continue;
      const lat = r.geometry?.location?.lat ?? null;
      const lng = r.geometry?.location?.lng ?? null;
      const types = r.types ?? [];

      const tags: Record<string, string> = {};
      if (r.formatted_address) {
        tags["addr:full"] = r.formatted_address;
        // Try to surface city tag — used by isPoiInScope and address pickAddress.
        const m = r.formatted_address.match(/\b\d{5}\s+([^,]+?)(?:\s+[A-Z]{2})?(?:,|$)/);
        if (m) tags["addr:city"] = m[1].trim();
      }
      const phone = r.international_phone_number ?? r.formatted_phone_number;
      if (phone) tags["phone"] = phone;
      if (r.website) tags["website"] = r.website;
      tags["name"] = r.name;
      tags["google:types"] = types.join(",");

      let category: string;
      if (searchMode === "resellers") {
        const shop = mapResellerShop(types);
        if (shop) {
          tags["shop"] = shop;
          category = shop;
        } else {
          // Keep raw type so scoring can still classify; reseller scorer also
          // inspects haystack (name/description) for keywords.
          category = types[0] ?? "unknown";
        }
      } else {
        category = mapClientCategory(types);
        tags["amenity"] = category;
      }

      pois.push({
        osm_id: `gplace/${r.place_id}`,
        type: "node",
        category,
        name: r.name,
        lat: typeof lat === "number" ? lat : null,
        lng: typeof lng === "number" ? lng : null,
        tags,
      });
    }

    pageToken = payload.next_page_token;
    if (!pageToken) break;
  }

  // Default city fallback when Google didn't surface addr:city
  for (const p of pois) {
    if (!p.tags["addr:city"]) p.tags["addr:city"] = city;
  }

  return pois;
}

export function mergeDedupePois(
  overpass: OverpassPoi[],
  google: OverpassPoi[],
): { merged: OverpassPoi[]; added_from_google: number; dedup_collisions: number } {
  const key = (p: OverpassPoi) => {
    const name = (p.name ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");
    const addr = (p.tags["addr:full"] ?? `${p.tags["addr:street"] ?? ""} ${p.tags["addr:housenumber"] ?? ""} ${p.tags["addr:city"] ?? ""}`)
      .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");
    return `${name}|${addr.slice(0, 40)}`;
  };
  const seen = new Set<string>();
  const merged: OverpassPoi[] = [];
  for (const p of overpass) {
    const k = key(p);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(p);
  }
  let added = 0, collisions = 0;
  for (const p of google) {
    const k = key(p);
    if (seen.has(k)) { collisions++; continue; }
    seen.add(k);
    merged.push(p);
    added++;
  }
  return { merged, added_from_google: added, dedup_collisions: collisions };
}
