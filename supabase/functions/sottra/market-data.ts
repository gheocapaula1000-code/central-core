// ═══════════════════════════════════════════════════════════════
// Sottra — Market Data Adapter Layer (Phase 3)
// Comparables engine, market signals, and provider chain.
// Zero invented data. Confidence-gated. Audit-ready.
// ═══════════════════════════════════════════════════════════════

import { withAbort } from "./shared.ts";

// ── Source Class Model ────────────────────────────────────────

export type MarketSourceClass =
  | "official"              // Fonti ufficiali (OMI, catasto)
  | "commercial_verified"   // Fonti commerciali licenziate con coverage solida
  | "commercial_partial"    // Dati commerciali parziali o incompleti
  | "user_provided"         // Dati forniti dall'utente
  | "elaborated"            // Indice/calcolo costruito su fonti vere
  | "unavailable";          // Dati non abbastanza solidi

// ── Comparable Listing ────────────────────────────────────────

export interface ComparableListing {
  provider: string;
  listingId: string | null;
  addressFragment: string | null;
  street: string | null;
  houseNumber: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  propertyType: string | null;
  askingPrice: number | null;
  pricePerSqm: number | null;
  areaSqm: number | null;
  rooms: number | null;
  floor: number | null;
  condition: string | null;
  energyClass: string | null;
  listingAgeDays: number | null;
  lastSeenAt: string | null;
  status: "active" | "stale" | "removed" | "unknown";
  confidence: number;
  limitations: string[];
}

// ── Market Evidence Signal ────────────────────────────────────

export interface MarketEvidenceSignal {
  signalId: string;
  label: string;
  value: number | string | null;
  unit: string | null;
  sourceClass: MarketSourceClass;
  confidence: number;
  reason: string;
  limitations: string[];
}

// ── Provider Result ───────────────────────────────────────────

export interface MarketDataProviderResult {
  provider: string;
  available: boolean;
  sourceClass: MarketSourceClass;
  areaLevel: "address" | "microzona" | "city" | "province";
  comparables: ComparableListing[];
  signals: MarketEvidenceSignal[];
  confidence: number;
  limitations: string[];
  error?: string;
}

// ── Provider Adapter Interface ────────────────────────────────

export interface MarketDataProviderAdapter {
  readonly name: string;
  readonly priority: number;
  isAvailable(): boolean;
  lookup(input: MarketLookupInput): Promise<MarketDataProviderResult | null>;
}

export interface MarketLookupInput {
  address: string;
  comune: string;
  provincia: string | null;
  street: string | null;
  houseNumber: string | null;
  lat: number;
  lng: number;
  propertyType?: string;
  areaSqm?: number;
}

// ── Market Context Result (merged output) ─────────────────────

export interface ComparablesSummary {
  comparablesCount: number;
  medianPricePerSqm: number | null;
  lowerQuartilePricePerSqm: number | null;
  upperQuartilePricePerSqm: number | null;
  freshnessScore: number;        // 0-1, higher = fresher listings
  marketDepthScore: number;      // 0-1, higher = more data available
  comparableCoverageLevel: "buona" | "parziale" | "scarsa" | "insufficiente";
  marketDataConfidence: number;
  marketDataReason: string;
}

export interface MarketSignals {
  priceBandLocale: MarketEvidenceSignal | null;
  marketFreshness: MarketEvidenceSignal | null;
  marketDepth: MarketEvidenceSignal | null;
  sellerPressure: MarketEvidenceSignal | null;
  premiumMicroAreaSignal: MarketEvidenceSignal | null;
  rentalAppealSignal: MarketEvidenceSignal | null;
  energyPremiumSignal: MarketEvidenceSignal | null;
  listingTurnoverSignal: MarketEvidenceSignal | null;
}

export interface MarketContextResult {
  marketContext: "available" | "partial" | "unavailable";
  comparablesSummary: ComparablesSummary | null;
  marketSignals: MarketSignals;
  marketConfidence: number;
  marketConfidenceReason: string;
  marketCoverageLevel: "buona" | "parziale" | "scarsa" | "insufficiente";
  sourceType: MarketSourceClass;
  sourceLabel: string;
  sourcePeriod: string | null;
  limitations: string[];
  providerBreakdown: Array<{
    provider: string;
    available: boolean;
    sourceClass: MarketSourceClass;
    comparablesCount: number;
    confidence: number;
  }>;
}

// ── Constants / Policy ────────────────────────────────────────

export const MARKET_DATA_POLICY = {
  /** Minimum comparables to consider market data publishable */
  MIN_COMPARABLES_PUBLISHABLE: 3,
  /** Minimum comparables for "buona" coverage */
  MIN_COMPARABLES_GOOD: 8,
  /** Minimum comparables for "parziale" coverage */
  MIN_COMPARABLES_PARTIAL: 5,
  /** Maximum distance (km) for comparables to be relevant */
  MAX_COMPARABLE_DISTANCE_KM: 2.0,
  /** Maximum sqm difference ratio for comparable filtering */
  MAX_SQM_RATIO: 0.50, // 50% difference
  /** Maximum listing age in days for freshness */
  FRESHNESS_MAX_DAYS: 180,
  /** Minimum finalIdentityConfidence for market data */
  MIN_IDENTITY_CONFIDENCE: 0.50,
  /** Minimum finalIdentityConfidence for microzona comparables */
  MIN_IDENTITY_CONFIDENCE_MICROZONA: 0.70,
  /** Stale listing threshold (days) */
  STALE_THRESHOLD_DAYS: 90,
} as const;

// ── Provider Chain ────────────────────────────────────────────

/**
 * Generic market data provider — env-driven, named abstractly.
 * Activate by setting MARKET_PROVIDER_1_API_KEY, MARKET_PROVIDER_1_BASE_URL, etc.
 */
class GenericMarketProvider implements MarketDataProviderAdapter {
  readonly name: string;
  readonly priority: number;
  private readonly envKeyPrefix: string;

  constructor(name: string, priority: number, envKeyPrefix: string) {
    this.name = name;
    this.priority = priority;
    this.envKeyPrefix = envKeyPrefix;
  }

  isAvailable(): boolean {
    return !!(Deno.env.get(`${this.envKeyPrefix}_API_KEY`));
  }

  async lookup(input: MarketLookupInput): Promise<MarketDataProviderResult | null> {
    const apiKey = Deno.env.get(`${this.envKeyPrefix}_API_KEY`);
    const baseUrl = Deno.env.get(`${this.envKeyPrefix}_BASE_URL`);
    if (!apiKey || !baseUrl) return null;

    const { signal, clear } = withAbort(15_000);
    try {
      const res = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          lat: input.lat,
          lng: input.lng,
          comune: input.comune,
          address: input.address,
          radiusKm: MARKET_DATA_POLICY.MAX_COMPARABLE_DISTANCE_KM,
          propertyType: input.propertyType ?? "residenziale",
        }),
        signal,
      });

      if (!res.ok) {
        return {
          provider: this.name,
          available: false,
          sourceClass: "unavailable",
          areaLevel: "city",
          comparables: [],
          signals: [],
          confidence: 0,
          limitations: [`Provider ${this.name} returned HTTP ${res.status}`],
          error: `HTTP ${res.status}`,
        };
      }

      const data = await res.json();
      const listings = Array.isArray(data?.listings) ? data.listings : [];

      const comparables: ComparableListing[] = listings.map((l: Record<string, unknown>) => ({
        provider: this.name,
        listingId: (l.id as string) ?? null,
        addressFragment: (l.address as string) ?? null,
        street: (l.street as string) ?? null,
        houseNumber: (l.houseNumber as string) ?? null,
        city: (l.city as string) ?? null,
        lat: typeof l.lat === "number" ? l.lat : null,
        lng: typeof l.lng === "number" ? l.lng : null,
        propertyType: (l.propertyType as string) ?? null,
        askingPrice: typeof l.price === "number" ? l.price : null,
        pricePerSqm: typeof l.pricePerSqm === "number" ? l.pricePerSqm : null,
        areaSqm: typeof l.areaSqm === "number" ? l.areaSqm : null,
        rooms: typeof l.rooms === "number" ? l.rooms : null,
        floor: typeof l.floor === "number" ? l.floor : null,
        condition: (l.condition as string) ?? null,
        energyClass: (l.energyClass as string) ?? null,
        listingAgeDays: typeof l.listingAgeDays === "number" ? l.listingAgeDays : null,
        lastSeenAt: (l.lastSeenAt as string) ?? null,
        status: (["active", "stale", "removed"] as const).includes(l.status as "active")
          ? (l.status as ComparableListing["status"]) : "unknown",
        confidence: typeof l.confidence === "number" ? l.confidence : 0.5,
        limitations: [],
      }));

      return {
        provider: this.name,
        available: true,
        sourceClass: comparables.length >= MARKET_DATA_POLICY.MIN_COMPARABLES_PUBLISHABLE
          ? "commercial_verified" : "commercial_partial",
        areaLevel: comparables.some(c => c.street) ? "microzona" : "city",
        comparables,
        signals: [],
        confidence: Math.min(1, comparables.length / 10),
        limitations: [],
      };
    } catch (e) {
      console.warn(`[market:${this.name}] Error: ${String(e).slice(0, 80)}`);
      return null;
    } finally {
      clear();
    }
  }
}

/** Get all configured market providers in priority order */
function getMarketProviderChain(): MarketDataProviderAdapter[] {
  const enabled = Deno.env.get("MARKET_DATA_ENABLED") !== "false";
  if (!enabled) return [];

  const envOrder = Deno.env.get("MARKET_PROVIDER_ORDER");

  const providers: MarketDataProviderAdapter[] = [
    new GenericMarketProvider("market_provider_1", 1, "MARKET_PROVIDER_1"),
    new GenericMarketProvider("market_provider_2", 2, "MARKET_PROVIDER_2"),
    new GenericMarketProvider("market_provider_3", 3, "MARKET_PROVIDER_3"),
  ];

  if (envOrder) {
    const order = envOrder.split(",").map(s => s.trim().toLowerCase());
    return providers
      .filter(p => order.includes(p.name) && p.isAvailable())
      .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }

  return providers.filter(p => p.isAvailable());
}

// ── Comparables Engine ────────────────────────────────────────

/** Filter comparables for coherence */
function filterComparables(
  comparables: ComparableListing[],
  referenceSqm?: number,
): ComparableListing[] {
  return comparables.filter(c => {
    // Must have a price
    if (c.pricePerSqm == null && c.askingPrice == null) return false;
    // Filter by sqm coherence if reference available
    if (referenceSqm && c.areaSqm) {
      const ratio = Math.abs(c.areaSqm - referenceSqm) / referenceSqm;
      if (ratio > MARKET_DATA_POLICY.MAX_SQM_RATIO) return false;
    }
    // Filter out very stale listings
    if (c.listingAgeDays != null && c.listingAgeDays > MARKET_DATA_POLICY.FRESHNESS_MAX_DAYS) return false;
    return true;
  });
}

/** Calculate median of sorted array */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Calculate quartile */
function quartile(values: number[], q: 0.25 | 0.75): number | null {
  if (values.length < 4) return null; // Not enough data for meaningful quartiles
  const sorted = [...values].sort((a, b) => a - b);
  const pos = q * (sorted.length - 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower);
}

/** Build comparables summary from filtered listings */
function buildComparablesSummary(
  comparables: ComparableListing[],
): ComparablesSummary | null {
  if (comparables.length < MARKET_DATA_POLICY.MIN_COMPARABLES_PUBLISHABLE) return null;

  const prices = comparables
    .map(c => c.pricePerSqm ?? (c.askingPrice && c.areaSqm ? c.askingPrice / c.areaSqm : null))
    .filter((p): p is number => p != null && p > 0);

  if (prices.length < MARKET_DATA_POLICY.MIN_COMPARABLES_PUBLISHABLE) return null;

  const medianPrice = median(prices);
  const q1 = quartile(prices, 0.25);
  const q3 = quartile(prices, 0.75);

  // Freshness score
  const ages = comparables.map(c => c.listingAgeDays ?? MARKET_DATA_POLICY.FRESHNESS_MAX_DAYS);
  const avgAge = ages.reduce((a, b) => a + b, 0) / ages.length;
  const freshnessScore = Math.max(0, Math.min(1,
    1 - (avgAge / MARKET_DATA_POLICY.FRESHNESS_MAX_DAYS)
  ));

  // Market depth
  const depthScore = Math.min(1, comparables.length / 15);

  // Coverage level
  let coverageLevel: ComparablesSummary["comparableCoverageLevel"];
  if (comparables.length >= MARKET_DATA_POLICY.MIN_COMPARABLES_GOOD) coverageLevel = "buona";
  else if (comparables.length >= MARKET_DATA_POLICY.MIN_COMPARABLES_PARTIAL) coverageLevel = "parziale";
  else if (comparables.length >= MARKET_DATA_POLICY.MIN_COMPARABLES_PUBLISHABLE) coverageLevel = "scarsa";
  else coverageLevel = "insufficiente";

  // Confidence: weighted by count, freshness, price spread coherence
  const spreadRatio = (q3 && q1 && medianPrice) ? (q3 - q1) / medianPrice : 1;
  const spreadPenalty = Math.min(0.3, spreadRatio * 0.5);
  const confidence = Math.max(0, Math.min(1,
    depthScore * 0.4 + freshnessScore * 0.3 + (1 - spreadPenalty) * 0.3
  ));

  return {
    comparablesCount: comparables.length,
    medianPricePerSqm: medianPrice ? Math.round(medianPrice) : null,
    lowerQuartilePricePerSqm: q1 ? Math.round(q1) : null,
    upperQuartilePricePerSqm: q3 ? Math.round(q3) : null,
    freshnessScore: parseFloat(freshnessScore.toFixed(2)),
    marketDepthScore: parseFloat(depthScore.toFixed(2)),
    comparableCoverageLevel: coverageLevel,
    marketDataConfidence: parseFloat(confidence.toFixed(2)),
    marketDataReason: `${comparables.length} comparabili filtrati, ` +
      `prezzo mediano €${medianPrice ? Math.round(medianPrice) : "n/d"}/mq, ` +
      `freshness ${(freshnessScore * 100).toFixed(0)}%, ` +
      `copertura ${coverageLevel}`,
  };
}

// ── Market Signals Builder ────────────────────────────────────

function buildMarketSignals(
  comparables: ComparableListing[],
  summary: ComparablesSummary | null,
): MarketSignals {
  const empty: MarketSignals = {
    priceBandLocale: null,
    marketFreshness: null,
    marketDepth: null,
    sellerPressure: null,
    premiumMicroAreaSignal: null,
    rentalAppealSignal: null,
    energyPremiumSignal: null,
    listingTurnoverSignal: null,
  };

  if (!summary || comparables.length < MARKET_DATA_POLICY.MIN_COMPARABLES_PUBLISHABLE) {
    return empty;
  }

  // Price band
  if (summary.medianPricePerSqm && summary.lowerQuartilePricePerSqm && summary.upperQuartilePricePerSqm) {
    empty.priceBandLocale = {
      signalId: "price_band_locale",
      label: "Fascia prezzo locale",
      value: `€${summary.lowerQuartilePricePerSqm}-${summary.upperQuartilePricePerSqm}/mq`,
      unit: "€/mq",
      sourceClass: summary.comparableCoverageLevel === "buona" ? "commercial_verified" : "elaborated",
      confidence: summary.marketDataConfidence,
      reason: `Basato su ${summary.comparablesCount} comparabili nella zona`,
      limitations: ["Range derivato da annunci pubblici, non da transazioni reali"],
    };
  }

  // Market freshness
  empty.marketFreshness = {
    signalId: "market_freshness",
    label: "Freschezza mercato",
    value: summary.freshnessScore,
    unit: "score 0-1",
    sourceClass: "elaborated",
    confidence: Math.min(summary.marketDataConfidence, 0.80),
    reason: `Score basato sull'età media degli annunci nella zona`,
    limitations: ["Misura la rotazione degli annunci, non l'attività transazionale reale"],
  };

  // Market depth
  empty.marketDepth = {
    signalId: "market_depth",
    label: "Profondità mercato",
    value: summary.marketDepthScore,
    unit: "score 0-1",
    sourceClass: "elaborated",
    confidence: Math.min(summary.marketDataConfidence, 0.75),
    reason: `${summary.comparablesCount} immobili disponibili nella zona`,
    limitations: ["Conta gli annunci attivi, non le transazioni concluse"],
  };

  // Seller pressure (ratio of stale to active)
  const activeCount = comparables.filter(c => c.status === "active").length;
  const staleCount = comparables.filter(c =>
    c.status === "stale" || (c.listingAgeDays != null && c.listingAgeDays > MARKET_DATA_POLICY.STALE_THRESHOLD_DAYS)
  ).length;
  if (activeCount + staleCount >= 3) {
    const pressureRatio = staleCount / (activeCount + staleCount);
    let pressureLabel: string;
    if (pressureRatio > 0.6) pressureLabel = "alta";
    else if (pressureRatio > 0.3) pressureLabel = "moderata";
    else pressureLabel = "bassa";

    empty.sellerPressure = {
      signalId: "seller_pressure",
      label: "Pressione vendita",
      value: pressureLabel,
      unit: null,
      sourceClass: "elaborated",
      confidence: Math.min(summary.marketDataConfidence, 0.65),
      reason: `${staleCount} annunci stagnanti su ${activeCount + staleCount} totali`,
      limitations: [
        "Basato su permanenza annunci, non su trattative reali",
        "Annunci rimossi possono indicare vendita o ritiro",
      ],
    };
  }

  // Listing turnover
  const recentCount = comparables.filter(c =>
    c.listingAgeDays != null && c.listingAgeDays <= 30
  ).length;
  if (comparables.length >= MARKET_DATA_POLICY.MIN_COMPARABLES_PARTIAL) {
    const turnoverRatio = recentCount / comparables.length;
    empty.listingTurnoverSignal = {
      signalId: "listing_turnover",
      label: "Turnover annunci",
      value: parseFloat(turnoverRatio.toFixed(2)),
      unit: "ratio",
      sourceClass: "elaborated",
      confidence: Math.min(summary.marketDataConfidence, 0.60),
      reason: `${recentCount} annunci nuovi (≤30gg) su ${comparables.length} totali`,
      limitations: ["Proxy di dinamismo, non di domanda reale"],
    };
  }

  return empty;
}

// ── Main Entry Point ──────────────────────────────────────────

/**
 * Collect market data from all configured providers and merge.
 * Returns a fully structured, confidence-gated, audit-ready result.
 *
 * Gating rules:
 * 1. Requires minimum identity confidence
 * 2. Microzona comparables require higher identity confidence
 * 3. Too few comparables → unavailable
 * 4. Conflicting providers → reduced confidence
 * 5. No provider configured → clean unavailable
 */
export async function collectMarketData(
  input: MarketLookupInput,
  finalIdentityConfidence: number,
  geoMatchLevel: string,
): Promise<MarketContextResult> {
  // ── Identity gating ──
  if (finalIdentityConfidence < MARKET_DATA_POLICY.MIN_IDENTITY_CONFIDENCE) {
    return makeUnavailableResult(
      `Confidenza identificazione insufficiente (${(finalIdentityConfidence * 100).toFixed(0)}% < ${(MARKET_DATA_POLICY.MIN_IDENTITY_CONFIDENCE * 100).toFixed(0)}%)`,
      ["Identificazione immobile insufficiente per dati di mercato"],
    );
  }

  // ── Get providers ──
  const providers = getMarketProviderChain();
  if (providers.length === 0) {
    return makeUnavailableResult(
      "Nessun provider dati di mercato configurato",
      [
        "Nessun provider commerciale di dati immobiliari è attivo",
        "Funzionalità predisposta per futura integrazione con fonti licenziate",
      ],
    );
  }

  // ── Query providers in parallel ──
  const promises = providers.map(async (p) => {
    try {
      return await p.lookup(input);
    } catch (e) {
      console.warn(`[market:${p.name}] Failed: ${String(e).slice(0, 80)}`);
      return null;
    }
  });
  const rawResults = await Promise.all(promises);
  const results = rawResults.filter((r): r is MarketDataProviderResult => r !== null);

  // ── Merge comparables ──
  const allComparables: ComparableListing[] = [];
  for (const r of results) {
    if (r.available) {
      allComparables.push(...r.comparables);
    }
  }

  // ── Filter by geoMatchLevel: microzona comparables need higher identity confidence
  const isMicrozonaEligible = finalIdentityConfidence >= MARKET_DATA_POLICY.MIN_IDENTITY_CONFIDENCE_MICROZONA &&
    ["address_point", "house_number"].includes(geoMatchLevel);

  const filtered = filterComparables(
    allComparables,
    input.areaSqm,
  );

  // ── Build summary ──
  const summary = buildComparablesSummary(filtered);
  const signals = buildMarketSignals(filtered, summary);

  // ── Provider breakdown ──
  const providerBreakdown = results.map(r => ({
    provider: r.provider,
    available: r.available,
    sourceClass: r.sourceClass,
    comparablesCount: r.comparables.length,
    confidence: r.confidence,
  }));

  // ── Determine overall sourceType ──
  let sourceType: MarketSourceClass = "unavailable";
  let marketContext: MarketContextResult["marketContext"] = "unavailable";

  if (summary) {
    if (summary.comparableCoverageLevel === "buona" && isMicrozonaEligible) {
      sourceType = "commercial_verified";
      marketContext = "available";
    } else if (summary.comparableCoverageLevel !== "insufficiente") {
      sourceType = "elaborated";
      marketContext = "partial";
    }
  }

  // ── Provider disagreement penalty ──
  let confidence = summary?.marketDataConfidence ?? 0;
  if (results.length >= 2) {
    const medians = results
      .filter(r => r.available && r.comparables.length >= 3)
      .map(r => {
        const prices = r.comparables
          .map(c => c.pricePerSqm)
          .filter((p): p is number => p != null && p > 0);
        return median(prices);
      })
      .filter((m): m is number => m != null);

    if (medians.length >= 2) {
      const maxMedian = Math.max(...medians);
      const minMedian = Math.min(...medians);
      if (maxMedian > 0 && (maxMedian - minMedian) / maxMedian > 0.30) {
        confidence *= 0.70; // 30% penalty for provider disagreement
      }
    }
  }

  // ── Build result ──
  const limitations: string[] = [];
  if (!isMicrozonaEligible && summary) {
    limitations.push("Identificazione indirizzo non sufficientemente precisa per comparabili micro-zona");
  }
  if (summary && summary.comparableCoverageLevel === "scarsa") {
    limitations.push(`Solo ${summary.comparablesCount} comparabili disponibili — dato indicativo`);
  }
  limitations.push("Prezzi basati su annunci pubblici (asking price), non su transazioni reali");
  limitations.push("I comparabili non sostituiscono una perizia professionale");

  return {
    marketContext,
    comparablesSummary: summary,
    marketSignals: signals,
    marketConfidence: parseFloat(confidence.toFixed(2)),
    marketConfidenceReason: summary
      ? `${summary.comparablesCount} comparabili da ${results.filter(r => r.available).length} provider, ` +
        `copertura ${summary.comparableCoverageLevel}, sourceType ${sourceType}`
      : "Dati di mercato insufficienti per pubblicazione",
    marketCoverageLevel: summary?.comparableCoverageLevel ?? "insufficiente",
    sourceType,
    sourceLabel: results.length > 0
      ? `Dati di mercato — ${results.filter(r => r.available).map(r => r.provider).join(", ")}`
      : "Dati di mercato (non integrato)",
    sourcePeriod: summary ? "ultimi 6 mesi" : null,
    limitations,
    providerBreakdown,
  };
}

// ── Unavailable Helper ────────────────────────────────────────

function makeUnavailableResult(reason: string, limitations: string[]): MarketContextResult {
  return {
    marketContext: "unavailable",
    comparablesSummary: null,
    marketSignals: {
      priceBandLocale: null,
      marketFreshness: null,
      marketDepth: null,
      sellerPressure: null,
      premiumMicroAreaSignal: null,
      rentalAppealSignal: null,
      energyPremiumSignal: null,
      listingTurnoverSignal: null,
    },
    marketConfidence: 0,
    marketConfidenceReason: reason,
    marketCoverageLevel: "insufficiente",
    sourceType: "unavailable",
    sourceLabel: "Dati di mercato (non integrato)",
    sourcePeriod: null,
    limitations,
    providerBreakdown: [],
  };
}

// ── Exports for testing ───────────────────────────────────────

export {
  filterComparables,
  buildComparablesSummary,
  buildMarketSignals,
  makeUnavailableResult,
  getMarketProviderChain,
};
