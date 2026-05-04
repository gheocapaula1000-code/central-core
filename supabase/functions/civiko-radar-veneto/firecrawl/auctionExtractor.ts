// ═══════════════════════════════════════════════════════════════
// auctionExtractor — da source_documents class=auction|pvp|ivg
// produce candidate per auction_signals.
// Validazione: comune+provincia Veneto, source_url, no demo.
// ═══════════════════════════════════════════════════════════════
import type { ExtractedEntities } from "./entityExtractor.ts";
import { isVenetoProvince, isDemoText } from "./complianceGuards.ts";

export interface AuctionCandidate {
  source_name: string;
  source_url: string;
  comune: string;
  provincia: string;
  lat: number | null;
  lng: number | null;
  tipologia: string | null;
  categoria: string | null;
  prezzo_base: number | null;
  offerta_minima: number | null;
  data_vendita: string | null;
  tribunale: string | null;
  stato: string | null;
  descrizione: string | null;
  quality: "reale" | "parziale";
  confidence_score: number;
  data_basis: string[];
}

export function buildAuctionCandidate(args: {
  sourceName: string;
  sourceUrl: string;
  title: string | null;
  entities: ExtractedEntities;
  confidence: number;
}): AuctionCandidate | null {
  const { entities } = args;
  if (!entities.comune || !entities.provincia) return null;
  if (!isVenetoProvince(entities.provincia)) return null;
  if (!args.sourceUrl) return null;
  if (isDemoText(args.sourceName, args.sourceUrl, args.title)) return null;

  const prezzo = entities.amounts_eur && entities.amounts_eur.length
    ? Math.min(...entities.amounts_eur)
    : null;
  const dateISO = entities.dates && entities.dates.length
    ? [...entities.dates].sort().reverse()[0]
    : null;

  const tip = entities.property_types && entities.property_types[0] ? entities.property_types[0] : null;
  const quality: "reale" | "parziale" = (prezzo && dateISO && entities.tribunale) ? "reale" : "parziale";

  return {
    source_name: args.sourceName,
    source_url: args.sourceUrl,
    comune: entities.comune,
    provincia: entities.provincia,
    lat: null,
    lng: null,
    tipologia: tip,
    categoria: tip,
    prezzo_base: prezzo,
    offerta_minima: null,
    data_vendita: dateISO,
    tribunale: entities.tribunale,
    stato: null,
    descrizione: args.title ? args.title.slice(0, 200) : null,
    quality,
    confidence_score: args.confidence,
    data_basis: ["firecrawl", args.sourceName],
  };
}
