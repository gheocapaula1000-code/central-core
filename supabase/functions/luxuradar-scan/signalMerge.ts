// luxu-signal-merge — incrocia segnali multipli sullo stesso asset.
// Quando due o più fonti indipendenti segnalano lo stesso asset,
// genera un Segnale Convergente e aumenta lo score e la priority.
//
// Fingerprint: hash di (normalized_address + zone + category)
// Deduplication: se due asset hanno fingerprint identico → merge.
// Privacy: nessun dato personale, nessun nome di proprietario.

export type MergeSource = {
  sourceCategory: string;
  sourceLabel: string;
  sourceUrl: string | null;
  score: number;
  priceEur: number | null;
  priceConfidence: string;
};

export type MergedAsset<T> = T & {
  convergentSignal: boolean;
  mergedSources: MergeSource[];
  mergeCount: number;
  mergedScore: number;
};

// Normalizza una stringa per il fingerprint
function norm(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Genera fingerprint per un asset — usato per deduplication e merge
export function assetFingerprint(asset: {
  title: string;
  category: string;
  city?: string | null;
  region?: string | null;
}): string {
  const titleWords = norm(asset.title).split(" ").slice(0, 6).join(" ");
  const city = norm(asset.city);
  const region = norm(asset.region);
  const category = norm(asset.category);
  return [titleWords, city, region, category].filter(Boolean).join("|");
}

// Calcola score merged — media pesata con bonus convergenza
function mergedScore(sources: MergeSource[]): number {
  if (sources.length === 0) return 0;
  if (sources.length === 1) return sources[0].score;

  // Media pesata per source quality
  const SOURCE_WEIGHTS: Record<string, number> = {
    pvp_judicial: 1.5,
    public_disposal: 1.4,
    special_situation: 1.3,
    public_notice: 1.2,
    prime_asset_signal: 1.0,
    luxury_market_signal: 0.9,
    hospitality_signal: 0.9,
  };

  let weightedSum = 0;
  let totalWeight = 0;

  for (const s of sources) {
    const w = SOURCE_WEIGHTS[s.sourceCategory] ?? 1.0;
    weightedSum += s.score * w;
    totalWeight += w;
  }

  const base = totalWeight > 0 ? weightedSum / totalWeight : sources[0].score;

  // Bonus convergenza: +8 per 2 fonti, +14 per 3+
  const convergenceBonus = sources.length >= 3 ? 14 : 8;

  // Bonus se almeno una fonte è istituzionale
  const hasInstitutional = sources.some(s =>
    ["pvp_judicial", "public_disposal", "special_situation"].includes(s.sourceCategory)
  );

  const institutionalBonus = hasInstitutional ? 6 : 0;

  return Math.min(100, Math.round(base + convergenceBonus + institutionalBonus));
}

// Seleziona il prezzo più affidabile tra le fonti
function bestPrice(sources: MergeSource[]): {
  priceEur: number | null;
  priceConfidence: string;
} {
  const CONFIDENCE_RANK: Record<string, number> = {
    exact: 4, range: 3, threshold_only: 2, unknown: 1,
  };

  const sorted = [...sources].sort(
    (a, b) =>
      (CONFIDENCE_RANK[b.priceConfidence] ?? 0) -
      (CONFIDENCE_RANK[a.priceConfidence] ?? 0)
  );

  return {
    priceEur: sorted[0]?.priceEur ?? null,
    priceConfidence: sorted[0]?.priceConfidence ?? "unknown",
  };
}

// Funzione principale — riceve array di asset, restituisce array merged
export function mergeSignals<T extends {
  title: string;
  category: string;
  city?: string | null;
  region?: string | null;
  sourceCategory: string;
  sourceLabel: string;
  sourceUrl: string | null;
  score: number;
  priceEur: number | null;
  priceConfidence: string;
  priority: string;
}>(assets: T[]): MergedAsset<T>[] {

  // Raggruppa per fingerprint
  const groups = new Map<string, T[]>();
  for (const asset of assets) {
    const fp = assetFingerprint(asset);
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp)!.push(asset);
  }

  const result: MergedAsset<T>[] = [];

  for (const [, group] of groups) {
    // Prendi il migliore come base (score più alto)
    const base = [...group].sort((a, b) => b.score - a.score)[0];

    const sources: MergeSource[] = group.map(a => ({
      sourceCategory: a.sourceCategory,
      sourceLabel: a.sourceLabel,
      sourceUrl: a.sourceUrl,
      score: a.score,
      priceEur: a.priceEur,
      priceConfidence: a.priceConfidence,
    }));

    const isConvergent = group.length >= 2;
    const newScore = mergedScore(sources);
    const { priceEur, priceConfidence } = bestPrice(sources);

    // Priority upgrade se convergente
    let priority = base.priority;
    if (isConvergent) {
      if (newScore >= 75) priority = "critical";
      else if (newScore >= 58) priority = "high";
      else if (newScore >= 42) priority = "medium";
    }

    result.push({
      ...base,
      score: newScore,
      priority,
      priceEur,
      priceConfidence,
      convergentSignal: isConvergent,
      mergedSources: sources,
      mergeCount: group.length,
      mergedScore: newScore,
    });
  }

  // Ordina per score desc
  return result.sort((a, b) => b.mergedScore - a.mergedScore);
}
