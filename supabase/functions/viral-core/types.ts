// ═══════════════════════════════════════════════════════════════
// Viral Core — Types
// ═══════════════════════════════════════════════════════════════

export interface BrandProfile {
  name?: string;
  toneNotes?: string;
  cta?: string;
  sector?: string;
}

export interface HistoryHints {
  recentTopics?: string[];
  recentHashtags?: string[];
  recentFingerprints?: string[];
}

export type Platform = "tiktok" | "instagram" | "facebook" | "linkedin";
export type Formato = "post" | "reel";
export type RiskLevel = "low" | "medium" | "high";
export type PublishMode = "manual_review" | "draft_only" | "eligible_manual_publish";

export interface PolicyResult {
  riskLevel: RiskLevel;
  publishModeRecommendation: PublishMode;
  riskFlags: string[];
  notes: string[];
}

export interface GenerateBundleRequest {
  source_app?: string;
  argomento: string;
  obiettivo?: string;
  tono?: string;
  formato?: Formato;
  brandProfile?: BrandProfile;
  options?: {
    includeGoogleAdsPack?: boolean;
    includeVideoScript15s?: boolean;
    includePolicyCheck?: boolean;
  };
  historyHints?: HistoryHints;
}

export interface GenerateSingleRequest {
  source_app?: string;
  platform: Platform;
  argomento: string;
  obiettivo?: string;
  tono?: string;
  formato?: Formato;
  brandProfile?: BrandProfile;
  historyHints?: HistoryHints;
}

export interface PolicyCheckRequest {
  source_app?: string;
  contents: Partial<Record<Platform, string>>;
  historyHints?: HistoryHints;
  scheduleHints?: {
    sameDayCrossPost?: boolean;
    plannedTimes?: Partial<Record<Platform, string>>;
  };
}

export interface BuildMediaBriefRequest {
  source_app?: string;
  platform: Platform;
  content: string;
  mediaSuggestion?: string;
  formato?: Formato;
  brandProfile?: BrandProfile;
}
