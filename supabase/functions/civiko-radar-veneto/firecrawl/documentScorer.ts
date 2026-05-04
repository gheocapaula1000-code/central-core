// ═══════════════════════════════════════════════════════════════
// documentScorer — assegna relevance/confidence/freshness/source_reliability
// e decide importability + reason.
// ═══════════════════════════════════════════════════════════════
import type { PageClass } from "./pageClassifier.ts";
import type { ExtractedEntities } from "./entityExtractor.ts";
import type { FirecrawlSource } from "./sourceRegistry.ts";

export interface DocScore {
  relevance_score: number;
  confidence_score: number;
  freshness_score: number;
  source_reliability: number;
  importability: boolean;
  reason: string;
}

export function scoreDocument(args: {
  source: FirecrawlSource;
  pageClass: PageClass;
  entities: ExtractedEntities;
  publishedAt?: string | null;
  hasMarkdown: boolean;
}): DocScore {
  const reasons: string[] = [];

  // Source reliability (dal registry)
  const sourceReliability = Math.max(0, Math.min(100, args.source.reliability_score ?? 50));

  // Relevance per classification
  const RELEVANT: Record<PageClass, number> = {
    auction:90, pvp:95, ivg:90, urban_planning:80, public_work:80,
    open_data:60, municipal_notice:75, territorial_service:55,
    infrastructure:70, transport:55, school:45, tourism:35,
    business_area:55, real_estate_market:75, irrelevant:0,
  };
  let relevance = RELEVANT[args.pageClass];
  if (args.entities.comune) relevance += 5;
  if (args.entities.provincia) relevance += 5;
  relevance = Math.max(0, Math.min(100, relevance));

  // Confidence
  let confidence = 30;
  if (args.entities.comune && args.entities.provincia) confidence += 25; else reasons.push("manca comune/provincia");
  if ((args.entities.amounts_eur?.length ?? 0) > 0) confidence += 10;
  if ((args.entities.dates?.length ?? 0) > 0) confidence += 10;
  if (args.hasMarkdown) confidence += 15;
  if (args.pageClass === "auction" && !args.entities.tribunale) { confidence -= 10; reasons.push("asta senza tribunale"); }
  confidence = Math.max(0, Math.min(100, confidence));

  // Freshness (90 se entro 90gg, 60 entro 1 anno, 30 entro 3 anni)
  let freshness = 50;
  if (args.publishedAt) {
    const t = Date.parse(args.publishedAt);
    if (Number.isFinite(t)) {
      const days = (Date.now() - t) / 86_400_000;
      if (days <= 30) freshness = 95;
      else if (days <= 90) freshness = 85;
      else if (days <= 365) freshness = 65;
      else if (days <= 1095) freshness = 40;
      else freshness = 20;
    }
  }

  const importability = relevance >= 60 && confidence >= 60 && args.pageClass !== "irrelevant";
  if (!importability) reasons.push(`relevance=${relevance} confidence=${confidence} class=${args.pageClass}`);

  return {
    relevance_score: relevance,
    confidence_score: confidence,
    freshness_score: freshness,
    source_reliability: sourceReliability,
    importability,
    reason: reasons.join("; ") || "ok",
  };
}
