// ═══════════════════════════════════════════════════════════════
// ICTV — Indice di Convergenza Territoriale Verificata
// 100% deterministic. No generative model decides scores.
// GPT used ONLY for post-scoring narrative rephrase.
// ═══════════════════════════════════════════════════════════════

import { ok, fail } from "../_shared/http.ts";
import { reverseGeocode, normalizeWithGPT } from "./shared.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Types ──

export type SignalFamily = "identita" | "mercato" | "demografia" | "rischio" | "sviluppo";
export type SignalDirection = "positivo" | "negativo" | "neutro";
export type SourceClass = "official_db" | "official_portal" | "official_imported" | "derived_from_official";
export type SpatialBand = "building" | "microarea" | "quartiere" | "comune";
export type ConvergenceLevel = "alta" | "media" | "bassa" | "insufficiente";
export type CoverageBand = "molto_forte" | "forte" | "interessante" | "debole";

export interface ICTVSignal {
  family: SignalFamily;
  label: string;
  source: string;
  direction: SignalDirection;
  rawStrength: number;
  sourceClass: SourceClass;
  freshnessMonths: number | null;
  spatialBand: SpatialBand;
  confidence: number;
}

// ── Weight tables ──

export const SOURCE_WEIGHT: Record<SourceClass, number> = {
  official_db: 1.00,
  official_portal: 0.95,
  official_imported: 0.90,
  derived_from_official: 0.75,
};

export function freshnessWeight(months: number | null): number {
  if (months === null) return 0.80;
  if (months <= 12) return 1.00;
  if (months <= 24) return 0.85;
  return 0.70;
}

export const SPATIAL_WEIGHT: Record<SpatialBand, number> = {
  building: 1.00,
  microarea: 0.90,
  quartiere: 0.75,
  comune: 0.60,
};

// ── Weighted signal computation ──

export function computeWeightedSignal(s: ICTVSignal): number {
  return s.rawStrength
    * SOURCE_WEIGHT[s.sourceClass]
    * freshnessWeight(s.freshnessMonths)
    * SPATIAL_WEIGHT[s.spatialBand]
    * s.confidence;
}

// ── Identity gate ──

export interface IdentityGateResult {
  scoreCap: number | null;
  multiplier: number;
  maxConvergence: ConvergenceLevel | null;
  limitation: string | null;
}

export function applyIdentityGate(identityConfidence: number | null): IdentityGateResult {
  if (identityConfidence === null || identityConfidence === undefined) {
    return { scoreCap: null, multiplier: 1, maxConvergence: null, limitation: null };
  }
  if (identityConfidence < 0.55) {
    return {
      scoreCap: 45,
      multiplier: 1,
      maxConvergence: "bassa",
      limitation: "Coerenza edificio/posizione bassa — punteggio limitato a 45",
    };
  }
  if (identityConfidence < 0.75) {
    return { scoreCap: null, multiplier: 0.90, maxConvergence: null, limitation: null };
  }
  return { scoreCap: null, multiplier: 1, maxConvergence: null, limitation: null };
}

// ── Aggregation ──

export interface AggregationResult {
  score: number;
  band: CoverageBand;
  convergenceLevel: ConvergenceLevel;
  coverageLevel: string;
  positiveFamilies: SignalFamily[];
  negativeFamilies: SignalFamily[];
  convergenceBonus: number;
  divergencePenalty: number;
  coveragePenalty: number;
}

export function aggregateSignals(
  signals: ICTVSignal[],
  identityConfidence: number | null,
): AggregationResult {
  // Group by family
  const familyMap = new Map<SignalFamily, { weighted: number; direction: SignalDirection }[]>();
  for (const s of signals) {
    const w = computeWeightedSignal(s);
    const directedW = s.direction === "negativo" ? -w : s.direction === "neutro" ? 0 : w;
    if (!familyMap.has(s.family)) familyMap.set(s.family, []);
    familyMap.get(s.family)!.push({ weighted: directedW, direction: s.direction });
  }

  const familyCount = familyMap.size;

  // Net contribution per family
  const familyContributions = new Map<SignalFamily, number>();
  for (const [fam, entries] of familyMap) {
    familyContributions.set(fam, entries.reduce((sum, e) => sum + e.weighted, 0));
  }

  // Positive / negative families
  const positiveFamilies: SignalFamily[] = [];
  const negativeFamilies: SignalFamily[] = [];
  for (const [fam, net] of familyContributions) {
    if (net > 0.5) positiveFamilies.push(fam);
    else if (net < -0.5) negativeFamilies.push(fam);
  }

  // Convergence bonus
  const concordantCount = Math.max(positiveFamilies.length, negativeFamilies.length);
  let convergenceBonus = 0;
  if (concordantCount >= 4) convergenceBonus = 14;
  else if (concordantCount >= 3) convergenceBonus = 9;
  else if (concordantCount >= 2) convergenceBonus = 4;

  // Divergence penalty
  let divergencePenalty = 0;
  if (positiveFamilies.length >= 2 && negativeFamilies.length >= 2) {
    divergencePenalty = -8;
  }

  // Coverage penalty
  let coveragePenalty = 0;
  if (familyCount >= 4) coveragePenalty = 0;
  else if (familyCount === 3) coveragePenalty = -6;
  else if (familyCount === 2) coveragePenalty = -12;
  // < 2 → insufficient

  // Coverage level label
  let coverageLevel: string;
  if (familyCount >= 5) coverageLevel = "completa";
  else if (familyCount === 4) coverageLevel = "buona";
  else if (familyCount === 3) coverageLevel = "parziale";
  else if (familyCount === 2) coverageLevel = "scarsa";
  else coverageLevel = "insufficiente";

  // Insufficient data guard
  if (familyCount < 2) {
    return {
      score: 0,
      band: "debole",
      convergenceLevel: "insufficiente",
      coverageLevel,
      positiveFamilies,
      negativeFamilies,
      convergenceBonus: 0,
      divergencePenalty: 0,
      coveragePenalty: 0,
    };
  }

  // Base score
  let score = 50;

  // Add family contributions (scaled — cap each family's net at ±15)
  for (const net of familyContributions.values()) {
    score += Math.max(-15, Math.min(15, net));
  }

  score += convergenceBonus;
  score += divergencePenalty;
  score += coveragePenalty;

  // Identity gate
  const gate = applyIdentityGate(identityConfidence);
  score *= gate.multiplier;
  if (gate.scoreCap !== null) score = Math.min(score, gate.scoreCap);

  // Clamp
  score = Math.max(0, Math.min(100, Math.round(score)));

  // Band
  let band: CoverageBand;
  if (score >= 75) band = "molto_forte";
  else if (score >= 60) band = "forte";
  else if (score >= 45) band = "interessante";
  else band = "debole";

  // Convergence level
  let convergenceLevel: ConvergenceLevel;
  if (concordantCount >= 3 && (coverageLevel === "buona" || coverageLevel === "completa")) {
    convergenceLevel = "alta";
  } else if (concordantCount >= 2 && familyCount >= 2) {
    convergenceLevel = "media";
  } else {
    convergenceLevel = "bassa";
  }

  // Apply identity gate cap on convergence
  if (gate.maxConvergence !== null) {
    const order: ConvergenceLevel[] = ["insufficiente", "bassa", "media", "alta"];
    const gateIdx = order.indexOf(gate.maxConvergence);
    const currentIdx = order.indexOf(convergenceLevel);
    if (currentIdx > gateIdx) convergenceLevel = gate.maxConvergence;
  }

  return {
    score,
    band,
    convergenceLevel,
    coverageLevel,
    positiveFamilies,
    negativeFamilies,
    convergenceBonus,
    divergencePenalty,
    coveragePenalty,
  };
}

// ── Signal collectors (from real DB data) ──

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
}

function extractComune(address: string): string {
  const cleaned = address.replace(/\b\d{5}\b/g, "").trim();
  const parts = cleaned.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && /^ital/i.test(parts[parts.length - 1])) parts.pop();
  const last = parts[parts.length - 1] ?? "";
  return last.replace(/\s+[A-Z]{2}$/, "").trim();
}

export async function collectSignals(
  comune: string,
  identityConfidence: number | null,
): Promise<ICTVSignal[]> {
  const supabase = getSupabase();
  const signals: ICTVSignal[] = [];

  // 1) Identity signal
  if (identityConfidence !== null && identityConfidence !== undefined) {
    signals.push({
      family: "identita",
      label: `Coerenza edificio/posizione: ${(identityConfidence * 100).toFixed(0)}%`,
      source: "scan/identify",
      direction: identityConfidence >= 0.75 ? "positivo" : identityConfidence >= 0.55 ? "neutro" : "negativo",
      rawStrength: identityConfidence * 10,
      sourceClass: "derived_from_official",
      freshnessMonths: 0,
      spatialBand: "building",
      confidence: identityConfidence,
    });
  }

  // Parallel DB queries
  const [omiResult, istatResult, ispraResult, sismicaResult] = await Promise.all([
    supabase.from("omi_valori")
      .select("compr_min, compr_max, loc_min, loc_max, stato_prev, zona")
      .ilike("comune_descrizione", comune.toUpperCase())
      .eq("descr_tipologia", "Abitazioni civili")
      .limit(20),
    supabase.from("istat_comuni")
      .select("popolazione, eta_media, percentuale_under35, percentuale_over65")
      .ilike("comune", comune)
      .limit(1)
      .maybeSingle(),
    supabase.from("ispra_rischio")
      .select("idro_p3_perc, frana_p4_perc, superficie_kmq")
      .ilike("comune", comune)
      .limit(1)
      .maybeSingle(),
    supabase.from("classificazione_sismica")
      .select("zona_sismica")
      .ilike("comune", comune)
      .limit(1)
      .maybeSingle(),
  ]);

  // 2) Market signals (OMI)
  const omiRows = omiResult.data ?? [];
  if (omiRows.length > 0) {
    const avgPrice = omiRows.reduce((s, r) => s + ((Number(r.compr_min ?? 0) + Number(r.compr_max ?? 0)) / 2), 0) / omiRows.length;
    const trends = omiRows.map(r => r.stato_prev).filter(Boolean);
    const crescita = trends.filter(s => /crescita|aumento|rialzo/i.test(s ?? "")).length;
    const calo = trends.filter(s => /calo|ribasso|diminuzione|flessione/i.test(s ?? "")).length;

    const trendDir: SignalDirection = crescita > calo ? "positivo" : calo > crescita ? "negativo" : "neutro";
    signals.push({
      family: "mercato",
      label: `Trend OMI: ${trendDir} (${omiRows.length} zone, media €${Math.round(avgPrice)}/mq)`,
      source: "OMI 2025/1",
      direction: trendDir,
      rawStrength: Math.min(avgPrice / 300, 10), // normalize to 0-10 range
      sourceClass: "official_db",
      freshnessMonths: 3,
      spatialBand: "comune",
      confidence: 0.90,
    });

    // Yield signal if rent data available
    const avgRent = omiRows.reduce((s, r) => s + ((Number(r.loc_min ?? 0) + Number(r.loc_max ?? 0)) / 2), 0) / omiRows.length;
    if (avgPrice > 0 && avgRent > 0) {
      const yieldPct = (avgRent * 12 / avgPrice) * 100;
      signals.push({
        family: "mercato",
        label: `Rendimento lordo indicativo: ${yieldPct.toFixed(1)}%`,
        source: "OMI 2025/1",
        direction: yieldPct > 5 ? "positivo" : yieldPct > 3 ? "neutro" : "negativo",
        rawStrength: Math.min(yieldPct, 10),
        sourceClass: "derived_from_official",
        freshnessMonths: 3,
        spatialBand: "comune",
        confidence: 0.80,
      });
    }
  }

  // 3) Demographics (ISTAT)
  if (istatResult.data) {
    const d = istatResult.data;
    const under35 = Number(d.percentuale_under35 ?? 0);
    const over65 = Number(d.percentuale_over65 ?? 0);
    const pop = Number(d.popolazione ?? 0);

    signals.push({
      family: "demografia",
      label: `Struttura demografica: under35 ${under35.toFixed(1)}%, over65 ${over65.toFixed(1)}%`,
      source: "ISTAT 2025",
      direction: under35 > 35 ? "positivo" : over65 > 30 ? "negativo" : "neutro",
      rawStrength: under35 > 35 ? 7 : over65 > 30 ? 6 : 4,
      sourceClass: "official_imported",
      freshnessMonths: 3,
      spatialBand: "comune",
      confidence: 0.95,
    });

    if (pop > 0) {
      signals.push({
        family: "demografia",
        label: `Popolazione: ${pop.toLocaleString("it-IT")} abitanti`,
        source: "ISTAT 2025",
        direction: pop > 50000 ? "positivo" : pop < 5000 ? "negativo" : "neutro",
        rawStrength: pop > 100000 ? 8 : pop > 50000 ? 6 : pop > 10000 ? 4 : 2,
        sourceClass: "official_imported",
        freshnessMonths: 3,
        spatialBand: "comune",
        confidence: 0.95,
      });
    }
  }

  // 4) Risk signals (ISPRA + Sismica)
  if (ispraResult.data) {
    const idro = Number(ispraResult.data.idro_p3_perc ?? 0);
    const frana = Number(ispraResult.data.frana_p4_perc ?? 0);

    signals.push({
      family: "rischio",
      label: `Rischio idrogeologico: P3 ${idro.toFixed(1)}%, frana P4 ${frana.toFixed(1)}%`,
      source: "ISPRA 2021",
      direction: (idro > 10 || frana > 10) ? "negativo" : (idro < 1 && frana < 1) ? "positivo" : "neutro",
      rawStrength: (idro > 10 || frana > 10) ? 8 : (idro < 1 && frana < 1) ? 6 : 4,
      sourceClass: "official_imported",
      freshnessMonths: 48,
      spatialBand: "comune",
      confidence: 0.90,
    });
  }

  if (sismicaResult.data) {
    const zona = sismicaResult.data.zona_sismica;
    signals.push({
      family: "rischio",
      label: `Classificazione sismica: zona ${zona}`,
      source: "OPCM 3519/2006",
      direction: zona === 1 ? "negativo" : zona === 4 ? "positivo" : "neutro",
      rawStrength: zona === 1 ? 9 : zona === 2 ? 6 : zona === 3 ? 3 : 5,
      sourceClass: "official_imported",
      freshnessMonths: null, // regulatory, no freshness decay
      spatialBand: "comune",
      confidence: 0.95,
    });
  }

  // 5) Development signals — from local DB only (no external API calls for determinism)
  // We derive a development signal from population density if ISPRA superficie available
  if (istatResult.data && ispraResult.data) {
    const pop = Number(istatResult.data.popolazione ?? 0);
    const sup = Number(ispraResult.data.superficie_kmq ?? 0);
    if (pop > 0 && sup > 0) {
      const densita = pop / sup;
      signals.push({
        family: "sviluppo",
        label: `Densità abitativa: ${Math.round(densita)} ab/km²`,
        source: "ISTAT 2025 + ISPRA 2021",
        direction: densita > 1000 ? "positivo" : densita < 50 ? "negativo" : "neutro",
        rawStrength: densita > 2000 ? 8 : densita > 500 ? 5 : densita > 100 ? 3 : 2,
        sourceClass: "derived_from_official",
        freshnessMonths: 3,
        spatialBand: "comune",
        confidence: 0.85,
      });
    }
  }

  // OMI zone diversity as development proxy
  if (omiRows.length > 0) {
    const uniqueZones = new Set(omiRows.map(r => r.zona)).size;
    if (uniqueZones >= 3) {
      signals.push({
        family: "sviluppo",
        label: `Mercato articolato su ${uniqueZones} zone OMI`,
        source: "OMI 2025/1",
        direction: uniqueZones >= 5 ? "positivo" : "neutro",
        rawStrength: uniqueZones >= 5 ? 6 : 3,
        sourceClass: "derived_from_official",
        freshnessMonths: 3,
        spatialBand: "comune",
        confidence: 0.75,
      });
    }
  }

  return signals;
}

// ── Evidence trace builder ──

function buildEvidenceTrace(
  signals: ICTVSignal[],
  familyContributions: Map<SignalFamily, number>,
): string[] {
  const families: SignalFamily[] = ["identita", "mercato", "demografia", "rischio", "sviluppo"];
  const trace: string[] = [];
  for (const fam of families) {
    const famSignals = signals.filter(s => s.family === fam);
    if (famSignals.length === 0) {
      trace.push(`${fam}: nessun dato disponibile`);
    } else {
      const net = familyContributions.get(fam) ?? 0;
      const dir = net > 0.5 ? "↑ positivo" : net < -0.5 ? "↓ negativo" : "→ neutro";
      const sources = [...new Set(famSignals.map(s => s.source))].join(", ");
      trace.push(`${fam}: ${dir} (${famSignals.length} segnali da ${sources})`);
    }
  }
  return trace;
}

// ── Handler ──

export async function handleForecastConvergenzaTerritoriale(
  req: Request,
  body: Record<string, unknown>,
  debugId: string,
): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  if (lat == null || lng == null) {
    return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);
  }

  const identityConfidence = (body.identityConfidence as number | undefined) ?? null;
  const address = (body.address as string) ?? await reverseGeocode(lat, lng) ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  const comune = extractComune(address);
  if (!comune) {
    return fail(req, 400, "COMUNE_NOT_FOUND", "Could not extract comune from address", debugId);
  }

  console.log(`[convergenza-territoriale] comune=${comune} debug_id=${debugId}`);

  // 1) Collect signals
  const signals = await collectSignals(comune, identityConfidence);

  // 2) Aggregate
  const result = aggregateSignals(signals, identityConfidence);

  // 3) Build evidence trace
  const familyMap = new Map<SignalFamily, number>();
  for (const s of signals) {
    const w = computeWeightedSignal(s);
    const directed = s.direction === "negativo" ? -w : s.direction === "neutro" ? 0 : w;
    familyMap.set(s.family, (familyMap.get(s.family) ?? 0) + directed);
  }
  const evidenceTrace = buildEvidenceTrace(signals, familyMap);

  // 4) Top signals
  const scored = signals.map(s => ({ ...s, _w: computeWeightedSignal(s) }));
  const topPositiveSignals = scored
    .filter(s => s.direction === "positivo")
    .sort((a, b) => b._w - a._w)
    .slice(0, 3)
    .map(s => ({ family: s.family, label: s.label, source: s.source, weightedStrength: Math.round(s._w * 100) / 100 }));
  const topNegativeSignals = scored
    .filter(s => s.direction === "negativo")
    .sort((a, b) => b._w - a._w)
    .slice(0, 3)
    .map(s => ({ family: s.family, label: s.label, source: s.source, weightedStrength: Math.round(s._w * 100) / 100 }));

  // 5) Sources & limitations
  const sourcesUsed = [...new Set(signals.map(s => s.source))];
  const limitations: string[] = [];
  const gate = applyIdentityGate(identityConfidence);
  if (gate.limitation) limitations.push(gate.limitation);

  if (result.coverageLevel === "insufficiente") {
    limitations.push("Dati insufficienti — meno di 2 famiglie di segnali disponibili");
  }
  if (result.coverageLevel === "scarsa") {
    limitations.push("Solo 2 famiglie di segnali disponibili — indice parziale");
  }
  limitations.push("Indice sintetico proprietario ICTV — non è un indicatore ufficiale di mercato");
  limitations.push("Non costituisce raccomandazione di investimento né consulenza finanziaria");
  limitations.push("Punteggio deterministico basato esclusivamente su dati pubblici verificabili");

  // 6) Static narrative fallback
  let narrativeObservation: string;
  if (result.convergenceLevel === "insufficiente") {
    narrativeObservation = "Dati insufficienti per una convergenza territoriale articolata";
  } else if (result.band === "molto_forte") {
    narrativeObservation = "Convergenza territoriale forte con segnali pubblici concordanti da più famiglie di dati";
  } else if (result.band === "forte") {
    narrativeObservation = "Territorio con segnali convergenti — contesto meritevole di approfondimento";
  } else if (result.band === "interessante") {
    narrativeObservation = "Alcuni segnali convergenti, con fattori da monitorare — quadro parziale";
  } else {
    narrativeObservation = "Segnali deboli o divergenti — convergenza territoriale limitata";
  }

  // Optional GPT rephrase (post-scoring, cannot alter numbers)
  if (signals.length >= 3) {
    try {
      const norm = await normalizeWithGPT({
        module: "opportunity", // reuse allowed output keys
        comune,
        collectedData: {
          score: result.score,
          band: result.band,
          convergenceLevel: result.convergenceLevel,
          coverageLevel: result.coverageLevel,
          positiveFamilies: result.positiveFamilies,
          negativeFamilies: result.negativeFamilies,
          evidenceTrace,
        },
        requestedOutputs: ["observation"],
      });
      if (norm.normalized && norm.observation) {
        narrativeObservation = norm.observation;
      }
    } catch { /* static fallback */ }
  }

  return ok(req, {
    comune,
    score: result.score,
    band: result.band,
    convergenceLevel: result.convergenceLevel,
    coverageLevel: result.coverageLevel,
    identityConfidence,
    positiveFamilies: result.positiveFamilies,
    negativeFamilies: result.negativeFamilies,
    topPositiveSignals,
    topNegativeSignals,
    evidenceTrace,
    narrativeObservation,
    sourceLabel: sourcesUsed.length > 0 ? sourcesUsed.join(" + ") : "Nessuna fonte disponibile",
    sourceType: (result.convergenceLevel === "insufficiente" ? "unavailable" : "elaborated") as const,
    sourcePeriod: "Dati aggregati multi-fonte — marzo 2026",
    confidenceReason: result.convergenceLevel === "insufficiente"
      ? "Dati insufficienti per calcolare una convergenza affidabile"
      : `ICTV calcolato su ${sourcesUsed.length} fonti, ${signals.length} segnali, ${result.positiveFamilies.length + result.negativeFamilies.length} famiglie attive`,
    limitations,
  }, [], debugId);
}
