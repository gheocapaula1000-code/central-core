// Sottra — OMI Lookup: real price data from Agenzia delle Entrate
// v3.4: Coordinate-first (polygon match) with address fallback

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callAI } from "./shared.ts";
import {
  pickOfficialValoriRow,
  remapPolygonToOfficialZone,
  type OfficialZoneRow,
} from "./omi-zone-join.ts";
import { presentPadovaSellableArea } from "./padova-omi-areas.ts";

// ── Match Method Hierarchy (strongest → weakest) ──────────────
// polygon_match > single_zone > ai_matched > ai_fallback > first_zone_fallback > none

export type OMIMatchMethod =
  | "polygon_match"
  | "single_zone"
  | "comune_aggregate"
  | "ai_matched"
  | "ai_fallback"
  | "first_zone_fallback"
  | "none";

export type OMIGeoLevel = "microzona_omi" | "comune" | "none";

export interface OMIResult {
  found: boolean;
  zona?: string;
  zona_descr?: string;
  comune?: string;
  compr_min?: number;
  compr_max?: number;
  prezzoMedio?: number;
  loc_min?: number;
  loc_max?: number;
  tipologia?: string;
  stato?: string;
  fonte: string;
  /** Confidence of the OMI zone match (0-1). Below 0.5 = not publishable. */
  matchConfidence: number;
  /** How the zone was determined */
  matchMethod: OMIMatchMethod;
  /** Whether the zone was resolved via spatial polygon containment */
  polygonMatch: boolean;
  /** Precision level of the OMI geo resolution */
  omiGeoLevel: OMIGeoLevel;
  /** Human-readable precision label */
  pricingPrecisionLabel: string;
  /** Coverage level for downstream modules */
  sourceCoverageLevel: "microzona" | "comunale" | "none";
  /** Why this confidence was assigned */
  confidenceReason: string;
  /** Limitations for downstream consumers */
  limitations: string[];
  /** Official OMI letter (B1, C3, …). Never an invented code. */
  officialMicrozona?: string;
  /** Sottra sellable area id (Padova 8-area map only). */
  areaId?: string;
  areaName?: string;
  tutteZone?: Array<{
    zona: string;
    zona_descr: string;
    compr_min: number | null;
    compr_max: number | null;
    loc_min: number | null;
    loc_max: number | null;
    tipologia: string;
  }>;
}

const FONTE = "Agenzia Entrate — OMI, 1° semestre 2025";

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return createClient(url, key);
}

/**
 * Extract comune name from an Italian address.
 * E.g. "Via Guido Reni 8, 35133 Padova" → "PADOVA"
 */
export function extractComune(address: string): string {
  const cleaned = address.replace(/\b\d{5}\b/g, "").trim();
  const parts = cleaned.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && /^ital/i.test(parts[parts.length - 1])) {
    parts.pop();
  }
  const last = parts[parts.length - 1] ?? "";
  const withoutProv = last.replace(/\s+[A-Z]{2}$/, "").trim();
  return withoutProv.toUpperCase();
}

// ── Helper: fetch OMI valori for a set of link_zona ───────────

interface ZoneSummaryItem {
  zona: string;
  zona_descr: string;
  link_zona: string;
  compr_min: number | null;
  compr_max: number | null;
  loc_min: number | null;
  loc_max: number | null;
  tipologia: string;
}

async function fetchValoriForZones(
  supabase: ReturnType<typeof getSupabase>,
  linkZone: string[],
  codTip: number,
): Promise<ZoneSummaryItem[]> {
  // Try with tipologia filter first
  const { data: valori } = await supabase
    .from("omi_valori")
    .select("*")
    .in("link_zona", linkZone)
    .eq("cod_tip", codTip);

  if (valori && valori.length > 0) return valori as unknown as ZoneSummaryItem[];

  // Fallback: without tipologia
  const { data: allValori } = await supabase
    .from("omi_valori")
    .select("*")
    .in("link_zona", linkZone);

  return (allValori ?? []) as unknown as ZoneSummaryItem[];
}

function buildResult(
  zone: ZoneSummaryItem,
  matchMethod: OMIMatchMethod,
  matchConfidence: number,
  polygonMatch: boolean,
  comuneStr: string,
  allZones: ZoneSummaryItem[] | null,
  confidenceReason: string,
  limitations: string[],
): OMIResult {
  const comprMin = zone.compr_min;
  const comprMax = zone.compr_max;
  const prezzoMedio = comprMin != null && comprMax != null
    ? Math.round((comprMin + comprMax) / 2)
    : null;

  const omiGeoLevel: OMIGeoLevel = polygonMatch ? "microzona_omi" : (matchMethod === "single_zone" ? "microzona_omi" : matchMethod === "none" ? "none" : "comune");
  const sourceCoverageLevel = omiGeoLevel === "microzona_omi" ? "microzona" as const : omiGeoLevel === "none" ? "none" as const : "comunale" as const;

  const pricingPrecisionLabel = polygonMatch
    ? `Microzona OMI ${zone.zona} — match spaziale (polygon)`
    : matchMethod === "single_zone"
      ? `Microzona OMI ${zone.zona} — zona unica nel comune`
      : matchMethod === "comune_aggregate"
        ? `Range OMI comunale — ${allZones?.length ?? 0} zone, senza match poligono`
        : matchMethod === "ai_matched"
          ? `Zona OMI ${zone.zona} — identificazione AI (non verificata spazialmente)`
          : `Zona OMI ${zone.zona} — fallback`;

  return {
    found: true,
    zona: matchMethod === "comune_aggregate" ? undefined : zone.zona,
    zona_descr: zone.zona_descr,
    comune: comuneStr,
    compr_min: comprMin ?? undefined,
    compr_max: comprMax ?? undefined,
    prezzoMedio: prezzoMedio ?? undefined,
    loc_min: zone.loc_min ?? undefined,
    loc_max: zone.loc_max ?? undefined,
    tipologia: zone.tipologia || "Abitazioni civili",
    stato: "NORMALE",
    fonte: FONTE,
    matchConfidence,
    matchMethod,
    polygonMatch,
    omiGeoLevel,
    pricingPrecisionLabel,
    sourceCoverageLevel,
    confidenceReason,
    limitations,
    officialMicrozona: matchMethod === "comune_aggregate" ? undefined : zone.zona,
    tutteZone: allZones?.map((z) => ({
      zona: z.zona,
      zona_descr: z.zona_descr,
      compr_min: z.compr_min,
      compr_max: z.compr_max,
      loc_min: z.loc_min,
      loc_max: z.loc_max,
      tipologia: z.tipologia,
    })) ?? undefined,
  };
}

function notFoundResult(comuneStr?: string, reason?: string): OMIResult {
  return {
    found: false,
    comune: comuneStr,
    fonte: FONTE,
    matchConfidence: 0,
    matchMethod: "none",
    polygonMatch: false,
    omiGeoLevel: "none",
    pricingPrecisionLabel: "Nessun dato OMI disponibile",
    sourceCoverageLevel: "none",
    confidenceReason: reason ?? "Nessun dato OMI trovato",
    limitations: [reason ?? "Nessun dato OMI trovato"],
  };
}

// ══════════════════════════════════════════════════════════════
// PRIMARY: Coordinate-first lookup via PostGIS point-in-polygon
// ══════════════════════════════════════════════════════════════

/**
 * Lookup OMI data using coordinates (lat, lng) via spatial polygon match.
 * This is the PREFERRED method when coordinates are available.
 * Uses PostGIS ST_Contains on omi_zone_geometry table.
 */
export async function lookupOMIByCoordinates(
  lat: number,
  lng: number,
  codTip = 20,
): Promise<OMIResult> {
  const supabase = getSupabase();

  console.log(`[omi-lookup:coordinates] Attempting polygon match for (${lat}, ${lng}), codTip=${codTip}`);

  try {
    // Call the RPC for point-in-polygon
    const { data: polygonZones, error: rpcErr } = await supabase
      .rpc("omi_zone_by_point", { p_lat: lat, p_lng: lng });

    if (rpcErr) {
      console.warn(`[omi-lookup:coordinates] RPC error: ${rpcErr.message}`);
      return notFoundResult(undefined, `Polygon lookup failed: ${rpcErr.message}`);
    }

    if (!polygonZones || polygonZones.length === 0) {
      console.log(`[omi-lookup:coordinates] No polygon match for (${lat}, ${lng})`);
      return notFoundResult(undefined, "Coordinate fuori dai poligoni OMI importati");
    }

    const comuneStr = (polygonZones[0].comune_descrizione as string).toUpperCase();

    // Geometry rows on Core use synthetic keys (e.g. G224-B1). Official
    // omi_zone / omi_valori use Agenzia delle Entrate link_zona (PD00000015).
    // Join by unique comune+zona. Never invent a letter if the join is not unique.
    const { data: officialZones, error: zoneJoinErr } = await supabase
      .from("omi_zone")
      .select("zona,zona_descr,link_zona,comune_descrizione,comune_amm")
      .ilike("comune_descrizione", comuneStr);

    if (zoneJoinErr) {
      console.warn(`[omi-lookup:coordinates] omi_zone join error: ${zoneJoinErr.message}`);
    }

    const remapped = (polygonZones as Record<string, unknown>[]).map((pz) => ({
      polygon: pz,
      official: remapPolygonToOfficialZone(
        {
          zona: String(pz.zona ?? ""),
          link_zona: String(pz.link_zona ?? ""),
          comune_descrizione: String(pz.comune_descrizione ?? comuneStr),
        },
        (officialZones ?? []) as OfficialZoneRow[],
      ),
    }));

    const officialMatched = remapped.filter((r): r is { polygon: Record<string, unknown>; official: OfficialZoneRow } => r.official != null);
    if (officialMatched.length === 0) {
      console.log(`[omi-lookup:coordinates] Polygon hit but no unique official omi_zone join for ${comuneStr} keys=${(polygonZones as Record<string, unknown>[]).map((z) => z.link_zona).join(",")}`);
      return notFoundResult(
        comuneStr,
        "Poligono OMI trovato ma link_zona non allineato a omi_zone — nessuna zona inventata",
      );
    }

    const linkZone = [...new Set(officialMatched.map((r) => r.official.link_zona))];
    let valori = await fetchValoriForZones(supabase, linkZone, codTip) as unknown as Record<string, unknown>[];

    if (valori.length === 0) {
      const zoneCodes = [...new Set(officialMatched.map((r) => r.official.zona))];
      const { data: byZona } = await supabase
        .from("omi_valori")
        .select("*")
        .ilike("comune_descrizione", comuneStr)
        .in("zona", zoneCodes)
        .eq("cod_tip", codTip);
      valori = (byZona ?? []) as Record<string, unknown>[];
    }

    if (valori.length === 0) {
      console.log(`[omi-lookup:coordinates] Official zone joined but no valori for link_zone=${linkZone.join(",")}`);
      return notFoundResult(comuneStr, "Poligono OMI trovato ma nessun valore disponibile per la tipologia richiesta");
    }

    const zoneSummary: ZoneSummaryItem[] = officialMatched.map(({ official }) => {
      const rows = valori.filter((val) =>
        val.link_zona === official.link_zona || String(val.zona ?? "").toUpperCase() === official.zona.toUpperCase()
      );
      const v = pickOfficialValoriRow(rows);
      return {
        zona: official.zona,
        zona_descr: official.zona_descr ?? "",
        link_zona: official.link_zona,
        compr_min: (v?.compr_min as number | null) ?? null,
        compr_max: (v?.compr_max as number | null) ?? null,
        loc_min: (v?.loc_min as number | null) ?? null,
        loc_max: (v?.loc_max as number | null) ?? null,
        tipologia: (v?.descr_tipologia as string) ?? (v?.tipologia as string) ?? "",
      };
    });

    // Filter to zones that have actual pricing data
    const zonesWithPricing = zoneSummary.filter(z => z.compr_min != null && z.compr_max != null);

    if (zonesWithPricing.length === 0) {
      return notFoundResult(comuneStr, "Poligono OMI trovato ma nessun prezzo disponibile");
    }

    if (zonesWithPricing.length === 1) {
      // Single polygon match — highest confidence
      console.log(`[omi-lookup:coordinates] Single polygon match: zona=${zonesWithPricing[0].zona}`);
      return buildResult(
        zonesWithPricing[0],
        "polygon_match",
        0.98,
        true,
        comuneStr,
        zoneSummary,
        `Match spaziale univoco: il punto (${lat}, ${lng}) cade nel poligono OMI zona ${zonesWithPricing[0].zona}`,
        [],
      );
    }

    // Multiple polygon matches (point on boundary or overlapping zones)
    // Pick the zone with the narrowest price range (most specific)
    const sorted = [...zonesWithPricing].sort((a, b) => {
      const rangeA = (a.compr_max ?? 0) - (a.compr_min ?? 0);
      const rangeB = (b.compr_max ?? 0) - (b.compr_min ?? 0);
      return rangeA - rangeB; // narrower range = more specific
    });

    console.log(`[omi-lookup:coordinates] Multiple polygon matches (${zonesWithPricing.length}), picking narrowest range: zona=${sorted[0].zona}`);
    return buildResult(
      sorted[0],
      "polygon_match",
      0.90, // slightly lower for ambiguous multi-polygon
      true,
      comuneStr,
      zoneSummary,
      `Match spaziale: ${zonesWithPricing.length} poligoni candidati, selezionato ${sorted[0].zona} (range più stretto, scelta deterministica)`,
      [`${zonesWithPricing.length} poligoni OMI contengono il punto — zona selezionata per range più stretto`],
    );
  } catch (e) {
    console.error(`[omi-lookup:coordinates] Unexpected error: ${String(e).slice(0, 120)}`);
    return notFoundResult(undefined, `Errore nel polygon lookup: ${String(e).slice(0, 80)}`);
  }
}

// ══════════════════════════════════════════════════════════════
// FALLBACK: Address-based lookup (AI zone matching demoted)
// ══════════════════════════════════════════════════════════════

/**
 * Lookup OMI data for a given address.
 * AI is used ONLY to identify the correct OMI zone — prices come from the DB.
 * Returns matchConfidence to let callers gate on data quality.
 *
 * NOTE: This is now a FALLBACK. Use lookupOMIByCoordinates when coords are available.
 */
export async function lookupOMI(address: string, codTip = 20): Promise<OMIResult> {
  const comuneStr = extractComune(address);
  if (!comuneStr) return notFoundResult(undefined, "Impossibile estrarre il comune dall'indirizzo");

  const supabase = getSupabase();

  // 1. Find zones for this comune
  const { data: zone, error: zoneErr } = await supabase
    .from("omi_zone")
    .select("*")
    .ilike("comune_descrizione", comuneStr);

  if (zoneErr || !zone || zone.length === 0) {
    return notFoundResult(comuneStr, `Comune "${comuneStr}" non trovato nel dataset OMI`);
  }

  // 2. Get values for all zones of this comune (filtered by tipologia)
  const linkZone = zone.map((z: Record<string, unknown>) => z.link_zona as string);
  const valori = await fetchValoriForZones(supabase, linkZone, codTip);

  if (valori.length === 0) {
    return notFoundResult(comuneStr, `Nessun valore OMI per il comune "${comuneStr}" con tipologia richiesta`);
  }

  // 3. Build zone summary
  const zoneSummary: ZoneSummaryItem[] = zone.map((z: Record<string, unknown>) => {
    const v = valori.find((val: Record<string, unknown>) => val.link_zona === z.link_zona);
    return {
      zona: z.zona as string,
      zona_descr: (z.zona_descr as string) ?? (z.fascia as string) ?? "",
      link_zona: z.link_zona as string,
      compr_min: (v?.compr_min as number | null) ?? null,
      compr_max: (v?.compr_max as number | null) ?? null,
      loc_min: (v?.loc_min as number | null) ?? null,
      loc_max: (v?.loc_max as number | null) ?? null,
      tipologia: (v?.descr_tipologia as string) ?? "",
    };
  });

  // 4. Determine best zone
  let bestZone = zoneSummary[0];
  let matchConfidence: number;
  let matchMethod: OMIMatchMethod;
  let confidenceReason: string;
  const limitations: string[] = [];

  if (zoneSummary.length === 1) {
    matchConfidence = 0.95;
    matchMethod = "single_zone";
    confidenceReason = `Zona unica nel comune ${comuneStr}: ${bestZone.zona}`;
  } else {
    // Multiple zones — AI fallback (demoted from primary to secondary)
    const zoneList = zoneSummary
      .map((z) => `- ${z.zona}: ${z.zona_descr}`)
      .join("\n");

    const prompt = `Sei un esperto di zone OMI italiane. Data la lista di zone OMI del comune di ${comuneStr}:
${zoneList}

Quale zona corrisponde all'indirizzo "${address}"?
Rispondi SOLO con il codice zona (es. "B1", "C3", "D1"). Nient'altro.`;

    try {
      const output = await callAI(prompt, 20, 0.1);
      const zonaCodice = output.trim().replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      const match = zoneSummary.find((z) => z.zona.toUpperCase() === zonaCodice);
      if (match) {
        bestZone = match;
        matchConfidence = 0.60; // Demoted from 0.70 — AI match is less reliable than polygon
        matchMethod = "ai_matched";
        confidenceReason = `Zona ${zonaCodice} identificata tramite AI da indirizzo — NON verificata spazialmente`;
        limitations.push(
          "Zona OMI determinata tramite AI da indirizzo, non da match spaziale su poligono",
          "Per precisione microzona usare lookup con coordinate e poligoni OMI",
        );
      } else {
        matchConfidence = 0.25;
        matchMethod = "ai_fallback";
        confidenceReason = `AI ha restituito zona non riconosciuta (${zonaCodice}) — fallback sulla prima zona`;
        limitations.push(
          "Zona OMI non determinabile con certezza dall'indirizzo",
          "Match AI fallito — zona selezionata non affidabile",
        );
      }
    } catch {
      matchConfidence = 0.20;
      matchMethod = "first_zone_fallback";
      confidenceReason = "AI non disponibile — prima zona del comune selezionata come fallback";
      limitations.push(
        "Zona OMI selezionata per fallback — nessuna identificazione reale",
        "Consultare tutteZone per le zone disponibili nel comune",
      );
    }
  }

  return buildResult(
    bestZone,
    matchMethod,
    matchConfidence,
    false, // never polygon match from address lookup
    comuneStr,
    zoneSummary,
    confidenceReason,
    limitations,
  );
}

// ══════════════════════════════════════════════════════════════
// COMUNE-LEVEL: official table values without inventing a zone
// ══════════════════════════════════════════════════════════════

/**
 * Lookup OMI values for a comune from omi_zone + omi_valori.
 *
 * Core's omi_zone_geometry is a small sample (dozens of polygons, not
 * the national ~27k set). When a point misses the imported polygons we
 * still have real Agenzia delle Entrate rows at comune/zona level.
 *
 * - 1 zone in the comune → official single_zone (microzona by uniqueness)
 * - N zones → reale min/max comunale, no zone pick, labeled elaborated
 */
export async function lookupOMIByComune(comuneStr: string, codTip = 20): Promise<OMIResult> {
  const comune = comuneStr.trim().toUpperCase();
  if (!comune) return notFoundResult(undefined, "Comune mancante per lookup OMI");

  const supabase = getSupabase();
  const { data: zone, error: zoneErr } = await supabase
    .from("omi_zone")
    .select("*")
    .ilike("comune_descrizione", comune);

  if (zoneErr || !zone || zone.length === 0) {
    return notFoundResult(comune, `Comune "${comune}" non trovato nel dataset OMI`);
  }

  const linkZone = zone.map((z: Record<string, unknown>) => z.link_zona as string);
  const valori = await fetchValoriForZones(supabase, linkZone, codTip);
  if (valori.length === 0) {
    return notFoundResult(comune, `Nessun valore OMI per il comune "${comune}" con tipologia richiesta`);
  }

  const zoneSummary: ZoneSummaryItem[] = zone.map((z: Record<string, unknown>) => {
    const v = valori.find((val: Record<string, unknown>) => val.link_zona === z.link_zona);
    return {
      zona: z.zona as string,
      zona_descr: (z.zona_descr as string) ?? (z.fascia as string) ?? "",
      link_zona: z.link_zona as string,
      compr_min: (v?.compr_min as number | null) ?? null,
      compr_max: (v?.compr_max as number | null) ?? null,
      loc_min: (v?.loc_min as number | null) ?? null,
      loc_max: (v?.loc_max as number | null) ?? null,
      tipologia: (v?.descr_tipologia as string) ?? (v?.tipologia as string) ?? "",
    };
  });

  const zonesWithPricing = zoneSummary.filter((z) => z.compr_min != null && z.compr_max != null);
  if (zonesWithPricing.length === 0) {
    return notFoundResult(comune, `Nessun prezzo OMI disponibile per il comune "${comune}"`);
  }

  if (zonesWithPricing.length === 1) {
    return buildResult(
      zonesWithPricing[0],
      "single_zone",
      0.95,
      false,
      comune,
      zoneSummary,
      `Zona unica nel comune ${comune}: ${zonesWithPricing[0].zona}`,
      [],
    );
  }

  const comprMins = zonesWithPricing.map((z) => z.compr_min as number);
  const comprMaxs = zonesWithPricing.map((z) => z.compr_max as number);
  const locMins = zonesWithPricing.map((z) => z.loc_min).filter((n): n is number => n != null);
  const locMaxs = zonesWithPricing.map((z) => z.loc_max).filter((n): n is number => n != null);
  const aggregate: ZoneSummaryItem = {
    zona: "",
    zona_descr: `${zonesWithPricing.length} zone OMI nel comune`,
    link_zona: "",
    compr_min: Math.min(...comprMins),
    compr_max: Math.max(...comprMaxs),
    loc_min: locMins.length > 0 ? Math.min(...locMins) : null,
    loc_max: locMaxs.length > 0 ? Math.max(...locMaxs) : null,
    tipologia: zonesWithPricing[0].tipologia || "Abitazioni civili",
  };

  return buildResult(
    aggregate,
    "comune_aggregate",
    0.72,
    false,
    comune,
    zoneSummary,
    `Prezzi OMI ufficiali a livello comunale: ${zonesWithPricing.length} zone in ${comune}. Match spaziale non disponibile (omi_zone_geometry su Core è un campione, non il set nazionale).`,
    [
      "Nessun poligono OMI disponibile per questo punto su Central Core",
      "Range calcolato come min/max delle zone OMI ufficiali del comune — non è una microzona",
      "Nessuna zona specifica è stata scelta: consultare tutteZone",
    ],
  );
}

export interface ResolveOMIInput {
  lat?: number;
  lng?: number;
  address?: string;
  comune?: string;
  codTip?: number;
}

/**
 * Coordinates-first OMI resolution.
 * 1) Point-in-polygon, then official omi_zone/omi_valori join (never invent a letter)
 * 2) Unique zona in the comune → official single_zone
 * 3) Several zones and no polygon join → comune_aggregate (elaborated, no zona pick)
 * Never invents prices. Never prefers city min/max when a real zone match exists.
 */
export async function resolveOMIPricing(opts: ResolveOMIInput): Promise<OMIResult> {
  const codTip = opts.codTip ?? 20;

  if (opts.lat != null && opts.lng != null && Number.isFinite(opts.lat) && Number.isFinite(opts.lng)) {
    const byPoint = await lookupOMIByCoordinates(opts.lat, opts.lng, codTip);
    if (byPoint.found) return presentPadovaSellableArea(byPoint);
  }

  const comune = (opts.comune ?? (opts.address ? extractComune(opts.address) : "")).trim();
  if (comune) {
    const byComune = await lookupOMIByComune(comune, codTip);
    if (byComune.found) return presentPadovaSellableArea(byComune);
  }

  if (opts.address && opts.address.trim()) {
    return presentPadovaSellableArea(await lookupOMI(opts.address, codTip));
  }

  return presentPadovaSellableArea(notFoundResult(
    comune || undefined,
    "Nessun dato OMI per coordinate/comune/indirizzo. Poligoni Core insufficienti e comune non risolto.",
  ));
}
