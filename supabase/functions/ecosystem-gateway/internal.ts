// ═══════════════════════════════════════════════════════════════
// EcoSystem Gateway — Internal best-effort calls to Sottra
// ═══════════════════════════════════════════════════════════════

import type { PropertyInput } from "./types.ts";

const INTERNAL_TIMEOUT_MS = 12_000;

/**
 * Derive the Supabase functions base URL from the current request URL.
 * Pattern: same origin, path prefix /functions/v1/
 * Returns null if not determinable.
 */
function deriveBaseUrl(reqUrl: string): string | null {
  try {
    const u = new URL(reqUrl);
    // Supabase edge functions share the same origin
    return `${u.protocol}//${u.host}/functions/v1`;
  } catch {
    return null;
  }
}

/**
 * Build sanitized body for Sottra scan/market.
 */
function buildMarketBody(prop: PropertyInput): Record<string, unknown> {
  return {
    address: prop.address ?? "",
    comune: prop.comune ?? "",
    provincia: prop.provincia ?? "",
    lat: prop.lat ?? 0,
    lng: prop.lng ?? 0,
    street: prop.street ?? "",
    houseNumber: prop.houseNumber ?? "",
    propertyType: prop.propertyType ?? "residenziale",
    areaSqm: prop.areaSqm ?? 0,
    finalIdentityConfidence: prop.finalIdentityConfidence ?? 0,
    geoMatchLevel: prop.geoMatchLevel ?? "",
  };
}

/**
 * Build sanitized body for Sottra forecast/sviluppo-area.
 */
function buildAreaBody(prop: PropertyInput): Record<string, unknown> {
  return {
    address: prop.address ?? "",
    comune: prop.comune ?? "",
    provincia: prop.provincia ?? "",
    lat: prop.lat ?? 0,
    lng: prop.lng ?? 0,
  };
}

interface InternalCallResult {
  ok: boolean;
  data: unknown;
  warning?: string;
}

async function internalPost(
  baseUrl: string,
  route: string,
  body: Record<string, unknown>,
  secret: string,
  debugId: string,
): Promise<InternalCallResult> {
  const url = `${baseUrl}/${route}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INTERNAL_TIMEOUT_MS);

  try {
    console.log(`[ecosystem-gateway] internal call route=${route} debug_id=${debugId}`);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": secret,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(text); } catch { parsed = {}; }

    if (!res.ok || parsed.ok === false) {
      const errCode = (parsed.error as Record<string, unknown>)?.code ?? res.status;
      return { ok: false, data: null, warning: `${route} returned ${errCode}` };
    }

    return { ok: true, data: parsed.data ?? parsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ecosystem-gateway] internal call failed route=${route} debug_id=${debugId}: ${msg}`);
    return { ok: false, data: null, warning: `${route} unavailable: ${msg.includes("abort") ? "timeout" : "error"}` };
  } finally {
    clearTimeout(timer);
  }
}

export interface EnrichmentResult {
  sottra_market: unknown;
  sottra_area_development: unknown;
  availability: { market: boolean; areaDevelopment: boolean };
  warnings: string[];
}

/**
 * Best-effort enrichment via Sottra internal calls.
 * Never throws — always returns partial results with warnings.
 */
export async function enrichFromSottra(
  reqUrl: string,
  property: PropertyInput,
  options: { includeMarket?: boolean; includeAreaDevelopment?: boolean },
  debugId: string,
): Promise<EnrichmentResult> {
  const result: EnrichmentResult = {
    sottra_market: null,
    sottra_area_development: null,
    availability: { market: false, areaDevelopment: false },
    warnings: [],
  };

  const baseUrl = deriveBaseUrl(reqUrl);
  if (!baseUrl) {
    result.warnings.push("Cannot determine internal base URL for Sottra calls");
    return result;
  }

  const secret = Deno.env.get("AI_CORE_SECRET") ?? "";
  if (!secret) {
    result.warnings.push("AI_CORE_SECRET not available for internal calls");
    return result;
  }

  // Check minimum data for Sottra calls
  const hasGeo = typeof property.lat === "number" && typeof property.lng === "number" && property.lat !== 0 && property.lng !== 0;
  const hasComune = !!property.comune;

  if (!hasGeo && !hasComune) {
    result.warnings.push("Insufficient geo data for Sottra enrichment (need lat/lng or comune)");
    return result;
  }

  const promises: Promise<void>[] = [];

  if (options.includeMarket !== false) {
    promises.push(
      internalPost(baseUrl, "sottra/scan/market", buildMarketBody(property), secret, debugId)
        .then((r) => {
          if (r.ok) { result.sottra_market = r.data; result.availability.market = true; }
          else if (r.warning) result.warnings.push(r.warning);
        })
    );
  }

  if (options.includeAreaDevelopment !== false) {
    promises.push(
      internalPost(baseUrl, "sottra/forecast/sviluppo-area", buildAreaBody(property), secret, debugId)
        .then((r) => {
          if (r.ok) { result.sottra_area_development = r.data; result.availability.areaDevelopment = true; }
          else if (r.warning) result.warnings.push(r.warning);
        })
    );
  }

  await Promise.allSettled(promises);
  return result;
}
