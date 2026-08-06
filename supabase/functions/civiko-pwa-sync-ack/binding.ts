// Civiko One / Padova — binding server-side dell'ack alla pipeline reale.
// Modulo puro, senza I/O: la PWA non può dichiarare a quale run appartiene
// il proprio sync. Il Core lo deriva dalle esecuzioni pipeline_0710 registrate.

export const PIPELINE_ACK = "pipeline_0710";
export const PIPELINE_MAX_AGE_MS = 4 * 60 * 60_000;

export interface PipelineRunRow {
  run_id: string;
  pipeline: string;
  finished_at: string | null;
  ok: boolean | null;
}

export type BindingResult =
  | { ok: true; pipelineRunId: string; pipelineFinishedAt: string }
  | { ok: false; code: string; message: string };

/**
 * Contratto:
 *  - si considerano solo le esecuzioni pipeline_0710 concluse;
 *  - si prende la PIÙ RECENTE conclusa prima di started_at, anche se fallita;
 *  - l'ack è accettato solo se quella riga è ok=true, finished_at < started_at
 *    e distante meno di 4 ore;
 *  - se esiste una 0710 conclusa dopo started_at, l'ack è superato (mismatch).
 */
export function bindAckToPipeline(
  rows: readonly PipelineRunRow[],
  startedAtMs: number,
): BindingResult {
  const finished = rows
    .filter((r) => r.pipeline === PIPELINE_ACK && typeof r.finished_at === "string")
    .map((r) => ({ ...r, ts: Date.parse(r.finished_at as string) }))
    .filter((r) => Number.isFinite(r.ts))
    .sort((a, b) => b.ts - a.ts);

  if (finished.length === 0) {
    return { ok: false, code: "PIPELINE_RUN_NOT_FOUND", message: "No completed pipeline_0710 run" };
  }

  if (finished[0].ts >= startedAtMs) {
    return {
      ok: false,
      code: "PIPELINE_RUN_SUPERSEDED",
      message: "A newer pipeline_0710 run completed after the sync started",
    };
  }

  const latest = finished[0];
  if (latest.ok !== true) {
    return { ok: false, code: "PIPELINE_RUN_FAILED", message: "Latest pipeline_0710 run did not succeed" };
  }
  if (startedAtMs - latest.ts > PIPELINE_MAX_AGE_MS) {
    return { ok: false, code: "PIPELINE_RUN_STALE", message: "Latest pipeline_0710 run is older than 4 hours" };
  }

  return {
    ok: true,
    pipelineRunId: latest.run_id,
    pipelineFinishedAt: new Date(latest.ts).toISOString(),
  };
}
