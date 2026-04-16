// ═══════════════════════════════════════════════════════════════
// Property Detail — Domain Types (Phase 1)
// Veneto-scoped property detail assembly
// Aligned to the agreed frontend Property Detail contract
// ═══════════════════════════════════════════════════════════════

// ── Public Property ID ────────────────────────────────────────

/**
 * Public property ID format: urn:ccv3:property:veneto:<stable-id>
 * The stable-id is a deterministic hash derived from resolved location data.
 * Internal coordinate lookup is kept separate from the public ID contract.
 */
export interface InternalCoordinates {
  lat: number;
  lng: number;
}

// ── Provenance ────────────────────────────────────────────────

export interface BlockProvenance {
  source: string;
  confidence: string; // "alta" | "media" | "bassa" — human-readable
  updatedAt: string;  // ISO 8601 date or date-time
}

// ── Provider Outcome ──────────────────────────────────────────

export type ProviderOutcome = "resolved" | "unavailable" | "failed";

export interface ProviderResult<T> {
  outcome: ProviderOutcome;
  data: T | null;
  provenance: BlockProvenance | null;
  error?: string; // only when outcome=failed, internal only
}

// ── Block Shapes (Frontend Contract) ──────────────────────────

export interface IdentityBlock {
  indirizzo: string | null;
  civico: string | null;
  comune: string;
  provincia: string;
  cap: string | null;
  coordinate: { lat: number; lng: number };
  tipologia: string | null;
  stato: string | null;
  superficieMq: number | null;
  locali: number | null;
  piano: string | null;
  annoCostruzione: number | null;
  classeEnergetica: string | null;
  provenance: BlockProvenance;
}

export interface TerritoryBlock {
  microZona: string | null;
  sommario: string | null;
  puntiForti: string[] | null;
  criticita: string[] | null;
  indicatori: {
    vivibilita: string | null;
    sicurezza: string | null;
    rumore: string | null;
    servizi: string | null;
  } | null;
  scenarioFuturo: string | null;
  provenance: BlockProvenance;
}

export interface ValuationBlock {
  prezzoStimato: number | null;
  prezzoMinimo: number | null;
  prezzoMassimo: number | null;
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

// signals block is an array of SignalItem (or null if unavailable/failed)
export type SignalsBlock = SignalItem[];

// ── Response Contract ─────────────────────────────────────────

export interface PropertyDetailMeta {
  requestedAt: string;
  resolvedBlocks: string[];
  failedBlocks: string[];
}

/**
 * The endpoint returns this shape DIRECTLY as the HTTP response body.
 * No ok/data/warnings wrapper.
 */
export interface PropertyDetailResponse {
  id: string; // urn:ccv3:property:veneto:<stable-id>
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
