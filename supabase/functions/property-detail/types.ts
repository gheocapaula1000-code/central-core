// ═══════════════════════════════════════════════════════════════
// Property Detail — Domain Types (Phase 3 — Micro-area)
// Veneto-scoped property detail assembly.
// Adds precisionLevel / spatialScope / radiusMeters to provenance,
// honest valuation semantics (sqm vs total), and structured per-indicator
// provenance for the territory block.
// ═══════════════════════════════════════════════════════════════

// ── Public Property ID ────────────────────────────────────────

export interface InternalCoordinates {
  lat: number;
  lng: number;
}

// ── Precision / Spatial Scope ────────────────────────────────

/**
 * The actual spatial precision at which a piece of data is supportable.
 * Never overstate this. If a source is comune-level, do not label it civic.
 */
export type PrecisionLevel =
  | "building"
  | "civic"
  | "street"
  | "microzone"
  | "neighborhood"
  | "comune"
  | "provincia"
  | "regione";

/**
 * The spatial extent the underlying source actually covers.
 * `point` = the single resolved coordinate.
 * `buffer_*m` = a circular buffer around the point.
 * `microzone` / `neighborhood` / `comune` = administrative / OMI aggregations.
 */
export type SpatialScope =
  | "point"
  | "street_segment"
  | "buffer_50m"
  | "buffer_100m"
  | "buffer_250m"
  | "buffer_500m"
  | "microzone"
  | "neighborhood"
  | "comune"
  | "provincia"
  | "regione";

// ── Provenance ────────────────────────────────────────────────

export interface BlockProvenance {
  source: string;
  confidence: "alta" | "media" | "bassa";
  updatedAt: string; // ISO 8601 date or date-time
  precisionLevel: PrecisionLevel;
  spatialScope: SpatialScope;
  radiusMeters?: number | null;
}

// ── Provider Outcome ──────────────────────────────────────────

export type ProviderOutcome = "resolved" | "unavailable" | "failed";

export interface ProviderResult<T> {
  outcome: ProviderOutcome;
  data: T | null;
  provenance: BlockProvenance | null;
  error?: string;
}

// ── Block Shapes (Frontend Contract) ──────────────────────────

export interface IdentityBlock {
  indirizzo: string | null;
  civico: string | null;
  comune: string;
  provincia: string;
  cap: string | null;
  coordinate: { lat: number; lng: number };
  /**
   * Geocoder match level for the resolved address — drives the precisionLevel
   * inside provenance. Honest values: "civic" / "street" / "microzone" / "comune".
   */
  precisionLevel: PrecisionLevel;
  microZona: string | null;
  zonaOmi: string | null;
  tipologia: string | null;
  stato: string | null;
  superficieMq: number | null;
  locali: number | null;
  piano: string | null;
  annoCostruzione: number | null;
  classeEnergetica: string | null;
  provenance: BlockProvenance;
}

/**
 * A single derived indicator. Each carries its own provenance / scope so the
 * frontend can show that, e.g., "sicurezza" is derived from comune-level
 * environmental risk, not from civic-level safety data.
 *
 * `value` is a band string (e.g. "molto bassa" | "bassa" | "media" | "alta")
 * or a free short label. `kind` documents the underlying real signal so that
 * names cannot be confused (e.g. environmental risk ≠ criminality).
 */
export interface TerritoryIndicator {
  value: string;
  kind:
    | "environmental_risk_inverse"
    | "demographic_age_profile"
    | "residential_density"
    | "service_proximity"
    | "green_proximity"
    | "mobility_access"
    | "traffic_pressure"
    | "noise_proxy";
  provenance: BlockProvenance;
}

/**
 * Honest indicator slots. Each is either a real `TerritoryIndicator` or null
 * (= unavailable). Names are precise: do not relabel environmental risk as
 * "sicurezza generale" or traffic as "criminalità".
 */
export interface TerritoryIndicators {
  sicurezzaAmbientale: TerritoryIndicator | null;
  rischioIdrogeologico: TerritoryIndicator | null;
  profiloDemografico: TerritoryIndicator | null;
  residenzialita: TerritoryIndicator | null;
  serviziProssimita: TerritoryIndicator | null;
  verdeProssimita: TerritoryIndicator | null;
  accessibilita: TerritoryIndicator | null;
  pressioneTraffico: TerritoryIndicator | null;
  rumoreProxy: TerritoryIndicator | null;
}

export interface TerritoryBlock {
  microZona: string | null;
  sommario: string | null;
  puntiForti: string[] | null;
  criticita: string[] | null;
  indicatori: TerritoryIndicators | null;
  scenarioFuturo: string | null;
  provenance: BlockProvenance;
}

/**
 * Honest valuation semantics.
 *
 * OMI publishes €/m² ranges. Do NOT fabricate a total property valuation
 * unless the backend has real total inputs (we don't yet). Total fields stay
 * null in V1. Per-sqm fields are the commercially-credible truth.
 */
export interface ValuationBlock {
  prezzoMqStimato: number | null;
  prezzoMqMinimo: number | null;
  prezzoMqMassimo: number | null;
  prezzoTotaleStimato: number | null;
  prezzoTotaleMinimo: number | null;
  prezzoTotaleMassimo: number | null;
  unita: "EUR_per_mq";
  drivers: string | null;
  provenance: BlockProvenance;
}

export interface SignalItem {
  id: string;
  tipo: string;
  titolo: string;
  descrizione: string;
  impatto: string;
  orizzonte: string;
  provenance: BlockProvenance;
}

export type SignalsBlock = SignalItem[];

// ── Response Contract ─────────────────────────────────────────

export interface PropertyDetailMeta {
  requestedAt: string;
  resolvedBlocks: string[];
  failedBlocks: string[];
}

/**
 * Returned DIRECTLY as the HTTP body. No ok/data/warnings wrapper.
 */
export interface PropertyDetailResponse {
  id: string;
  meta: PropertyDetailMeta;
  identity: IdentityBlock | null;
  territory: TerritoryBlock | null;
  valuation: ValuationBlock | null;
  signals: SignalsBlock | null;
  createdAt: string;
  updatedAt: string;
}

// ── Veneto Bounds ─────────────────────────────────────────────

export const VENETO_BOUNDS = {
  latMin: 44.8,
  latMax: 46.7,
  lngMin: 10.6,
  lngMax: 13.1,
} as const;

// ── Block Names ───────────────────────────────────────────────

export const BLOCK_NAMES = ["identity", "territory", "valuation", "signals"] as const;
export type BlockName = (typeof BLOCK_NAMES)[number];

// ── Standard Radii (meters) ──────────────────────────────────

export const STANDARD_RADII = [50, 100, 250, 500] as const;
export type StandardRadius = (typeof STANDARD_RADII)[number];
