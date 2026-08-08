// Civiko — separazione fra perimetro fotografico di routine e backlog storico.
//
// La routine 05:45 esegue al massimo PHOTO_BATCH_MAX_INVOCATIONS micro-batch da
// PHOTO_BATCH_LIMIT annunci: il suo perimetro certificabile è quindi 24 elementi.
// Pretendere lo svuotamento dell'intera coda (centinaia di elementi) rendeva la
// pipeline sempre rossa. Il backlog resta misurato, con progresso e stato propri,
// ma non viene mai dichiarato verde per finta.

export const PHOTO_BATCH_LIMIT = 4;
export const PHOTO_BATCH_MAX_INVOCATIONS = 6;
export const PHOTO_ROUTINE_PERIMETER = PHOTO_BATCH_LIMIT * PHOTO_BATCH_MAX_INVOCATIONS;

export interface PhotoBatchResult {
  ok: boolean;
  processed?: unknown;
  attempted?: unknown;
  remaining?: unknown;
  remaining_exact?: unknown;
  queue_complete?: unknown;
}

export type PhotoBacklogStatus = "empty" | "in_progress" | "unknown";

export interface PhotoPerimeterState {
  perimeter: number;
  invocations: number;
  processed: number;
  queue_complete: boolean;
  perimeter_complete: boolean;
  backlog_remaining: number | null;
  backlog_exact: boolean;
  backlog_status: PhotoBacklogStatus;
  backlog_progress_pct: number | null;
}

function num(raw: unknown): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Valuta il perimetro di routine sui micro-batch realmente eseguiti.
 * Il perimetro è completo quando la coda si è svuotata oppure quando la routine
 * ha esaurito il proprio budget di invocazioni senza errori: in quel caso il
 * residuo è backlog, non un fallimento del ciclo corrente.
 */
export function evaluatePhotoPerimeter(
  results: PhotoBatchResult[],
  perimeter: number = PHOTO_ROUTINE_PERIMETER,
): PhotoPerimeterState {
  const invocations = results.length;
  const allOk = invocations > 0 && results.every((row) => row.ok === true);
  const last = results[invocations - 1];
  const processed = results.reduce(
    (sum, row) => sum + num(row.processed ?? row.attempted),
    0,
  );
  const queueComplete = last?.queue_complete === true;
  const remainingExact = last?.remaining_exact === true;
  const remainingRaw = last === undefined ? null : Number(last.remaining);
  const backlogRemaining = queueComplete
    ? 0
    : (Number.isFinite(remainingRaw as number) ? Number(remainingRaw) : null);
  const budgetExhausted = invocations >= PHOTO_BATCH_MAX_INVOCATIONS ||
    processed >= perimeter;
  const perimeterComplete = allOk && (queueComplete || budgetExhausted);
  const backlogStatus: PhotoBacklogStatus = queueComplete
    ? "empty"
    : (backlogRemaining !== null && remainingExact ? "in_progress" : "unknown");
  const total = backlogRemaining !== null ? backlogRemaining + processed : null;
  return {
    perimeter,
    invocations,
    processed,
    queue_complete: queueComplete,
    perimeter_complete: perimeterComplete,
    backlog_remaining: backlogRemaining,
    backlog_exact: remainingExact,
    backlog_status: backlogStatus,
    backlog_progress_pct: total && total > 0
      ? Math.round((processed / total) * 1000) / 10
      : (queueComplete ? 100 : null),
  };
}
