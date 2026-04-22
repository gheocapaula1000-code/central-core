// ═══════════════════════════════════════════════════════════════
// Property Detail — Providers (Phase 2 — Real)
// Identity:   real (OMI zone geometry + Nominatim)
// Valuation:  real (OMI valori per comune + zona)
// Territory:  real (OMI zone + ISTAT demographics + ISPRA + sismica)
// Signals:    honest unavailable (no real signal source wired in V1)
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

const TODAY = () => new Date().toISOString().slice(0, 10);

// ── Identity Provider (REAL) ──────────────────────────────────

export interface IdentityContext {
  comune: string;          // e.g. "PADOVA" (from OMI zone)
  comuneIstat: string;     // 6/8-digit ISTAT code
  provincia: string;
  linkZona: string | null; // e.g. "PD00000015"
  zona: string | null;     // e.g. "B1"
  zonaDescr: string | null;
}

export interface IdentityProviderResult {
  result: ProviderResult<IdentityBlock>;
  context: IdentityContext | null;
}

export async function resolveIdentity(
  lat: number,
  lng: number,
  debugId: string,
): Promise<IdentityProviderResult> {
  const startMs = Date.now();
  console.log(`[property-detail:identity] start lat=${lat} lng=${lng} debug_id=${debugId}`);

  try {
    const supabase = getSupabase();

    const { data: zones, error: rpcErr } = await supabase
      .rpc("omi_zone_by_point", { p_lat: lat, p_lng: lng });

    if (rpcErr) {
      console.error(`[property-detail:identity] RPC error: ${rpcErr.message} debug_id=${debugId}`);
      return {
        result: { outcome: "failed", data: null, provenance: null, error: `omi_zone_by_point: ${rpcErr.message}` },
        context: null,
      };
    }

    if (!zones || zones.length === 0) {
      console.log(`[property-detail:identity] no OMI zone for (${lat}, ${lng}) debug_id=${debugId}`);
      return {
        result: { outcome: "unavailable", data: null, provenance: null },
        context: null,
      };
    }

    const primaryZone = zones[0];
    const comune: string = primaryZone.comune_descrizione;
    const provincia: string = primaryZone.provincia;
    const comuneIstat: string = primaryZone.comune_istat;
    const linkZona: string | null = primaryZone.link_zona ?? null;
    const zona: string | null = primaryZone.zona ?? null;
    const zonaDescr: string | null = primaryZone.zona_descr ?? null;

    // Reverse geocode via Nominatim for address detail
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
    }

    const provenance: BlockProvenance = {
      source: "omi_zone_geometry+nominatim",
      confidence: confidenceLabel(geoMatchLevel),
      updatedAt: TODAY(),
    };

    const durationMs = Date.now() - startMs;
    console.log(`[property-detail:identity] resolved comune=${comune} zona=${zona} match=${geoMatchLevel} duration_ms=${durationMs} debug_id=${debugId}`);

    return {
      result: {
        outcome: "resolved",
        data: {
          indirizzo: street,
          civico: houseNumber,
          comune,
          provincia,
          cap: postalCode,
          coordinate: { lat, lng },
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
      },
      context: { comune, comuneIstat, provincia, linkZona, zona, zonaDescr },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[property-detail:identity] unexpected error: ${msg.slice(0, 120)} debug_id=${debugId}`);
    return {
      result: { outcome: "failed", data: null, provenance: null, error: msg.slice(0, 120) },
      context: null,
    };
  }
}

// ── Valuation Provider (REAL) ─────────────────────────────────
// Strategy:
//   1. Filter omi_valori by comune_descrizione
//   2. Prefer zone match via link_zona (point-in-polygon result)
//   3. Restrict to "Abitazioni civili" residential typology
//   4. Prefer stato "NORMALE" → fall back to OTTIMO
//   5. Use compr_min/compr_max as the price range (€/m²)
//   6. Median of midpoints as prezzoStimato
//   7. Confidence: alta if zone match, media if comune-only, bassa if missing typology

export async function resolveValuation(
  context: IdentityContext,
  debugId: string,
): Promise<ProviderResult<ValuationBlock>> {
  const startMs = Date.now();
  console.log(`[property-detail:valuation] start comune=${context.comune} zona=${context.linkZona ?? "n/a"} debug_id=${debugId}`);

  try {
    const supabase = getSupabase();

    // Step 1: try zone-precise lookup
    let rows: Array<{ compr_min: number | null; compr_max: number | null; stato: string | null; descr_tipologia: string | null; link_zona: string | null }> = [];
    let matchScope: "zone" | "comune" = "zone";

    if (context.linkZona) {
      const { data, error } = await supabase
        .from("omi_valori")
        .select("compr_min, compr_max, stato, descr_tipologia, link_zona")
        .eq("comune_descrizione", context.comune)
        .eq("link_zona", context.linkZona)
        .eq("descr_tipologia", "Abitazioni civili");
      if (error) {
        console.error(`[property-detail:valuation] zone query error: ${error.message} debug_id=${debugId}`);
        return { outcome: "failed", data: null, provenance: null, error: error.message };
      }
      rows = (data ?? []) as typeof rows;
    }

    // Step 2: fallback to comune-wide if zone empty
    if (rows.length === 0) {
      matchScope = "comune";
      const { data, error } = await supabase
        .from("omi_valori")
        .select("compr_min, compr_max, stato, descr_tipologia, link_zona")
        .eq("comune_descrizione", context.comune)
        .eq("descr_tipologia", "Abitazioni civili");
      if (error) {
        console.error(`[property-detail:valuation] comune query error: ${error.message} debug_id=${debugId}`);
        return { outcome: "failed", data: null, provenance: null, error: error.message };
      }
      rows = (data ?? []) as typeof rows;
    }

    if (rows.length === 0) {
      console.log(`[property-detail:valuation] no OMI valori for comune=${context.comune} debug_id=${debugId}`);
      return { outcome: "unavailable", data: null, provenance: null };
    }

    // Prefer NORMALE; fall back to all
    const normale = rows.filter((r) => r.stato === "NORMALE");
    const usable = normale.length > 0 ? normale : rows;

    const valid = usable.filter((r) => Number.isFinite(r.compr_min) && Number.isFinite(r.compr_max) && (r.compr_min as number) > 0 && (r.compr_max as number) > 0);
    if (valid.length === 0) {
      console.log(`[property-detail:valuation] no valid price ranges debug_id=${debugId}`);
      return { outcome: "unavailable", data: null, provenance: null };
    }

    const mins = valid.map((r) => r.compr_min as number);
    const maxs = valid.map((r) => r.compr_max as number);
    const prezzoMinimo = Math.round(Math.min(...mins));
    const prezzoMassimo = Math.round(Math.max(...maxs));
    const midpoints = valid.map((r) => ((r.compr_min as number) + (r.compr_max as number)) / 2).sort((a, b) => a - b);
    const prezzoStimato = Math.round(midpoints[Math.floor(midpoints.length / 2)]);

    const stateNote = normale.length > 0 ? "stato NORMALE" : `stato misto (${[...new Set(rows.map((r) => r.stato).filter(Boolean))].join(", ")})`;
    const drivers = `Valori OMI Abitazioni civili — ${matchScope === "zone" ? `zona ${context.zona ?? context.linkZona}` : `media comunale ${context.comune}`}, ${stateNote}, ${valid.length} fasc${valid.length === 1 ? "ia" : "e"} di prezzo €/m².`;

    const confidence = matchScope === "zone" ? "alta" : "media";

    const provenance: BlockProvenance = {
      source: matchScope === "zone" ? "omi_valori (zona)" : "omi_valori (comune)",
      confidence,
      updatedAt: TODAY(),
    };

    const durationMs = Date.now() - startMs;
    console.log(`[property-detail:valuation] resolved scope=${matchScope} stimato=${prezzoStimato} range=${prezzoMinimo}-${prezzoMassimo} duration_ms=${durationMs} debug_id=${debugId}`);

    return {
      outcome: "resolved",
      data: {
        prezzoStimato,
        prezzoMinimo,
        prezzoMassimo,
        drivers,
        provenance,
      },
      provenance,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[property-detail:valuation] unexpected error: ${msg.slice(0, 120)} debug_id=${debugId}`);
    return { outcome: "failed", data: null, provenance: null, error: msg.slice(0, 120) };
  }
}

// ── Territory Provider (REAL) ─────────────────────────────────
// Sources:
//   - omi_zone_by_point (zone description, fascia, microzona) → already in context
//   - istat_comuni (demographics)
//   - ispra_rischio (hydraulic + landslide risk)
//   - classificazione_sismica (seismic zone)
// Outputs are honest: only fields that resolve from data are populated.

function normalizeIstatCode(code: string): { short: string; long: string } {
  // ISTAT uses 6 digits at comune level; classificazione_sismica often uses 8 digits (region+comune).
  const digits = code.replace(/[^0-9]/g, "");
  if (digits.length >= 6) {
    return { short: digits.slice(-6), long: digits.padStart(8, "0") };
  }
  return { short: digits, long: digits };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function bandLabel(score: number): string {
  // score in 0..100
  if (score >= 75) return "alta";
  if (score >= 50) return "media";
  if (score >= 25) return "bassa";
  return "molto bassa";
}

export async function resolveTerritory(
  context: IdentityContext,
  debugId: string,
): Promise<ProviderResult<TerritoryBlock>> {
  const startMs = Date.now();
  console.log(`[property-detail:territory] start comune=${context.comune} debug_id=${debugId}`);

  try {
    const supabase = getSupabase();
    const codes = normalizeIstatCode(context.comuneIstat);

    const [istatRes, ispraRes, sismicaRes] = await Promise.all([
      supabase
        .from("istat_comuni")
        .select("popolazione, eta_media, percentuale_over65, percentuale_under35")
        .eq("codice_istat", codes.short)
        .maybeSingle(),
      supabase
        .from("ispra_rischio")
        .select("frana_p3_perc, frana_p4_perc, idro_p3_perc, pop_idro_p3, pop_frana_p3p4")
        .eq("codice_istat", codes.short)
        .maybeSingle(),
      supabase
        .from("classificazione_sismica")
        .select("zona_sismica")
        .or(`codice_istat.eq.${codes.short},codice_istat.eq.${codes.long}`)
        .maybeSingle(),
    ]);

    const istat = istatRes.data as { popolazione?: number; eta_media?: number; percentuale_over65?: number; percentuale_under35?: number } | null;
    const ispra = ispraRes.data as { frana_p3_perc?: number; frana_p4_perc?: number; idro_p3_perc?: number; pop_idro_p3?: number; pop_frana_p3p4?: number } | null;
    const sismica = sismicaRes.data as { zona_sismica?: number } | null;

    // If all enrichment sources are empty AND no OMI zone description, we have nothing real to say.
    const hasZone = !!context.zonaDescr;
    if (!istat && !ispra && !sismica && !hasZone) {
      console.log(`[property-detail:territory] no enrichment data debug_id=${debugId}`);
      return { outcome: "unavailable", data: null, provenance: null };
    }

    // Compose microZona from real OMI data
    const microZona = context.zonaDescr
      ? `Zona OMI ${context.zona ?? ""} — ${context.zonaDescr}`.trim()
      : null;

    // Sommario from demographics (only when istat present)
    let sommario: string | null = null;
    if (istat) {
      const pop = istat.popolazione ?? null;
      const eta = istat.eta_media ?? null;
      const parts: string[] = [];
      if (pop !== null) parts.push(`${pop.toLocaleString("it-IT")} abitanti`);
      if (eta !== null) parts.push(`età media ${eta.toFixed(1)} anni`);
      if (parts.length > 0) sommario = `${context.comune.charAt(0) + context.comune.slice(1).toLowerCase()}: ${parts.join(", ")}.`;
    }

    // Honest puntiForti / criticita from data thresholds
    const puntiForti: string[] = [];
    const criticita: string[] = [];

    if (sismica?.zona_sismica !== undefined && sismica.zona_sismica !== null) {
      const z = sismica.zona_sismica;
      if (z >= 4) puntiForti.push("Rischio sismico molto basso (zona 4)");
      else if (z === 3) puntiForti.push("Rischio sismico basso (zona 3)");
      else if (z === 2) criticita.push("Rischio sismico medio (zona 2)");
      else if (z === 1) criticita.push("Rischio sismico alto (zona 1)");
    }

    if (ispra) {
      const idroP3 = ispra.idro_p3_perc ?? 0;
      const fraP34 = (ispra.frana_p3_perc ?? 0) + (ispra.frana_p4_perc ?? 0);
      if (idroP3 >= 15) criticita.push(`Rischio idraulico significativo (${idroP3.toFixed(1)}% del territorio in P3)`);
      else if (idroP3 < 5) puntiForti.push(`Rischio idraulico contenuto (${idroP3.toFixed(1)}% in P3)`);
      if (fraP34 >= 5) criticita.push(`Rischio frana significativo (${fraP34.toFixed(1)}% in P3/P4)`);
      else if (fraP34 < 1) puntiForti.push("Rischio frana trascurabile");
    }

    if (istat?.percentuale_over65 !== undefined && istat.percentuale_over65 !== null) {
      const o65 = istat.percentuale_over65;
      if (o65 >= 28) criticita.push(`Popolazione anziana elevata (${o65.toFixed(1)}% over 65)`);
      else if (o65 <= 20) puntiForti.push(`Popolazione mediamente giovane (${o65.toFixed(1)}% over 65)`);
    }

    // Indicatori — honest derivation, only when supportable
    let indicatori: TerritoryBlock["indicatori"] = null;
    if (ispra || sismica) {
      // sicurezza: invert combined natural risk
      let sicurezzaScore = 100;
      if (sismica?.zona_sismica !== undefined && sismica.zona_sismica !== null) {
        // zona 1=alto rischio, 4=basso → score 25/50/75/100
        sicurezzaScore = clamp(sismica.zona_sismica * 25, 25, 100);
      }
      if (ispra) {
        const idroP3 = ispra.idro_p3_perc ?? 0;
        const fraP34 = (ispra.frana_p3_perc ?? 0) + (ispra.frana_p4_perc ?? 0);
        sicurezzaScore = clamp(sicurezzaScore - idroP3 * 1.5 - fraP34 * 2, 0, 100);
      }
      indicatori = {
        vivibilita: null, // honest: no robust dataset for general livability
        sicurezza: bandLabel(sicurezzaScore),
        rumore: null,     // honest: no real noise dataset wired
        servizi: null,    // honest: schools dataset is empty
      };
    }

    const sources = [
      "omi_zone",
      istat ? "istat_comuni" : null,
      ispra ? "ispra_rischio" : null,
      sismica ? "classificazione_sismica" : null,
    ].filter(Boolean).join("+");

    const confidence = (istat && ispra && sismica) ? "alta" : (istat || ispra) ? "media" : "bassa";

    const provenance: BlockProvenance = {
      source: sources,
      confidence,
      updatedAt: TODAY(),
    };

    const durationMs = Date.now() - startMs;
    console.log(`[property-detail:territory] resolved sources=${sources} duration_ms=${durationMs} debug_id=${debugId}`);

    return {
      outcome: "resolved",
      data: {
        microZona,
        sommario,
        puntiForti: puntiForti.length > 0 ? puntiForti : null,
        criticita: criticita.length > 0 ? criticita : null,
        indicatori,
        scenarioFuturo: null, // honest: no real scenario projection wired
        provenance,
      },
      provenance,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[property-detail:territory] unexpected error: ${msg.slice(0, 120)} debug_id=${debugId}`);
    return { outcome: "failed", data: null, provenance: null, error: msg.slice(0, 120) };
  }
}

// ── Signals Provider (HONEST UNAVAILABLE) ─────────────────────
// V1 has no real signal source dataset (urbanism plans, infrastructure
// announcements, etc.) wired in. Returning fabricated signals would
// violate the data integrity policy. This stays unavailable until a
// real provider is integrated.

export async function resolveSignals(
  _context: IdentityContext,
  debugId: string,
): Promise<ProviderResult<SignalsBlock>> {
  console.log(`[property-detail:signals] unavailable (no real signal source wired) debug_id=${debugId}`);
  return { outcome: "unavailable", data: null, provenance: null };
}
