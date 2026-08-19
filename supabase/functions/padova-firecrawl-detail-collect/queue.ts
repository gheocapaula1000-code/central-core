// Queue predicate for padova_collect_v2_items — must match
// claim_padova_detail_batch (attempts < 2 AND unprocessed or retryable).
// run_full / run_batch previously counted mq IS NULL AND raw_json IS NULL,
// which marked the job done after the first pass even when retries remained.

export const SOURCE_JOB_ID = "e9709a73-e91f-49c4-bc11-a8bf27829875";
export const DEFAULT_COLLECT_JOB_ID = "01a1368e-d0b1-4b85-8778-f197891efe1a";
export const MAX_ATTEMPTS = 2;
export const CLAIMABLE_PARSE_STATUSES = ["failed_processed_unknown", "error"] as const;

export type ParseStatus = "done_ok" | "dead_404" | "timeout" | "anti_bot" | "empty_parse" | "network_error";
export type StoredParseStatus = "done_ok" | "dead_404" | "empty_parse" | "error" | "dead_unrecoverable";

export function isClaimableDetailRow(row: {
  url?: string | null;
  attempts?: number | null;
  processed_at?: string | null;
  parse_status?: string | null;
}): boolean {
  if (!row.url) return false;
  if ((row.attempts ?? 0) >= MAX_ATTEMPTS) return false;
  if (row.processed_at == null || row.processed_at === "") return true;
  return (CLAIMABLE_PARSE_STATUSES as readonly string[]).includes(row.parse_status ?? "");
}

/** PostgREST `.or(...)` matching claim_padova_detail_batch. */
export function remainingQueueOrFilter(): string {
  return "processed_at.is.null,parse_status.in.(failed_processed_unknown,error)";
}

export function storedStatus(status: ParseStatus, nextAttempts: number): StoredParseStatus {
  if (status === "done_ok" || status === "dead_404" || status === "empty_parse") return status;
  if (nextAttempts >= MAX_ATTEMPTS) return "dead_unrecoverable";
  return "error";
}

export function logReason(status: ParseStatus, error?: string): string | null {
  if (status === "done_ok") return null;
  if (error) return `${status}:${error}`.slice(0, 500);
  return status;
}

export function shouldContinueChaining(processed: number, remaining: number, writeError: string | null): boolean {
  return !writeError && remaining > 0 && processed > 0;
}
