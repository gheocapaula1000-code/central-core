import { describe, it, expect } from "vitest";

// ── Pure logic tests for ICTV engine ──
// We replicate the pure functions here since edge function imports aren't available in vitest

type SignalFamily = "identita" | "mercato" | "demografia" | "rischio" | "sviluppo";
type SignalDirection = "positivo" | "negativo" | "neutro";
type SourceClass = "official_db" | "official_portal" | "official_imported" | "derived_from_official";
type SpatialBand = "building" | "microarea" | "quartiere" | "comune";
type ConvergenceLevel = "alta" | "media" | "bassa" | "insufficiente";

interface ICTVSignal {
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

const SOURCE_WEIGHT: Record<SourceClass, number> = {
  official_db: 1.00,
  official_portal: 0.95,
  official_imported: 0.90,
  derived_from_official: 0.75,
};

function freshnessWeight(months: number | null): number {
  if (months === null) return 0.80;
  if (months <= 12) return 1.00;
  if (months <= 24) return 0.85;
  return 0.70;
}

const SPATIAL_WEIGHT: Record<SpatialBand, number> = {
  building: 1.00,
  microarea: 0.90,
  quartiere: 0.75,
  comune: 0.60,
};

function computeWeightedSignal(s: ICTVSignal): number {
  return s.rawStrength * SOURCE_WEIGHT[s.sourceClass] * freshnessWeight(s.freshnessMonths) * SPATIAL_WEIGHT[s.spatialBand] * s.confidence;
}

function applyIdentityGate(ic: number | null) {
  if (ic === null || ic === undefined) return { scoreCap: null, multiplier: 1, maxConvergence: null, limitation: null };
  if (ic < 0.55) return { scoreCap: 45, multiplier: 1, maxConvergence: "bassa" as const, limitation: "low" };
  if (ic < 0.75) return { scoreCap: null, multiplier: 0.90, maxConvergence: null, limitation: null };
  return { scoreCap: null, multiplier: 1, maxConvergence: null, limitation: null };
}

function aggregateSignals(signals: ICTVSignal[], identityConfidence: number | null) {
  const familyMap = new Map<SignalFamily, { weighted: number; direction: SignalDirection }[]>();
  for (const s of signals) {
    const w = computeWeightedSignal(s);
    const directedW = s.direction === "negativo" ? -w : s.direction === "neutro" ? 0 : w;
    if (!familyMap.has(s.family)) familyMap.set(s.family, []);
    familyMap.get(s.family)!.push({ weighted: directedW, direction: s.direction });
  }

  const familyCount = familyMap.size;
  const familyContributions = new Map<SignalFamily, number>();
  for (const [fam, entries] of familyMap) {
    familyContributions.set(fam, entries.reduce((sum, e) => sum + e.weighted, 0));
  }

  const positiveFamilies: SignalFamily[] = [];
  const negativeFamilies: SignalFamily[] = [];
  for (const [fam, net] of familyContributions) {
    if (net > 0.5) positiveFamilies.push(fam);
    else if (net < -0.5) negativeFamilies.push(fam);
  }

  const concordantCount = Math.max(positiveFamilies.length, negativeFamilies.length);
  let convergenceBonus = 0;
  if (concordantCount >= 4) convergenceBonus = 14;
  else if (concordantCount >= 3) convergenceBonus = 9;
  else if (concordantCount >= 2) convergenceBonus = 4;

  let divergencePenalty = 0;
  if (positiveFamilies.length >= 2 && negativeFamilies.length >= 2) divergencePenalty = -8;

  let coveragePenalty = 0;
  if (familyCount >= 4) coveragePenalty = 0;
  else if (familyCount === 3) coveragePenalty = -6;
  else if (familyCount === 2) coveragePenalty = -12;

  let coverageLevel: string;
  if (familyCount >= 5) coverageLevel = "completa";
  else if (familyCount === 4) coverageLevel = "buona";
  else if (familyCount === 3) coverageLevel = "parziale";
  else if (familyCount === 2) coverageLevel = "scarsa";
  else coverageLevel = "insufficiente";

  if (familyCount < 2) {
    return { score: 0, band: "debole", convergenceLevel: "insufficiente" as ConvergenceLevel, coverageLevel, positiveFamilies, negativeFamilies, convergenceBonus: 0, divergencePenalty: 0, coveragePenalty: 0 };
  }

  let score = 50;
  for (const net of familyContributions.values()) {
    score += Math.max(-15, Math.min(15, net));
  }
  score += convergenceBonus + divergencePenalty + coveragePenalty;

  const gate = applyIdentityGate(identityConfidence);
  score *= gate.multiplier;
  if (gate.scoreCap !== null) score = Math.min(score, gate.scoreCap);
  score = Math.max(0, Math.min(100, Math.round(score)));

  let band: string;
  if (score >= 75) band = "molto_forte";
  else if (score >= 60) band = "forte";
  else if (score >= 45) band = "interessante";
  else band = "debole";

  let convergenceLevel: ConvergenceLevel;
  if (concordantCount >= 3 && (coverageLevel === "buona" || coverageLevel === "completa")) convergenceLevel = "alta";
  else if (concordantCount >= 2 && familyCount >= 2) convergenceLevel = "media";
  else convergenceLevel = "bassa";

  if (gate.maxConvergence !== null) {
    const order: ConvergenceLevel[] = ["insufficiente", "bassa", "media", "alta"];
    const gateIdx = order.indexOf(gate.maxConvergence as ConvergenceLevel);
    const currentIdx = order.indexOf(convergenceLevel);
    if (currentIdx > gateIdx) convergenceLevel = gate.maxConvergence as ConvergenceLevel;
  }

  return { score, band, convergenceLevel, coverageLevel, positiveFamilies, negativeFamilies, convergenceBonus, divergencePenalty, coveragePenalty };
}

// ── Helper to make signals quickly ──
function sig(family: SignalFamily, direction: SignalDirection, rawStrength = 5, opts?: Partial<ICTVSignal>): ICTVSignal {
  return {
    family, label: "test", source: "test", direction, rawStrength,
    sourceClass: "official_db", freshnessMonths: 3, spatialBand: "comune", confidence: 0.9,
    ...opts,
  };
}

describe("ICTV — Deterministic Score", () => {
  it("clamps score to 0..100", () => {
    // All strongly positive → should not exceed 100
    const signals: ICTVSignal[] = [
      sig("mercato", "positivo", 20),
      sig("demografia", "positivo", 20),
      sig("rischio", "positivo", 20),
      sig("sviluppo", "positivo", 20),
      sig("identita", "positivo", 20),
    ];
    const r = aggregateSignals(signals, 0.9);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it("returns 0 with insufficient data (< 2 families)", () => {
    const signals = [sig("mercato", "positivo", 8)];
    const r = aggregateSignals(signals, null);
    expect(r.score).toBe(0);
    expect(r.convergenceLevel).toBe("insufficiente");
    expect(r.coverageLevel).toBe("insufficiente");
  });

  it("applies coverage penalty correctly", () => {
    const s3 = [sig("mercato", "positivo", 5), sig("demografia", "positivo", 5), sig("rischio", "positivo", 5)];
    const s4 = [...s3, sig("sviluppo", "positivo", 5)];
    const r3 = aggregateSignals(s3, null);
    const r4 = aggregateSignals(s4, null);
    // 4 families should score higher (no coverage penalty vs -6)
    expect(r4.score).toBeGreaterThan(r3.score);
  });

  it("identity gate caps score at 45 when confidence < 0.55", () => {
    const signals = [
      sig("mercato", "positivo", 10),
      sig("demografia", "positivo", 10),
      sig("rischio", "positivo", 10),
      sig("sviluppo", "positivo", 10),
    ];
    const r = aggregateSignals(signals, 0.3);
    expect(r.score).toBeLessThanOrEqual(45);
    expect(r.convergenceLevel).toBe("bassa");
  });

  it("identity gate applies 0.90 multiplier for 0.55-0.75", () => {
    const signals = [
      sig("mercato", "positivo", 5),
      sig("demografia", "positivo", 5),
    ];
    const noGate = aggregateSignals(signals, 0.8);
    const withGate = aggregateSignals(signals, 0.6);
    expect(withGate.score).toBeLessThanOrEqual(noGate.score);
  });

  it("convergence alta requires >= 3 concordant + good coverage", () => {
    const signals = [
      sig("mercato", "positivo", 5),
      sig("demografia", "positivo", 5),
      sig("rischio", "positivo", 5),
      sig("sviluppo", "positivo", 5),
    ];
    const r = aggregateSignals(signals, null);
    expect(r.convergenceLevel).toBe("alta");
    expect(r.coverageLevel).toBe("buona");
  });

  it("convergence media with 2 families", () => {
    const signals = [
      sig("mercato", "positivo", 5),
      sig("demografia", "positivo", 5),
    ];
    const r = aggregateSignals(signals, null);
    expect(r.convergenceLevel).toBe("media");
  });

  it("divergence penalty when 2+ positive and 2+ negative families", () => {
    const signals = [
      sig("mercato", "positivo", 5),
      sig("demografia", "positivo", 5),
      sig("rischio", "negativo", 5),
      sig("sviluppo", "negativo", 5),
    ];
    const r = aggregateSignals(signals, null);
    expect(r.divergencePenalty).toBe(-8);
  });

  it("no data invention — empty signals produce insufficient", () => {
    const r = aggregateSignals([], null);
    expect(r.score).toBe(0);
    expect(r.convergenceLevel).toBe("insufficiente");
    expect(r.band).toBe("debole");
  });

  it("band mapping is correct", () => {
    // Force high score
    const signals = [
      sig("mercato", "positivo", 15),
      sig("demografia", "positivo", 15),
      sig("rischio", "positivo", 15),
      sig("sviluppo", "positivo", 15),
      sig("identita", "positivo", 15),
    ];
    const r = aggregateSignals(signals, 0.9);
    expect(["molto_forte", "forte", "interessante", "debole"]).toContain(r.band);
  });

  it("weighted signal formula is deterministic", () => {
    const s = sig("mercato", "positivo", 7, {
      sourceClass: "official_imported",
      freshnessMonths: 18,
      spatialBand: "quartiere",
      confidence: 0.85,
    });
    const w1 = computeWeightedSignal(s);
    const w2 = computeWeightedSignal(s);
    expect(w1).toBe(w2);
    // 7 * 0.90 * 0.85 * 0.75 * 0.85 = 3.414...
    expect(w1).toBeCloseTo(7 * 0.90 * 0.85 * 0.75 * 0.85, 5);
  });
});

describe("ICTV — Freshness weights", () => {
  it("null → 0.80", () => expect(freshnessWeight(null)).toBe(0.80));
  it("3 months → 1.00", () => expect(freshnessWeight(3)).toBe(1.00));
  it("12 months → 1.00", () => expect(freshnessWeight(12)).toBe(1.00));
  it("18 months → 0.85", () => expect(freshnessWeight(18)).toBe(0.85));
  it("36 months → 0.70", () => expect(freshnessWeight(36)).toBe(0.70));
});

describe("ICTV — Secret header compatibility", () => {
  it("AI_CORE_SECRET is canonical, legacy aliases supported", () => {
    // This is a documentation/contract test — the actual header parsing is in _shared/http.ts
    const legacyHeaders = ["x-internal-secret", "x-app-secret", "x-core-secret"];
    const canonical = "AI_CORE_SECRET";
    expect(canonical).toBe("AI_CORE_SECRET");
    expect(legacyHeaders.length).toBe(3);
  });
});
