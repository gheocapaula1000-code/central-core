// ═══════════════════════════════════════════════════════════════
// Property Detail — Domain Types (Phase 1)
// Veneto-scoped property detail assembly
// ═══════════════════════════════════════════════════════════════

// ── Property ID ───────────────────────────────────────────────

/**
 * Property ID format: veneto:<lat>:<lng>
 * Example: veneto:45.4064:11.8768
 * Lat range (Veneto): 44.8 – 46.7
 * Lng range (Veneto): 10.6 – 13.1
 */
export interface ParsedPropertyId {
  region: "veneto";
  lat: number;
  lng: number;
}

// ── Provenance ────────────────────────────────────────────────

export interface BlockProvenance {
  source: string;
  confidence: number;
  updatedAt: string; // ISO 8601
}

// ── Provider Outcome ──────────────────────────────────────────

export type ProviderOutcome = "resolved" | "unavailable" | "failed";

export interface ProviderResult<T> {
  outcome: ProviderOutcome;
  data: T | null;
  provenance: BlockProvenance | null;
  error?: string; // only when outcome=failed, internal only
}

// ── Block Shapes ──────────────────────────────────────────────

export interface IdentityBlock {
  address: string;
  comune: string;
  provincia: string;
  region: string;
  street: string | null;
  houseNumber: string | null;
  postalCode: string | null;
  lat: number;
  lng: number;
  geoMatchLevel: string;
  buildingId: string;
  provenance: BlockProvenance;
}

export interface ValuationBlock {
  prezzoMqMin: number | null;
  prezzoMqMax: number | null;
  prezzoMedio: number | null;
  zona: string | null;
  zonaDescrizione: string | null;
  tipologia: string | null;
  fonte: string | null;
  matchMethod: string | null;
  matchConfidence: number | null;
  provenance: BlockProvenance;
}

export interface TerritoryBlock {
  popolazione: number | null;
  etaMedia: number | null;
  zonaSismica: number | null;
  rischioIdrogeologico: string | null;
  provenance: BlockProvenance;
}

export interface SignalsBlock {
  scuoleVicine: number | null;
  trendDemografico: string | null;
  provenance: BlockProvenance;
}

// ── Response Contract ─────────────────────────────────────────

export interface PropertyDetailMeta {
  requestedAt: string;
  resolvedBlocks: string[];
  failedBlocks: string[];
}

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
export type BlockName = typeof BLOCK_NAMES[number];
