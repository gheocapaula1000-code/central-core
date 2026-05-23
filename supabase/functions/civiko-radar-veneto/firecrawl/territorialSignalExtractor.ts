// ═══════════════════════════════════════════════════════════════
// territorialSignalExtractor — da source_documents class=municipal_notice/
// urban_planning/public_work/infrastructure → territorial_signals.
// ═══════════════════════════════════════════════════════════════
import type { ExtractedEntities } from "./entityExtractor.ts";
import type { PageClass } from "./pageClassifier.ts";
import { isVenetoProvince, isDemoText } from "./complianceGuards.ts";

const CLASS_TO_TYPE: Partial<Record<PageClass, string>> = {
  urban_planning: "variante_urbanistica",
  public_work: "opera_pubblica",
  municipal_notice: "bando",
  infrastructure: "infrastruttura",
  transport: "mobilita",
  school: "scuola",
  tourism: "turismo",
  business_area: "area_industriale",
  commercial_retail: "centro_commerciale",
  open_data: "investimento_pubblico",
  real_estate_market: "mercato",
  territorial_service: "sanita_servizi",
};

export interface TerritorialCandidate {
  comune: string;
  provincia: string;
  signal_type: string;
  title: string;
  description: string | null;
  source_url: string;
  source_name: string;
  published_at: string | null;
  amount_eur: number | null;
  location_text: string | null;
  confidence_score: number;
  relevance_score: number;
  quality: "reale" | "parziale";
  data_basis: string[];
}

export function buildTerritorialCandidate(args: {
  sourceName: string;
  sourceUrl: string;
  title: string | null;
  pageClass: PageClass;
  entities: ExtractedEntities;
  publishedAt: string | null;
  relevance: number;
  confidence: number;
}): TerritorialCandidate | null {
  const t = CLASS_TO_TYPE[args.pageClass];
  if (!t) return null;
  if (!args.entities.comune || !args.entities.provincia) return null;
  if (!isVenetoProvince(args.entities.provincia)) return null;
  if (!args.sourceUrl) return null;
  if (isDemoText(args.sourceName, args.sourceUrl, args.title)) return null;

  const amount = args.entities.amounts_eur && args.entities.amounts_eur.length
    ? Math.max(...args.entities.amounts_eur)
    : null;

  return {
    comune: args.entities.comune,
    provincia: args.entities.provincia,
    signal_type: t,
    title: (args.title ?? "Segnale territoriale").slice(0, 200),
    description: null,
    source_url: args.sourceUrl,
    source_name: args.sourceName,
    published_at: args.publishedAt,
    amount_eur: amount,
    location_text: args.entities.ente,
    confidence_score: args.confidence,
    relevance_score: args.relevance,
    quality: (args.publishedAt && amount) ? "reale" : "parziale",
    data_basis: ["firecrawl", args.sourceName],
  };
}
