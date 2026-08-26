// Sottra — OMI Lookup: real price data from Agenzia delle Entrate
// v3.5: Official omi_valori quotes attached per resolved link_zona (SELECT-only)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callAI } from "./shared.ts";
import {
  pickOfficialValoriRow,
  remapPolygonToOfficialZone,
  mapValoriRowsToQuotes,
  pickCivileHeadlineFromQuotes,
  type OfficialZoneRow,
  type OfficialOmiQuote,
} from "./omi-zone-join.ts";
import { presentPadovaSellableArea } from "./padova-omi-areas.ts";

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
  matchConfidence: number;
  matchMethod: OMIMatchMethod;
  polygonMatch: boolean;
  omiGeoLevel: OMIGeoLevel;
  pricingPrecisionLabel: string;
  sourceCoverageLevel: "microzona" | "comunale" | "none";
  confidenceReason: string;
  limitations: string[];
  officialMicrozona?: string;
  areaId?: string;
  areaName?: string;
  quotes?: OfficialOmiQuote[];
  link_zona?: string;
  semestre?: string;
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
  const { data: valori } = await supabase
    .from("omi_valori")
    .select("*")
    .in("link_zona", linkZone)
    .eq("cod_tip", codTip);

  if (valori && valori.length > 0) return valori as unknown as ZoneSummaryItem[];

  const { data: allValori } = await supabase
    .from("omi_valori")
    .select("*")
    .in("link_zona", linkZone);

  return (allValori ?? []) as unknown as ZoneSummaryItem[];
}

/** READ-only: every official omi_valori row for one resolved link_zona. Never invents. */
export async function fetchOfficialQuotesForLink(
  supabase: ReturnType<typeof getSupabase>,
  linkZona: string,
): Promise<OfficialOmiQuote[]> {
  if (!linkZona) return [];
  const { data, error } = await supabase
    .from("omi_valori")
    .select("descr_tipologia,stato,compr_min,compr_max,loc_min,loc_max,semestre,link_zona")
    .eq("link_zona", linkZona);

  if (error) {
    console.warn(`[omi-lookup] fetchOfficialQuotesForLink error for ${linkZona}: ${error.message}`);
    return [];
  }
  return mapValoriRowsToQuotes((data ?? []) as Record<string, unknown>[]);
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
  quotes?: OfficialOmiQuote[],
): OMIResult {
  const officialQuotes = matchMethod === "comune_aggregate" ? [] : (quotes ?? []);
  const headline = officialQuotes.length > 0
    ? pickCivileHeadlineFromQuotes(officialQuotes)
    : null;
  const headlineQuote = headline
    ? officialQuotes.find((q) =>
      q.tipologia === headline.tipologia && q.stato === headline.stato
    )
    : null;

  const comprMin = headline?.min ?? zone.compr_min;
  const comprMax = headline?.max ?? zone.compr_max;
  const prezzoMedio = comprMin != null && comprMax != null
    ? Math.round((comprMin + comprMax) / 2)
    : null;
  const locMin = headlineQuote?.locMin ?? zone.loc_min;
  const locMax = headlineQuote?.locMax ?? zone.loc_max;
  const tipologia = headline?.tipologia || zone.tipologia || "Abitazioni civili";
  const stato = headline?.stato || "NORMALE";
  const semestre = officialQuotes.find((q) => q.semestre)?.semestre ?? undefined;
  const linkZona = matchMethod === "comune_aggregate" ? undefined : (zone.link_zona || undefined);

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
    loc_min: locMin ?? undefined,
    loc_max: locMax ?? undefined,
    tipologia,
    stato,
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
    quotes: officialQuotes.length > 0 ? officialQuotes : undefined,
    link_zona: linkZona,
    semestre,
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

export async function lookupOMIByCoordinates(
  lat: number,
  lng: number,
  codTip = 20,
): Promise<OMIResult> {
  const supabase = getSupabase();
  console.log(`[omi-lookup:coordinates] Attempting polygon match for (${lat}, ${lng}), codTip=${codTip}`);

  try {
    const { data: polygonZones, error: rpcErr } = await supabase
      .rpc("omi_zone_by_point", { p_lat: lat, p_lng: lng });

    if (rpcErr) {
      console.warn(`[omi-lookup:coordinates] RPC error: ${rpcErr.message}`);
      return notFoundResult(undefined, `Polygon lookup failed: ${rpcErr.message}`);
    }

    if (!polygonZones || polygonZones.length === 0) {
      return notFoundResult(undefined, "Coordinate fuori dai poligoni OMI importati");
    }

    const comuneStr = (polygonZones[0].comune_descrizione as string).toUpperCase();

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

    const zonesWithPricing = zoneSummary.filter(z => z.compr_min != null && z.compr_max != null);

    if (zonesWithPricing.length === 0) {
      return notFoundResult(comuneStr, "Poligono OMI trovato ma nessun prezzo disponibile");
    }

    if (zonesWithPricing.length === 1) {
      const winner = zonesWithPricing[0];
      const quotes = await fetchOfficialQuotesForLink(supabase, winner.link_zona);
      console.log(`[omi-lookup:coordinates] Single polygon match: zona=${winner.zona} quotes=${quotes.length}`);
      return buildResult(
        winner, "polygon_match", 0.98, true, comuneStr, zoneSummary,
        `Match spaziale univoco: il punto (${lat}, ${lng}) cade nel poligono OMI zona ${winner.zona}`,
        [], quotes,
      );
    }

    const sorted = [...zonesWithPricing].sort((a, b) => {
      const rangeA = (a.compr_max ?? 0) - (a.compr_min ?? 0);
      const rangeB = (b.compr_max ?? 0) - (b.compr_min ?? 0);
      return rangeA - rangeB;
    });

    const winner = sorted[0];
    const quotes = await fetchOfficialQuotesForLink(supabase, winner.link_zona);
    console.log(`[omi-lookup:coordinates] Multiple polygon matches (${zonesWithPricing.length}), picking: zona=${winner.zona} quotes=${quotes.length}`);
    return buildResult(
      winner, "polygon_match", 0.90, true, comuneStr, zoneSummary,
      `Match spaziale: ${zonesWithPricing.length} poligoni candidati, selezionato ${winner.zona} (range più stretto)`,
      [`${zonesWithPricing.length} poligoni OMI contengono il punto — zona selezionata per range più stretto`],
      quotes,
    );
  } catch (e) {
    console.error(`[omi-lookup:coordinates] Unexpected error: ${String(e).slice(0, 120)}`);
    return notFoundResult(undefined, `Errore nel polygon lookup: ${String(e).slice(0, 80)}`);
  }
}

export async function lookupOMI(address: string, codTip = 20): Promise<OMIResult> {
  const comuneStr = extractComune(address);
  if (!comuneStr) return notFoundResult(undefined, "Impossibile estrarre il comune dall'indirizzo");

  const supabase = getSupabase();

  const { data: zone, error: zoneErr } = await supabase
    .from("omi_zone")
    .select("*")
    .ilike("comune_descrizione", comuneStr);

  if (zoneErr || !zone || zone.length === 0) {
    return notFoundResult(comuneStr, `Comune "${comuneStr}" non trovato nel dataset OMI`);
  }

  const linkZone = zone.map((z: Record<string, unknown>) => z.link_zona as string);
  const valori = await fetchValoriForZones(supabase, linkZone, codTip);

  if (valori.length === 0) {
    return notFoundResult(comuneStr, `Nessun valore OMI per il comune "${comuneStr}" con tipologia richiesta`);
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
      tipologia: (v?.descr_tipologia as string) ?? "",
    };
  });

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
    const zoneList = zoneSummary.map((z) => `- ${z.zona}: ${z.zona_descr}`).join("\n");
    const prompt = `Sei un esperto di zone OMI italiane. Data la lista di zone OMI del comune di ${comuneStr}:\n${zoneList}\n\nQuale zona corrisponde all'indirizzo "${address}"?\nRispondi SOLO con il codice zona (es. "B1", "C3", "D1"). Nient'altro.`;

    try {
      const output = await callAI(prompt, 20, 0.1);
      const zonaCodice = output.trim().replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      const match = zoneSummary.find((z) => z.zona.toUpperCase() === zonaCodice);
      if (match) {
        bestZone = match;
        matchConfidence = 0.60;
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
        limitations.push("Zona OMI non determinabile con certezza dall'indirizzo");
      }
    } catch {
      matchConfidence = 0.20;
      matchMethod = "first_zone_fallback";
      confidenceReason = "AI non disponibile — prima zona del comune selezionata come fallback";
      limitations.push("Zona OMI selezionata per fallback — nessuna identificazione reale");
    }
  }

  const quotes = bestZone.link_zona
    ? await fetchOfficialQuotesForLink(supabase, bestZone.link_zona)
    : [];

  return buildResult(
    bestZone, matchMethod, matchConfidence, false, comuneStr, zoneSummary,
    confidenceReason, limitations, quotes,
  );
}

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
    const winner = zonesWithPricing[0];
    const quotes = await fetchOfficialQuotesForLink(supabase, winner.link_zona);
    return buildResult(
      winner, "single_zone", 0.95, false, comune, zoneSummary,
      `Zona unica nel comune ${comune}: ${winner.zona}`, [], quotes,
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
    aggregate, "comune_aggregate", 0.72, false, comune, zoneSummary,
    `Prezzi OMI ufficiali a livello comunale: ${zonesWithPricing.length} zone in ${comune}.`,
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

// Never prefers city min/max when a real zone match exists.
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
