// ═══════════════════════════════════════════════════════════════
// Sottra — Premium Geo Resolution Layer
// Multi-provider reverse geocoding with confidence merge,
// quality classification, and publication gating.
// ═══════════════════════════════════════════════════════════════

import { withAbort } from "./shared.ts";

// ── Quality Model ─────────────────────────────────────────────

/** Unified precision levels — provider-agnostic */
export type GeoMatchLevel =
  | "address_point"
  | "house_number"
  | "house_number_range"
  | "street"
  | "district"
  | "city"
  | "unknown";

/** Ordered from strongest to weakest for comparison */
const GEO_MATCH_LEVEL_RANK: Record<GeoMatchLevel, number> = {
  address_point: 6,
  house_number: 5,
  house_number_range: 4,
  street: 3,
  district: 2,
  city: 1,
  unknown: 0,
};

// ── Provider Interfaces ───────────────────────────────────────

export interface GeocodingProviderResult {
  provider: string;
  formattedAddress: string;
  country: string | null;
  region: string | null;
  province: string | null;
  city: string | null;
  street: string | null;
  houseNumber: string | null;
  postalCode: string | null;
  lat: number;
  lng: number;
  providerId: string | null;
  /** Provider-specific result type mapped to unified model */
  resultPrecision: GeoMatchLevel;
  /** Provider's own confidence (0-1), normalized */
  providerConfidence: number;
  /** Raw type string from provider (for audit) */
  rawType: string;
  limitations: string[];
}

export interface GeocodingProviderAdapter {
  readonly name: string;
  readonly priority: number; // lower = higher priority
  /** Returns true if the provider is configured and available */
  isAvailable(): boolean;
  /** Reverse geocode coordinates */
  reverseGeocode(lat: number, lng: number): Promise<GeocodingProviderResult | null>;
}

// ── Merged Resolution Result ──────────────────────────────────

export interface GeoResolutionResult {
  resolvedAddress: string | null;
  resolvedComune: string | null;
  resolvedProvincia: string | null;
  resolvedStreet: string | null;
  resolvedHouseNumber: string | null;
  resolvedPostalCode: string | null;
  resolvedLat: number;
  resolvedLng: number;
  geoConfidence: number;
  geoConfidenceReason: string;
  geoMatchLevel: GeoMatchLevel;
  providerConsensus: "strong" | "partial" | "single" | "none";
  providerBreakdown: Array<{
    provider: string;
    matchLevel: GeoMatchLevel;
    confidence: number;
    city: string | null;
    street: string | null;
    houseNumber: string | null;
  }>;
  publicationEligible: boolean;
  /** Which modules are allowed given this geo quality */
  eligibleModuleClasses: ("microzona" | "comunali" | "none")[];
}

// ── Provider Implementations ──────────────────────────────────

// --- Google Maps Platform ---

function mapGoogleType(types: string[]): GeoMatchLevel {
  if (types.includes("street_address") || types.includes("premise")) return "address_point";
  if (types.includes("subpremise")) return "address_point";
  if (types.includes("route")) return "street";
  if (types.includes("neighborhood") || types.includes("sublocality")) return "district";
  if (types.includes("locality") || types.includes("administrative_area_level_3")) return "city";
  return "unknown";
}

function mapGoogleLocationType(locationType: string): number {
  switch (locationType) {
    case "ROOFTOP": return 0.98;
    case "RANGE_INTERPOLATED": return 0.80;
    case "GEOMETRIC_CENTER": return 0.55;
    case "APPROXIMATE": return 0.35;
    default: return 0.30;
  }
}

export class GoogleMapsProvider implements GeocodingProviderAdapter {
  readonly name = "google_maps";
  readonly priority = 1;

  isAvailable(): boolean {
    return !!(Deno.env.get("GOOGLE_MAPS_API_KEY"));
  }

  async reverseGeocode(lat: number, lng: number): Promise<GeocodingProviderResult | null> {
    const key = Deno.env.get("GOOGLE_MAPS_API_KEY");
    if (!key) return null;

    const { signal, clear } = withAbort(8_000);
    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=it&key=${key}`,
        { signal }
      );
      if (!res.ok) return null;
      const data = await res.json();
      const result = data?.results?.[0];
      if (!result) return null;

      const components = result.address_components ?? [];
      const get = (type: string) => components.find((c: Record<string, unknown>) =>
        (c.types as string[])?.includes(type))?.long_name as string | null ?? null;
      const getShort = (type: string) => components.find((c: Record<string, unknown>) =>
        (c.types as string[])?.includes(type))?.short_name as string | null ?? null;

      const locationType = result.geometry?.location_type ?? "APPROXIMATE";
      const types = result.types ?? [];

      return {
        provider: this.name,
        formattedAddress: result.formatted_address ?? "",
        country: get("country"),
        region: get("administrative_area_level_1"),
        province: getShort("administrative_area_level_2"),
        city: get("locality") ?? get("administrative_area_level_3"),
        street: get("route"),
        houseNumber: get("street_number"),
        postalCode: get("postal_code"),
        lat: result.geometry?.location?.lat ?? lat,
        lng: result.geometry?.location?.lng ?? lng,
        providerId: result.place_id ?? null,
        resultPrecision: mapGoogleType(types),
        providerConfidence: mapGoogleLocationType(locationType),
        rawType: `${types.join(",")}|${locationType}`,
        limitations: [],
      };
    } catch (e) {
      console.warn(`[geo:google] Error: ${String(e).slice(0, 80)}`);
      return null;
    } finally {
      clear();
    }
  }
}

// --- HERE Maps ---

function mapHEREResultType(resultType: string, houseNumber: string | null): GeoMatchLevel {
  switch (resultType) {
    case "houseNumber": return houseNumber ? "house_number" : "house_number_range";
    case "interpolated": return "house_number_range";
    case "street": return "street";
    case "district": case "subdistrict": return "district";
    case "locality": case "city": return "city";
    default: return "unknown";
  }
}

export class HEREProvider implements GeocodingProviderAdapter {
  readonly name = "here";
  readonly priority = 2;

  isAvailable(): boolean {
    return !!(Deno.env.get("HERE_API_KEY"));
  }

  async reverseGeocode(lat: number, lng: number): Promise<GeocodingProviderResult | null> {
    const key = Deno.env.get("HERE_API_KEY");
    if (!key) return null;

    const { signal, clear } = withAbort(8_000);
    try {
      const res = await fetch(
        `https://revgeocode.search.hereapi.com/v1/revgeocode?at=${lat},${lng}&lang=it&apiKey=${key}`,
        { signal }
      );
      if (!res.ok) return null;
      const data = await res.json();
      const item = data?.items?.[0];
      if (!item) return null;

      const addr = item.address ?? {};
      const resultType = item.resultType ?? "unknown";
      const houseNumber = addr.houseNumber ?? null;

      return {
        provider: this.name,
        formattedAddress: item.title ?? addr.label ?? "",
        country: addr.countryName ?? null,
        region: addr.state ?? null,
        province: addr.county ?? null,
        city: addr.city ?? null,
        street: addr.street ?? null,
        houseNumber,
        postalCode: addr.postalCode ?? null,
        lat: item.position?.lat ?? lat,
        lng: item.position?.lng ?? lng,
        providerId: item.id ?? null,
        resultPrecision: mapHEREResultType(resultType, houseNumber),
        providerConfidence: item.scoring?.queryScore ?? 0.5,
        rawType: resultType,
        limitations: [],
      };
    } catch (e) {
      console.warn(`[geo:here] Error: ${String(e).slice(0, 80)}`);
      return null;
    } finally {
      clear();
    }
  }
}

// --- TomTom ---

function mapTomTomType(type: string): GeoMatchLevel {
  switch (type) {
    case "Point Address": return "address_point";
    case "Address Range": return "house_number_range";
    case "Street": return "street";
    case "Cross Street": return "street";
    case "Geography": return "city";
    default: return "unknown";
  }
}

export class TomTomProvider implements GeocodingProviderAdapter {
  readonly name = "tomtom";
  readonly priority = 3;

  isAvailable(): boolean {
    return !!(Deno.env.get("TOMTOM_API_KEY"));
  }

  async reverseGeocode(lat: number, lng: number): Promise<GeocodingProviderResult | null> {
    const key = Deno.env.get("TOMTOM_API_KEY");
    if (!key) return null;

    const { signal, clear } = withAbort(8_000);
    try {
      const res = await fetch(
        `https://api.tomtom.com/search/2/reverseGeocode/${lat},${lng}.json?language=it&key=${key}`,
        { signal }
      );
      if (!res.ok) return null;
      const data = await res.json();
      const addr = data?.addresses?.[0];
      if (!addr) return null;

      const a = addr.address ?? {};
      const matchType = a.type ?? "unknown";

      return {
        provider: this.name,
        formattedAddress: a.freeformAddress ?? "",
        country: a.country ?? null,
        region: a.countrySubdivision ?? null,
        province: a.countrySecondarySubdivision ?? null,
        city: a.municipality ?? null,
        street: a.streetName ?? null,
        houseNumber: a.streetNumber ?? null,
        postalCode: a.postalCode ?? null,
        lat: parseFloat(addr.position?.split(",")[0] ?? lat),
        lng: parseFloat(addr.position?.split(",")[1] ?? lng),
        providerId: null,
        resultPrecision: mapTomTomType(matchType),
        providerConfidence: matchType === "Point Address" ? 0.90 : matchType === "Street" ? 0.55 : 0.40,
        rawType: matchType,
        limitations: [],
      };
    } catch (e) {
      console.warn(`[geo:tomtom] Error: ${String(e).slice(0, 80)}`);
      return null;
    } finally {
      clear();
    }
  }
}

// --- Nominatim (free fallback, always available) ---

function mapNominatimType(addressRank: number, houseNumber: string | null): GeoMatchLevel {
  if (addressRank >= 30 && houseNumber) return "house_number";
  if (addressRank >= 26) return "street";
  if (addressRank >= 16) return "district";
  if (addressRank >= 14) return "city";
  return "unknown";
}

export class NominatimProvider implements GeocodingProviderAdapter {
  readonly name = "nominatim";
  readonly priority = 10; // always last

  isAvailable(): boolean {
    return true; // always available
  }

  async reverseGeocode(lat: number, lng: number): Promise<GeocodingProviderResult | null> {
    const { signal, clear } = withAbort(8_000);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=it&addressdetails=1`,
        { headers: { "User-Agent": "Sottra/2.0 (sottra.app)" }, signal }
      );
      if (!res.ok) return null;
      const data = await res.json();
      const a = data?.address;
      if (!a) return null;

      const houseNumber = a.house_number ?? null;
      const addressRank = data.address_rank ?? 0;
      const road = a.road ?? a.pedestrian ?? a.street ?? null;
      const city = a.city ?? a.town ?? a.village ?? a.municipality ?? null;
      const province = a.county ?? null;
      const region = a.state ?? null;

      const parts = [
        road ? (houseNumber ? `${road} ${houseNumber}` : road) : null,
        city,
      ].filter(Boolean);

      return {
        provider: this.name,
        formattedAddress: parts.join(", ") || data.display_name || "",
        country: a.country ?? null,
        region,
        province,
        city,
        street: road,
        houseNumber,
        postalCode: a.postcode ?? null,
        lat: parseFloat(data.lat ?? lat),
        lng: parseFloat(data.lon ?? lng),
        providerId: data.osm_id ? `osm:${data.osm_id}` : null,
        resultPrecision: mapNominatimType(addressRank, houseNumber),
        providerConfidence: addressRank >= 28 ? 0.70 : addressRank >= 16 ? 0.50 : 0.30,
        rawType: `rank:${addressRank}|type:${data.type ?? "unknown"}`,
        limitations: [
          "Dati OpenStreetMap — copertura variabile, non ufficiale",
          "Precisione dipendente dalla qualità della mappatura locale",
        ],
      };
    } catch (e) {
      console.warn(`[geo:nominatim] Error: ${String(e).slice(0, 80)}`);
      return null;
    } finally {
      clear();
    }
  }
}

// ── Future Adapter Stubs (Phase 2) ────────────────────────────

/**
 * Placeholder for future street-level evidence adapter.
 * Will extract address components from building photos (visible civic number, signs).
 * NOT activated — just interface preparation.
 */
export interface StreetEvidenceAdapter {
  readonly name: string;
  extractFromPhoto(photoBase64: string): Promise<{
    visibleHouseNumber: string | null;
    visibleStreetName: string | null;
    confidence: number;
  } | null>;
}

/**
 * Placeholder for future market data adapter.
 * Will provide property-level market data from commercial sources.
 * NOT activated — just interface preparation.
 */
export interface MarketDataAdapter {
  readonly name: string;
  lookupByAddress(address: string, comune: string): Promise<{
    available: boolean;
    data: unknown;
    source: string;
  } | null>;
}

// ── Provider Chain ────────────────────────────────────────────

/** Get ordered provider list based on configuration */
function getProviderChain(): GeocodingProviderAdapter[] {
  const envOrder = Deno.env.get("GEO_PROVIDER_ORDER");
  const premiumEnabled = Deno.env.get("GEO_PREMIUM_ENABLED") !== "false"; // default true

  const allProviders: GeocodingProviderAdapter[] = [
    new GoogleMapsProvider(),
    new HEREProvider(),
    new TomTomProvider(),
    new NominatimProvider(),
  ];

  if (!premiumEnabled) {
    // Only Nominatim
    return allProviders.filter(p => p.name === "nominatim");
  }

  if (envOrder) {
    // Custom order from env
    const order = envOrder.split(",").map(s => s.trim().toLowerCase());
    const ordered: GeocodingProviderAdapter[] = [];
    for (const name of order) {
      const provider = allProviders.find(p => p.name === name);
      if (provider) ordered.push(provider);
    }
    // Always include Nominatim as final fallback
    if (!ordered.find(p => p.name === "nominatim")) {
      ordered.push(new NominatimProvider());
    }
    return ordered;
  }

  // Default order: Google → HERE → TomTom → Nominatim
  return allProviders;
}

// ── Confidence Merge ──────────────────────────────────────────

/** Gating thresholds for publication */
const GEO_GATING = {
  /** Minimum geoConfidence for any publication */
  MIN_PUBLISH: 0.40,
  /** Minimum geoMatchLevel rank for microzona/pricing modules */
  MIN_MICROZONA_LEVEL: GEO_MATCH_LEVEL_RANK["house_number"], // 5
  /** Minimum geoMatchLevel rank for comunali modules */
  MIN_COMUNALI_LEVEL: GEO_MATCH_LEVEL_RANK["city"], // 1
  /** Bonus when multiple providers agree on city */
  CONSENSUS_BONUS: 0.10,
  /** Penalty when providers disagree on city */
  DISAGREEMENT_PENALTY: 0.15,
} as const;

function normalizeCity(city: string | null): string {
  return (city ?? "").toUpperCase().trim().replace(/\s+/g, " ");
}

/**
 * Merge results from multiple providers into a single resolution.
 * Explainable algorithm:
 * 1. Pick highest-precision result as primary
 * 2. Check consensus on city across providers
 * 3. Apply consensus bonus/penalty
 * 4. Determine publication eligibility by match level
 */
export function mergeGeoResults(
  results: GeocodingProviderResult[],
  inputLat: number,
  inputLng: number,
  photoEvidence?: { visibleHouseNumber?: string; visibleStreetName?: string; confidence?: number },
): GeoResolutionResult {
  if (results.length === 0) {
    return {
      resolvedAddress: null,
      resolvedComune: null,
      resolvedProvincia: null,
      resolvedStreet: null,
      resolvedHouseNumber: null,
      resolvedPostalCode: null,
      resolvedLat: inputLat,
      resolvedLng: inputLng,
      geoConfidence: 0,
      geoConfidenceReason: "Nessun provider di geocoding ha restituito risultati",
      geoMatchLevel: "unknown",
      providerConsensus: "none",
      providerBreakdown: [],
      publicationEligible: false,
      eligibleModuleClasses: ["none"],
    };
  }

  // Sort by precision (descending), then by confidence
  const sorted = [...results].sort((a, b) => {
    const levelDiff = GEO_MATCH_LEVEL_RANK[b.resultPrecision] - GEO_MATCH_LEVEL_RANK[a.resultPrecision];
    if (levelDiff !== 0) return levelDiff;
    return b.providerConfidence - a.providerConfidence;
  });

  const primary = sorted[0];

  // Check city consensus
  const cities = results.map(r => normalizeCity(r.city)).filter(c => c.length > 0);
  const uniqueCities = [...new Set(cities)];
  let consensus: GeoResolutionResult["providerConsensus"] = "single";
  let confidenceAdjustment = 0;

  if (results.length >= 2) {
    if (uniqueCities.length === 1 && cities.length >= 2) {
      consensus = "strong";
      confidenceAdjustment = GEO_GATING.CONSENSUS_BONUS;
    } else if (uniqueCities.length > 1) {
      consensus = "partial";
      confidenceAdjustment = -GEO_GATING.DISAGREEMENT_PENALTY;
    }
  }

  // Photo evidence bonus (if civico matches)
  let photoBonus = 0;
  if (photoEvidence?.visibleHouseNumber && primary.houseNumber) {
    const photoNum = photoEvidence.visibleHouseNumber.replace(/\D/g, "");
    const geoNum = primary.houseNumber.replace(/\D/g, "");
    if (photoNum && geoNum && photoNum === geoNum) {
      photoBonus = 0.05 * (photoEvidence.confidence ?? 0.5);
    }
  }

  // Final confidence
  const rawConfidence = primary.providerConfidence + confidenceAdjustment + photoBonus;
  const geoConfidence = Math.max(0, Math.min(1, parseFloat(rawConfidence.toFixed(3))));

  // Match level from primary
  const geoMatchLevel = primary.resultPrecision;
  const matchRank = GEO_MATCH_LEVEL_RANK[geoMatchLevel];

  // Publication gating
  const eligibleModuleClasses: GeoResolutionResult["eligibleModuleClasses"] = [];

  if (geoConfidence >= GEO_GATING.MIN_PUBLISH && matchRank >= GEO_GATING.MIN_MICROZONA_LEVEL) {
    eligibleModuleClasses.push("microzona");
    eligibleModuleClasses.push("comunali");
  } else if (geoConfidence >= GEO_GATING.MIN_PUBLISH && matchRank >= GEO_GATING.MIN_COMUNALI_LEVEL) {
    eligibleModuleClasses.push("comunali");
  } else {
    eligibleModuleClasses.push("none");
  }

  const publicationEligible = !eligibleModuleClasses.includes("none");

  // Build confidence reason
  const reasons: string[] = [];
  reasons.push(`Provider primario: ${primary.provider} (${geoMatchLevel}, ${(primary.providerConfidence * 100).toFixed(0)}%)`);
  if (consensus === "strong") reasons.push(`Consenso forte: ${results.length} provider concordano su ${uniqueCities[0]}`);
  if (consensus === "partial") reasons.push(`Disaccordo: provider indicano città diverse (${uniqueCities.join(", ")})`);
  if (photoBonus > 0) reasons.push("Civico confermato dalla foto");
  reasons.push(`Livello match: ${geoMatchLevel}, confidenza finale: ${(geoConfidence * 100).toFixed(0)}%`);

  return {
    resolvedAddress: primary.formattedAddress || null,
    resolvedComune: primary.city ? primary.city.toUpperCase() : null,
    resolvedProvincia: primary.province || null,
    resolvedStreet: primary.street || null,
    resolvedHouseNumber: primary.houseNumber || null,
    resolvedPostalCode: primary.postalCode || null,
    resolvedLat: primary.lat,
    resolvedLng: primary.lng,
    geoConfidence,
    geoConfidenceReason: reasons.join(". "),
    geoMatchLevel,
    providerConsensus: consensus,
    providerBreakdown: results.map(r => ({
      provider: r.provider,
      matchLevel: r.resultPrecision,
      confidence: r.providerConfidence,
      city: r.city,
      street: r.street,
      houseNumber: r.houseNumber,
    })),
    publicationEligible,
    eligibleModuleClasses,
  };
}

// ── Main Resolution Function ──────────────────────────────────

/**
 * Resolve coordinates to a structured address using multi-provider chain.
 * - Queries all available providers in priority order
 * - Merges results with confidence scoring
 * - Returns publication-gated result
 */
export async function resolveGeo(
  lat: number,
  lng: number,
  photoEvidence?: { visibleHouseNumber?: string; visibleStreetName?: string; confidence?: number },
): Promise<GeoResolutionResult> {
  const providers = getProviderChain();
  const available = providers.filter(p => p.isAvailable());

  if (available.length === 0) {
    console.warn("[geo] No geocoding providers available");
    return mergeGeoResults([], lat, lng);
  }

  // Query all available providers in parallel for speed
  const promises = available.map(async (provider) => {
    try {
      return await provider.reverseGeocode(lat, lng);
    } catch (e) {
      console.warn(`[geo:${provider.name}] Failed: ${String(e).slice(0, 80)}`);
      return null;
    }
  });

  const rawResults = await Promise.all(promises);
  const results = rawResults.filter((r): r is GeocodingProviderResult => r !== null);

  console.log(`[geo] ${results.length}/${available.length} providers returned results`);

  return mergeGeoResults(results, lat, lng, photoEvidence);
}

// ── Exports for testing ───────────────────────────────────────

export { GEO_MATCH_LEVEL_RANK, GEO_GATING };
