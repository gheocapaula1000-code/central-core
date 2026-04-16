// ═══════════════════════════════════════════════════════════════
// Property Detail — Providers (Phase 1)
// Identity: real resolution via DB (OMI zone) + Nominatim
// Valuation/Territory/Signals: honest unavailable stubs
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type {
  ProviderResult,
  IdentityBlock,
  ValuationBlock,
  TerritoryBlock,
  SignalsBlock,
  BlockProvenance,
} from "./types.ts";

// ── Supabase Client ───────────────────────────────────────────

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured");
  return createClient(url, key);
}

// ── Confidence Mapping ────────────────────────────────────────

function confidenceLabel(level: string): string {
  if (level === "house_number") return "alta";
  if (level === "street") return "media";
  return "bassa";
}

// ── Identity Provider (REAL) ──────────────────────────────────

export async function resolveIdentity(
  lat: number,
  lng: number,
  debugId: string,
): Promise<ProviderResult<IdentityBlock>> {
  const startMs = Date.now();
  console.log(`[property-detail:identity] start lat=${lat} lng=${lng} debug_id=${debugId}`);

  try {
    const supabase = getSupabase();

    // Step 1: Spatial zone lookup — confirms point is in a known OMI zone (Veneto)
    const { data: zones, error: rpcErr } = await supabase
      .rpc("omi_zone_by_point", { p_lat: lat, p_lng: lng });

    if (rpcErr) {
      console.error(`[property-detail:identity] RPC error: ${rpcErr.message} debug_id=${debugId}`);
      return { outcome: "failed", data: null, provenance: null, error: `omi_zone_by_point: ${rpcErr.message}` };
    }

    if (!zones || zones.length === 0) {
      console.log(`[property-detail:identity] no OMI zone for (${lat}, ${lng}) debug_id=${debugId}`);
      return { outcome: "unavailable", data: null, provenance: null };
    }

    const primaryZone = zones[0];
    const comune = primaryZone.comune_descrizione;
    const provincia = primaryZone.provincia;

    // Step 2: Reverse geocode via Nominatim for address components
    let street: string | null = null;
    let houseNumber: string | null = null;
    let postalCode: string | null = null;
    let geoMatchLevel = "city";

    try {
      const nominatimRes = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=it&addressdetails=1`,
        {
          headers: { "User-Agent": "CentralCore/3.4 (property-detail)" },
          signal: AbortSignal.timeout(6_000),
        },
      );
      if (nominatimRes.ok) {
        const geo = await nominatimRes.json();
        const a = geo?.address;
        if (a) {
          street = a.road ?? a.pedestrian ?? a.street ?? null;
          houseNumber = a.house_number ?? null;
          postalCode = a.postcode ?? null;
          const rank = geo.address_rank ?? 0;
          geoMatchLevel = rank >= 30 && houseNumber ? "house_number" : rank >= 26 ? "street" : "city";
        }
      }
    } catch (e) {
      console.warn(`[property-detail:identity] nominatim fallback: ${String(e).slice(0, 80)} debug_id=${debugId}`);
      // Non-fatal — we already have comune/provincia from OMI zone
    }

    const provenance: BlockProvenance = {
      source: "omi_zone_geometry+nominatim",
      confidence: confidenceLabel(geoMatchLevel),
      updatedAt: new Date().toISOString().slice(0, 10), // date only
    };

    const durationMs = Date.now() - startMs;
    console.log(`[property-detail:identity] resolved comune=${comune} match=${geoMatchLevel} confidence=${provenance.confidence} duration_ms=${durationMs} debug_id=${debugId}`);

    // Map to frontend contract shape — only real resolved data, no fabrication
    return {
      outcome: "resolved",
      data: {
        indirizzo: street,
        civico: houseNumber,
        comune,
        provincia,
        cap: postalCode,
        coordinate: { lat, lng },
        // These fields are not available from geocoding — honest nulls
        tipologia: null,
        stato: null,
        superficieMq: null,
        locali: null,
        piano: null,
        annoCostruzione: null,
        classeEnergetica: null,
        provenance,
      },
      provenance,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[property-detail:identity] unexpected error: ${msg.slice(0, 120)} debug_id=${debugId}`);
    return { outcome: "failed", data: null, provenance: null, error: msg.slice(0, 120) };
  }
}

// ── Valuation Provider (Phase 1B — STUB, honest unavailable) ──

export async function resolveValuation(
  _lat: number,
  _lng: number,
  _comune: string,
  debugId: string,
): Promise<ProviderResult<ValuationBlock>> {
  console.log(`[property-detail:valuation] unavailable (provider not wired) debug_id=${debugId}`);
  return { outcome: "unavailable", data: null, provenance: null };
}

// ── Territory Provider (Phase 1B — STUB, honest unavailable) ──

export async function resolveTerritory(
  _lat: number,
  _lng: number,
  _comune: string,
  debugId: string,
): Promise<ProviderResult<TerritoryBlock>> {
  console.log(`[property-detail:territory] unavailable (provider not wired) debug_id=${debugId}`);
  return { outcome: "unavailable", data: null, provenance: null };
}

// ── Signals Provider (Phase 1B — STUB, honest unavailable) ───

export async function resolveSignals(
  _lat: number,
  _lng: number,
  _comune: string,
  debugId: string,
): Promise<ProviderResult<SignalsBlock>> {
  console.log(`[property-detail:signals] unavailable (provider not wired) debug_id=${debugId}`);
  return { outcome: "unavailable", data: null, provenance: null };
}
