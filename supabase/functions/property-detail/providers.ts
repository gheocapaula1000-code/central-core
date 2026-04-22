// ═══════════════════════════════════════════════════════════════
// Property Detail — Providers (Phase 3 — Real micro-area)
// Identity:   real (OMI zone geometry + Nominatim) — exposes precisionLevel
// Valuation:  real (OMI valori per comune + zona) — sqm only, NO fake totals
// Territory:  real (OMI zone + ISTAT + ISPRA + sismica) with per-indicator
//             provenance and honest spatial scope
// Signals:    honest unavailable (no real signal source wired in V1)
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type {
  ProviderResult,
  IdentityBlock,
  ValuationBlock,
  TerritoryBlock,
  TerritoryIndicator,
  TerritoryIndicators,
  SignalsBlock,
  BlockProvenance,
  PrecisionLevel,
} from "./types.ts";
import { makeProvenance } from "./contract.ts";
import { boundingBox, haversineMeters, smallestContainingRadius, radiusToSpatialScope } from "./geo.ts";

// ── Padova Comune scope (V1 territorial limit) ─────────────────
// Canonical OMI keys for Comune di Padova.
const PADOVA_COMUNE_ISTAT_LONG = "5028060";
const PADOVA_COMUNE_ISTAT_SHORT = "028060";
const PADOVA_COMUNE_DESCR = "PADOVA";

function isPadovaZone(zone: { comune_istat?: string | null; comune_descrizione?: string | null }): boolean {
  const istat = (zone.comune_istat ?? "").trim();
  const descr = (zone.comune_descrizione ?? "").trim().toUpperCase();
  return (
    istat === PADOVA_COMUNE_ISTAT_LONG ||
    istat === PADOVA_COMUNE_ISTAT_SHORT ||
    descr === PADOVA_COMUNE_DESCR
  );
}

// ── Supabase Client ───────────────────────────────────────────

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured");
  return createClient(url, key);
}

const TODAY = () => new Date().toISOString().slice(0, 10);

// ── Identity Provider (REAL) ──────────────────────────────────

export interface IdentityContext {
  comune: string;
  comuneIstat: string;
  provincia: string;
  linkZona: string | null;
  zona: string | null;
  zonaDescr: string | null;
  precisionLevel: PrecisionLevel;
  coords: { lat: number; lng: number };
}

export interface IdentityProviderResult {
  result: ProviderResult<IdentityBlock>;
  context: IdentityContext | null;
}

function geoMatchToPrecision(rank: number, hasHouseNumber: boolean, hasStreet: boolean): PrecisionLevel {
  if (rank >= 30 && hasHouseNumber) return "civic";
  if (rank >= 26 && hasStreet) return "street";
  return "comune";
}

function precisionToConfidence(p: PrecisionLevel): "alta" | "media" | "bassa" {
  if (p === "building" || p === "civic") return "alta";
  if (p === "street" || p === "microzone") return "media";
  return "bassa";
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
      return { result: { outcome: "unavailable", data: null, provenance: null }, context: null };
    }

    const primaryZone = zones[0];

    // ── Padova-only territorial scope ──
    if (!isPadovaZone(primaryZone)) {
      console.log(
        `[property-detail:identity] outside Padova Comune (zone_comune=${primaryZone.comune_descrizione ?? "?"} istat=${primaryZone.comune_istat ?? "?"}) → property_not_found debug_id=${debugId}`,
      );
      return { result: { outcome: "unavailable", data: null, provenance: null }, context: null };
    }
    console.log(`[property-detail:identity] Padova boundary OK istat=${primaryZone.comune_istat} debug_id=${debugId}`);

    const comune: string = primaryZone.comune_descrizione;
    const provincia: string = primaryZone.provincia;
    const comuneIstat: string = primaryZone.comune_istat;
    const linkZona: string | null = primaryZone.link_zona ?? null;
    const zona: string | null = primaryZone.zona ?? null;
    const zonaDescr: string | null = primaryZone.zona_descr ?? null;

    let street: string | null = null;
    let houseNumber: string | null = null;
    let postalCode: string | null = null;
    let precision: PrecisionLevel = linkZona ? "microzone" : "comune";

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
          const rank = Number(geo.address_rank ?? 0);
          const geoPrecision = geoMatchToPrecision(rank, !!houseNumber, !!street);
          // Take the more precise of the two signals.
          if (geoPrecision === "civic" || geoPrecision === "street") {
            precision = geoPrecision;
          }
        }
      }
    } catch (e) {
      console.warn(`[property-detail:identity] nominatim fallback: ${String(e).slice(0, 80)} debug_id=${debugId}`);
    }

    const microZona = zonaDescr ? `Zona OMI ${zona ?? ""} — ${zonaDescr}`.trim() : null;

    const provenance: BlockProvenance = makeProvenance({
      source: "omi_zone_geometry+nominatim",
      confidence: precisionToConfidence(precision),
      precisionLevel: precision,
      spatialScope: precision === "civic" || precision === "street" ? "point" : (linkZona ? "microzone" : "comune"),
    });

    const durationMs = Date.now() - startMs;
    console.log(`[property-detail:identity] resolved comune=${comune} zona=${zona} precision=${precision} duration_ms=${durationMs} debug_id=${debugId}`);

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
          precisionLevel: precision,
          microZona,
          zonaOmi: zona,
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
      context: { comune, comuneIstat, provincia, linkZona, zona, zonaDescr, precisionLevel: precision, coords: { lat, lng } },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[property-detail:identity] unexpected error: ${msg.slice(0, 120)} debug_id=${debugId}`);
    return { result: { outcome: "failed", data: null, provenance: null, error: msg.slice(0, 120) }, context: null };
  }
}

// ── Valuation Provider (REAL — sqm semantics, NO fake totals) ─────

export async function resolveValuation(
  context: IdentityContext,
  debugId: string,
): Promise<ProviderResult<ValuationBlock>> {
  const startMs = Date.now();
  console.log(`[property-detail:valuation] start comune=${context.comune} zona=${context.linkZona ?? "n/a"} debug_id=${debugId}`);

  try {
    const supabase = getSupabase();

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

    const normale = rows.filter((r) => r.stato === "NORMALE");
    const usable = normale.length > 0 ? normale : rows;

    const valid = usable.filter((r) =>
      Number.isFinite(r.compr_min) && Number.isFinite(r.compr_max) &&
      (r.compr_min as number) > 0 && (r.compr_max as number) > 0
    );
    if (valid.length === 0) {
      console.log(`[property-detail:valuation] no valid price ranges debug_id=${debugId}`);
      return { outcome: "unavailable", data: null, provenance: null };
    }

    const mins = valid.map((r) => r.compr_min as number);
    const maxs = valid.map((r) => r.compr_max as number);
    const prezzoMqMinimo = Math.round(Math.min(...mins));
    const prezzoMqMassimo = Math.round(Math.max(...maxs));
    const midpoints = valid.map((r) => ((r.compr_min as number) + (r.compr_max as number)) / 2).sort((a, b) => a - b);
    const prezzoMqStimato = Math.round(midpoints[Math.floor(midpoints.length / 2)]);

    const stateNote = normale.length > 0
      ? "stato NORMALE"
      : `stato misto (${[...new Set(rows.map((r) => r.stato).filter(Boolean))].join(", ")})`;
    const drivers = `Valori OMI Abitazioni civili — ${matchScope === "zone" ? `zona ${context.zona ?? context.linkZona}` : `media comunale ${context.comune}`}, ${stateNote}, ${valid.length} fasc${valid.length === 1 ? "ia" : "e"} di prezzo €/m².`;

    const provenance: BlockProvenance = makeProvenance({
      source: matchScope === "zone" ? "omi_valori (zona)" : "omi_valori (comune)",
      confidence: matchScope === "zone" ? "alta" : "media",
      precisionLevel: matchScope === "zone" ? "microzone" : "comune",
      spatialScope: matchScope === "zone" ? "microzone" : "comune",
    });

    const durationMs = Date.now() - startMs;
    console.log(`[property-detail:valuation] resolved scope=${matchScope} mq_stimato=${prezzoMqStimato} range=${prezzoMqMinimo}-${prezzoMqMassimo} totals=null(no_real_inputs) duration_ms=${durationMs} debug_id=${debugId}`);

    return {
      outcome: "resolved",
      data: {
        prezzoMqStimato,
        prezzoMqMinimo,
        prezzoMqMassimo,
        // Honest: no real surface/state inputs → no fabricated totals.
        prezzoTotaleStimato: null,
        prezzoTotaleMinimo: null,
        prezzoTotaleMassimo: null,
        unita: "EUR_per_mq",
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

function normalizeIstatCode(code: string): { short: string; long: string } {
  const digits = code.replace(/[^0-9]/g, "");
  if (digits.length >= 6) return { short: digits.slice(-6), long: digits.padStart(8, "0") };
  return { short: digits, long: digits };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function bandLabel(score: number): string {
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

    const hasZone = !!context.zonaDescr;
    if (!istat && !ispra && !sismica && !hasZone) {
      console.log(`[property-detail:territory] no enrichment data debug_id=${debugId}`);
      return { outcome: "unavailable", data: null, provenance: null };
    }

    const microZona = context.zonaDescr
      ? `Zona OMI ${context.zona ?? ""} — ${context.zonaDescr}`.trim()
      : null;

    let sommario: string | null = null;
    if (istat) {
      const parts: string[] = [];
      if (istat.popolazione != null) parts.push(`${istat.popolazione.toLocaleString("it-IT")} abitanti`);
      if (istat.eta_media != null) parts.push(`età media ${istat.eta_media.toFixed(1)} anni`);
      if (parts.length > 0) {
        sommario = `${context.comune.charAt(0) + context.comune.slice(1).toLowerCase()}: ${parts.join(", ")}.`;
      }
    }

    const puntiForti: string[] = [];
    const criticita: string[] = [];

    if (sismica?.zona_sismica != null) {
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

    if (istat?.percentuale_over65 != null) {
      const o65 = istat.percentuale_over65;
      if (o65 >= 28) criticita.push(`Popolazione anziana elevata (${o65.toFixed(1)}% over 65)`);
      else if (o65 <= 20) puntiForti.push(`Popolazione mediamente giovane (${o65.toFixed(1)}% over 65)`);
    }

    // ── Per-indicator structured derivation ────────────────────
    const indicatori: TerritoryIndicators = {
      sicurezzaAmbientale: null,
      rischioIdrogeologico: null,
      profiloDemografico: null,
      residenzialita: null,
      // Honest unavailable: no real datasets wired for these in V1.
      serviziProssimita: null,
      verdeProssimita: null,
      accessibilita: null,
      pressioneTraffico: null,
      rumoreProxy: null,
    };
    const indicatorsResolvedNames: string[] = [];
    const indicatorsUnavailableNames = ["serviziProssimita", "verdeProssimita", "accessibilita", "pressioneTraffico", "rumoreProxy"];

    if (sismica || ispra) {
      let safetyScore = 100;
      if (sismica?.zona_sismica != null) {
        safetyScore = clamp(sismica.zona_sismica * 25, 25, 100);
      }
      if (ispra) {
        const idroP3 = ispra.idro_p3_perc ?? 0;
        const fraP34 = (ispra.frana_p3_perc ?? 0) + (ispra.frana_p4_perc ?? 0);
        safetyScore = clamp(safetyScore - idroP3 * 1.5 - fraP34 * 2, 0, 100);
      }
      const safetyProv = makeProvenance({
        source: [sismica ? "classificazione_sismica" : null, ispra ? "ispra_rischio" : null].filter(Boolean).join("+"),
        confidence: sismica && ispra ? "alta" : "media",
        precisionLevel: "comune",
        spatialScope: "comune",
      });
      indicatori.sicurezzaAmbientale = {
        value: bandLabel(safetyScore),
        kind: "environmental_risk_inverse",
        provenance: safetyProv,
      };
      indicatorsResolvedNames.push("sicurezzaAmbientale");
    }

    if (ispra) {
      const idroP3 = ispra.idro_p3_perc ?? 0;
      const fraP34 = (ispra.frana_p3_perc ?? 0) + (ispra.frana_p4_perc ?? 0);
      const hydroScore = clamp(idroP3 * 2 + fraP34 * 2, 0, 100);
      indicatori.rischioIdrogeologico = {
        value: bandLabel(hydroScore),
        kind: "environmental_risk_inverse",
        provenance: makeProvenance({
          source: "ispra_rischio",
          confidence: "alta",
          precisionLevel: "comune",
          spatialScope: "comune",
        }),
      };
      indicatorsResolvedNames.push("rischioIdrogeologico");
    }

    if (istat?.eta_media != null || istat?.percentuale_over65 != null) {
      const o65 = istat?.percentuale_over65 ?? null;
      const profile = o65 == null
        ? `età media ${istat!.eta_media!.toFixed(1)}`
        : (o65 >= 28 ? "anziana" : o65 <= 20 ? "giovane" : "equilibrata");
      indicatori.profiloDemografico = {
        value: profile,
        kind: "demographic_age_profile",
        provenance: makeProvenance({
          source: "istat_comuni",
          confidence: "alta",
          precisionLevel: "comune",
          spatialScope: "comune",
        }),
      };
      indicatorsResolvedNames.push("profiloDemografico");
    }

    if (context.zonaDescr) {
      indicatori.residenzialita = {
        value: context.zonaDescr.toLowerCase().includes("centr") ? "centrale" : "residenziale",
        kind: "residential_density",
        provenance: makeProvenance({
          source: "omi_zone",
          confidence: "media",
          precisionLevel: "microzone",
          spatialScope: "microzone",
        }),
      };
      indicatorsResolvedNames.push("residenzialita");
    }

    const blockSources = [
      "omi_zone",
      istat ? "istat_comuni" : null,
      ispra ? "ispra_rischio" : null,
      sismica ? "classificazione_sismica" : null,
    ].filter(Boolean).join("+");

    const blockConfidence: "alta" | "media" | "bassa" =
      (istat && ispra && sismica) ? "alta" : (istat || ispra) ? "media" : "bassa";

    const provenance: BlockProvenance = makeProvenance({
      source: blockSources,
      confidence: blockConfidence,
      precisionLevel: hasZone ? "microzone" : "comune",
      spatialScope: hasZone ? "microzone" : "comune",
    });

    const durationMs = Date.now() - startMs;
    console.log(
      `[property-detail:territory] resolved sources=${blockSources} indicators_resolved=[${indicatorsResolvedNames.join(",")}] indicators_unavailable=[${indicatorsUnavailableNames.join(",")}] duration_ms=${durationMs} debug_id=${debugId}`,
    );

    return {
      outcome: "resolved",
      data: {
        microZona,
        sommario,
        puntiForti: puntiForti.length > 0 ? puntiForti : null,
        criticita: criticita.length > 0 ? criticita : null,
        indicatori,
        scenarioFuturo: null, // honest: no real area-development source wired
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
// announcements, transformation maps) wired in. Returning fabricated
// signals would violate the data integrity policy.

export async function resolveSignals(
  _context: IdentityContext,
  debugId: string,
): Promise<ProviderResult<SignalsBlock>> {
  console.log(`[property-detail:signals] unavailable (no real signal source wired) debug_id=${debugId}`);
  return { outcome: "unavailable", data: null, provenance: null };
}

// Re-export for tests / callers that previously imported from here.
export type { TerritoryIndicator };
