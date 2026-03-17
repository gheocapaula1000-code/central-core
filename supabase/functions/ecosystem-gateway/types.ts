// ═══════════════════════════════════════════════════════════════
// EcoSystem Gateway — Types
// ═══════════════════════════════════════════════════════════════

export interface PropertyInput {
  address?: string;
  comune?: string;
  provincia?: string;
  lat?: number;
  lng?: number;
  street?: string;
  houseNumber?: string;
  propertyType?: string;
  areaSqm?: number;
  finalIdentityConfidence?: number;
  geoMatchLevel?: string;
}

export interface ListingEnrichmentRequest {
  source_app?: string;
  property: PropertyInput;
  snapshot?: Record<string, unknown>;
  options?: {
    includeMarket?: boolean;
    includeAreaDevelopment?: boolean;
  };
}

export interface ServicePackContext {
  operation?: string;
  propertyType?: string;
  hasUtilitiesDocs?: boolean;
  hasContracts?: boolean;
  wantsArchive?: boolean;
  needsComplaintSupport?: boolean;
  wantsFundingInfo?: boolean;
  needsDelegationDocs?: boolean;
  wantsBusinessPlan?: boolean;
}

export interface ServicePackRequest {
  source_app?: string;
  context?: ServicePackContext;
}

export interface UnifiedReportRequest {
  keydraft?: Record<string, unknown>;
  enrichment?: Record<string, unknown>;
  servicePack?: Record<string, unknown>;
  options?: {
    includeExecutiveSummary?: boolean;
  };
}

export interface RecommendedService {
  service_key: string;
  target_app: string;
  title: string;
  route: string;
  reason: string;
  priority: "high" | "medium" | "low";
  availability: "suggested";
  deeplink: string | null;
}
