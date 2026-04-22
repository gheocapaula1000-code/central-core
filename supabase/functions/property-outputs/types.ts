// ═══════════════════════════════════════════════════════════════
// Property Outputs — Types
// Backend-only orchestration that turns a PropertyDetailResponse
// into the 5 commercial output families.
//
// Audience model:
//   - "agency"  → internal agency truth (provenance, confidence, caveats)
//   - "client"  → polished commercial language (no raw uncertainty)
//
// We deliberately re-declare the consumed shape here as a structural
// subset so this module compiles in isolation and frontend types are
// not coupled to provider internals.
// ═══════════════════════════════════════════════════════════════

export type Audience = "agency" | "client";

export type Confidence = "alta" | "media" | "bassa";

export type PrecisionLevel =
  | "building"
  | "civic"
  | "street"
  | "microzone"
  | "neighborhood"
  | "comune"
  | "provincia"
  | "regione";

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

export interface BlockProvenance {
  source: string;
  confidence: Confidence;
  updatedAt: string;
  precisionLevel: PrecisionLevel;
  spatialScope: SpatialScope;
  radiusMeters?: number | null;
}

export interface IdentityIn {
  indirizzo: string | null;
  civico: string | null;
  comune: string;
  provincia: string;
  cap: string | null;
  coordinate: { lat: number; lng: number };
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

export interface TerritoryIndicatorIn {
  value: string;
  kind: string;
  provenance: BlockProvenance;
}

export interface TerritoryIn {
  microZona: string | null;
  sommario: string | null;
  puntiForti: string[] | null;
  criticita: string[] | null;
  indicatori: Record<string, TerritoryIndicatorIn | null> | null;
  scenarioFuturo: string | null;
  provenance: BlockProvenance;
}

export interface ValuationIn {
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

export interface SignalItemIn {
  id: string;
  tipo: string;
  titolo: string;
  descrizione: string;
  impatto: string;
  orizzonte: string;
  provenance: BlockProvenance;
}

export interface PropertyDetailIn {
  id: string;
  identity: IdentityIn | null;
  territory: TerritoryIn | null;
  valuation: ValuationIn | null;
  signals: SignalItemIn[] | null;
}

// ── Output Families ──────────────────────────────────────────

export type OutputFamily =
  | "report_agenzia"
  | "annuncio_lungo"
  | "annuncio_portali"
  | "fascicolo_cliente"
  | "locandina";

export interface OutputSection {
  heading: string;
  body: string;
  /** True when this section is intentionally commercial-only (no caveats). */
  clientFacing: boolean;
  /** Optional structured caveat list — only emitted for agency audiences. */
  caveats?: string[];
}

export interface OutputDocument {
  family: OutputFamily;
  audience: Audience;
  propertyId: string;
  title: string;
  /** Short subtitle / dek — always supportable. */
  subtitle: string | null;
  sections: OutputSection[];
  /** Stable list of generation rules that fired (for QA / observability). */
  appliedRules: string[];
  /** Stable list of overclaim guards that suppressed text. */
  suppressedClaims: string[];
  /** Block availability snapshot. */
  availability: {
    identity: boolean;
    territory: boolean;
    valuation: boolean;
    signals: boolean;
  };
  generatedAt: string;
}

export interface GenerateOutputsRequest {
  audience: Audience;
  families: OutputFamily[];
  detail: PropertyDetailIn;
}

export interface GenerateOutputsResponse {
  propertyId: string;
  audience: Audience;
  documents: OutputDocument[];
  generatedAt: string;
}

export const ALL_FAMILIES: OutputFamily[] = [
  "report_agenzia",
  "annuncio_lungo",
  "annuncio_portali",
  "fascicolo_cliente",
  "locandina",
];
