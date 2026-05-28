// _shared/civikoScoring.ts
// Helper di scoring con attribution obbligatoria.
// Ogni contributo include source_code, value, confidence, last_updated, explanation.

export interface ScoreContribution {
  source_code: string;
  weight: number;
  value: number; // contributo normalizzato 0..1
  confidence: "low" | "medium" | "high";
  last_updated: string | null;
  explanation: string;
}

export interface ScoreBreakdown {
  score: number; // 0..100
  contributions: ScoreContribution[];
  missing_sources: string[];
}

export const SOURCE_WEIGHTS = {
  F4: 0.2, // elderly population — structural turnover signal
  F3: 0.2, // APR4 mobility (iscritti/cancellati)
  F12: 0.15, // market benchmark cross-check
  F18: 0.15, // SUE permits — renovation/change
  F22: 0.05, // separations — weak macro
} as const;

function freshnessConfidence(daysOld: number | null): "low" | "medium" | "high" {
  if (daysOld === null) return "low";
  if (daysOld < 180) return "high";
  if (daysOld < 730) return "medium";
  return "low";
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

export interface ScoringInputs {
  elderly?: { over_75_rate: number | null; year: number; imported_at: string };
  mobility?: { saldo_migratorio: number | null; iscritti: number | null; cancellati: number | null; year: number; imported_at: string };
  marketBenchmark?: { avg_price_eur_mq: number | null; omi_avg_price_eur_mq: number | null; imported_at: string };
  suePermits?: { recent_count: number; window_days: number; imported_at: string };
  separations?: { separation_rate: number | null; year: number; imported_at: string };
}

export function buildScoreContributions(inputs: ScoringInputs): ScoreBreakdown {
  const contributions: ScoreContribution[] = [];
  const missing: string[] = [];

  // F4 elderly
  if (inputs.elderly && inputs.elderly.over_75_rate != null) {
    // Tasso over75 elevato → turnover strutturale alto
    const v = Math.max(0, Math.min(1, inputs.elderly.over_75_rate / 0.20));
    contributions.push({
      source_code: "F4",
      weight: SOURCE_WEIGHTS.F4,
      value: v,
      confidence: freshnessConfidence(daysSince(inputs.elderly.imported_at)),
      last_updated: inputs.elderly.imported_at,
      explanation: `Quota over-75 ${(inputs.elderly.over_75_rate * 100).toFixed(1)}% (anno ${inputs.elderly.year}) → indicatore strutturale di turnover.`,
    });
  } else missing.push("F4");

  // F3/F20 mobility
  if (inputs.mobility) {
    const saldo = inputs.mobility.saldo_migratorio ?? ((inputs.mobility.iscritti ?? 0) - (inputs.mobility.cancellati ?? 0));
    // Saldo negativo o turnover alto → segnale di domanda mutevole
    const turnover = (inputs.mobility.iscritti ?? 0) + (inputs.mobility.cancellati ?? 0);
    const v = Math.max(0, Math.min(1, turnover / 5000));
    contributions.push({
      source_code: "F3",
      weight: SOURCE_WEIGHTS.F3,
      value: v,
      confidence: freshnessConfidence(daysSince(inputs.mobility.imported_at)),
      last_updated: inputs.mobility.imported_at,
      explanation: `Turnover residenziale ${turnover} movimenti (saldo ${saldo}, anno ${inputs.mobility.year}).`,
    });
  } else missing.push("F3");

  // F12 market benchmark
  if (inputs.marketBenchmark && inputs.marketBenchmark.avg_price_eur_mq != null && inputs.marketBenchmark.omi_avg_price_eur_mq != null && inputs.marketBenchmark.omi_avg_price_eur_mq > 0) {
    const ratio = inputs.marketBenchmark.avg_price_eur_mq / inputs.marketBenchmark.omi_avg_price_eur_mq;
    // confidence high se entro ±15%, decresce oltre
    const delta = Math.abs(ratio - 1);
    const v = Math.max(0, 1 - delta);
    contributions.push({
      source_code: "F12",
      weight: SOURCE_WEIGHTS.F12,
      value: v,
      confidence: delta < 0.15 ? "high" : delta < 0.30 ? "medium" : "low",
      last_updated: inputs.marketBenchmark.imported_at,
      explanation: `Benchmark privato vs OMI: ratio ${ratio.toFixed(2)}.`,
    });
  } else missing.push("F12");

  // F18 SUE
  if (inputs.suePermits) {
    const v = Math.max(0, Math.min(1, inputs.suePermits.recent_count / 25));
    contributions.push({
      source_code: "F18",
      weight: SOURCE_WEIGHTS.F18,
      value: v,
      confidence: freshnessConfidence(daysSince(inputs.suePermits.imported_at)),
      last_updated: inputs.suePermits.imported_at,
      explanation: `${inputs.suePermits.recent_count} pratiche edilizie pubbliche negli ultimi ${inputs.suePermits.window_days} giorni.`,
    });
  } else missing.push("F18");

  // F22 separations (weak)
  if (inputs.separations && inputs.separations.separation_rate != null) {
    const v = Math.max(0, Math.min(1, inputs.separations.separation_rate / 0.01));
    contributions.push({
      source_code: "F22",
      weight: SOURCE_WEIGHTS.F22,
      value: v,
      confidence: "low",
      last_updated: inputs.separations.imported_at,
      explanation: `Tasso separazioni ${(inputs.separations.separation_rate * 1000).toFixed(2)}‰ (anno ${inputs.separations.year}) — segnale macro debole.`,
    });
  } else missing.push("F22");

  // Normalizza pesi sui contributi presenti
  const totalWeight = contributions.reduce((s, c) => s + c.weight, 0);
  const score = totalWeight > 0
    ? Math.round((contributions.reduce((s, c) => s + c.value * c.weight, 0) / totalWeight) * 100)
    : 0;

  return { score, contributions, missing_sources: missing };
}
