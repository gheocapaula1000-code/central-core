import type { BudgetMode } from "../_shared/radarBudget.ts";

export type AgentRadarIngestionMode = "soft" | "full";

export interface AgentRadarIngestionPolicyInput {
  intent?: unknown;
  mode?: unknown;
  scope?: unknown;
  triggered_by?: unknown;
  comuni: string[];
  budget_mode?: BudgetMode | null;
  run_budget_eur?: number | null;
  hasFirecrawlKey?: boolean;
}

export interface AgentRadarIngestionPolicyDecision {
  shouldRunIngestion: boolean;
  ingestionMode: AgentRadarIngestionMode;
  warnings: string[];
  skipReason?: string;
  normalizedIntent: string;
  normalizedMode: string;
  normalizedScope: string;
  normalizedTrigger: string;
}

function norm(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

function isSoftLike(v: string): boolean {
  return v === "soft" || v === "incremental" || v === "cron" || v === "scheduled" || v === "daily";
}

/**
 * Pure decision gate for /agent-radar pre-read ingestion.
 * Fixes the previous no-op where cron sent mode/scope=soft/incremental but omitted intent,
 * so /agent-radar read cached data only and returned an empty cost ledger with no warning.
 */
export function decideAgentRadarIngestion(input: AgentRadarIngestionPolicyInput): AgentRadarIngestionPolicyDecision {
  const normalizedIntent = norm(input.intent);
  const normalizedMode = norm(input.mode);
  const normalizedScope = norm(input.scope);
  const normalizedTrigger = norm(input.triggered_by);
  const budgetMode = input.budget_mode ?? "normal";
  const runBudget = Number(input.run_budget_eur ?? 0);

  const wantsFull = normalizedIntent === "full" || normalizedMode === "full";
  const wantsSoft = isSoftLike(normalizedIntent) || isSoftLike(normalizedMode) || isSoftLike(normalizedScope) || isSoftLike(normalizedTrigger);
  const ingestionMode: AgentRadarIngestionMode = wantsFull ? "full" : "soft";
  const warnings: string[] = [];

  if (!wantsFull && !wantsSoft) {
    warnings.push("soft_ingestion_skipped_not_requested");
    return { shouldRunIngestion: false, ingestionMode, warnings, skipReason: "not_requested", normalizedIntent, normalizedMode, normalizedScope, normalizedTrigger };
  }
  if (input.comuni.length === 0) {
    warnings.push("soft_ingestion_skipped_no_comuni");
    return { shouldRunIngestion: false, ingestionMode, warnings, skipReason: "no_comuni", normalizedIntent, normalizedMode, normalizedScope, normalizedTrigger };
  }
  if (budgetMode === "capped") {
    warnings.push("soft_ingestion_skipped_budget_capped");
    return { shouldRunIngestion: false, ingestionMode, warnings, skipReason: "budget_capped", normalizedIntent, normalizedMode, normalizedScope, normalizedTrigger };
  }
  if ((budgetMode === "normal" || budgetMode === "cautious") && runBudget <= 1) {
    warnings.push("soft_ingestion_skipped_run_budget_too_low");
    return { shouldRunIngestion: false, ingestionMode, warnings, skipReason: "run_budget_too_low", normalizedIntent, normalizedMode, normalizedScope, normalizedTrigger };
  }
  if (!input.hasFirecrawlKey) {
    warnings.push("soft_ingestion_skipped_no_firecrawl_key");
    return { shouldRunIngestion: false, ingestionMode, warnings, skipReason: "no_firecrawl_key", normalizedIntent, normalizedMode, normalizedScope, normalizedTrigger };
  }

  return { shouldRunIngestion: true, ingestionMode, warnings, normalizedIntent, normalizedMode, normalizedScope, normalizedTrigger };
}
