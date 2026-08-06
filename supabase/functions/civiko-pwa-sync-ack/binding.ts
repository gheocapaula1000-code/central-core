// Civiko One / Padova — binding server-side dell'ack alla pipeline reale.
// Modulo puro, senza I/O: la PWA non può dichiarare a quale run appartiene
// il proprio sync. Il Core lo deriva dall'audit fail-closed canonico
// `civiko_orchestrator_action_runs`, marker di pipeline `__pipeline__`.
//
// `civiko_pipeline_runs` NON è più una fonte di verità: era best-effort e
// poteva mancare o restare aperta senza bloccare l'ack.

export const PIPELINE_ACK = "pipeline_0710";
export const PIPELINE_MARKER_ACTION = "__pipeline__";
export const PIPELINE_MAX_AGE_MS = 4 * 60 * 60_000;

/** Riga dell'audit canonico degli step/pipeline dell'orchestratore. */
export interface ActionRunRow {
  id?: string | null;
  pipeline_run_id: string | null;
  action: string;
  pipeline: string | null;
  started_at: string | null;
  finished_at: string | null;
  ok: boolean | null;
  status: number | null;
  attempt_no?: number | null;
  created_at?: string | null;
}

export type BindingResult =
  | { ok: true; pipelineRunId: string; pipelineFinishedAt: string }
  | { ok: false; code: string; message: string };

function ts(value: unknown): number {
  const t = Date.parse(typeof value === "string" ? value : "");
  return Number.isFinite(t) ? t : 0;
}

/**
 * Ordinamento canonico dei tentativi: ULTIMO TENTATIVO AVVIATO.
 * Mai `finished_at`: un run vecchio che termina tardi non deve mascherare un
 * tentativo più nuovo ancora in corso o fallito.
 * Tie-break stabile e deterministico: attempt_no, created_at, id.
 */
export function compareAttempts(a: ActionRunRow, b: ActionRunRow): number {
  const byStart = ts(b.started_at) - ts(a.started_at);
  if (byStart !== 0) return byStart;
  const byAttempt = (b.attempt_no ?? 0) - (a.attempt_no ?? 0);
  if (byAttempt !== 0) return byAttempt;
  const byCreated = ts(b.created_at) - ts(a.created_at);
  if (byCreated !== 0) return byCreated;
  return String(b.id ?? "").localeCompare(String(a.id ?? ""));
}

/**
 * Contratto (latest-wins, mai filtrare per ok prima di scegliere):
 *  - si considera SOLO il marker `__pipeline__` di `pipeline_0710`;
 *  - si prende l'ULTIMO TENTATIVO PER started_at, anche fallito o in corso:
 *    un tentativo più recente impedisce di legare un vecchio successo che è
 *    terminato dopo l'avvio del nuovo;
 *  - l'ack è accettato solo se quel tentativo è concluso, ok=true, con
 *    status HTTP 2xx, finished_at STRETTAMENTE < started_at del sync e
 *    distante meno di 4 ore.
 */
export function bindAckToPipeline(
  rows: readonly ActionRunRow[],
  startedAtMs: number,
): BindingResult {
  const candidates = rows
    .filter((r) =>
      r.action === PIPELINE_MARKER_ACTION &&
      r.pipeline === PIPELINE_ACK &&
      typeof r.pipeline_run_id === "string" &&
      r.pipeline_run_id.length > 0
    )
    .sort(compareAttempts);

  if (candidates.length === 0) {
    return {
      ok: false,
      code: "PIPELINE_RUN_NOT_FOUND",
      message: "No pipeline_0710 audit marker available",
    };
  }

  const latest = candidates[0];

  if (typeof latest.finished_at !== "string") {
    return {
      ok: false,
      code: "PIPELINE_RUN_IN_PROGRESS",
      message: "Latest pipeline_0710 attempt has not finished",
    };
  }
  const finishedTs = Date.parse(latest.finished_at);
  if (!Number.isFinite(finishedTs)) {
    return { ok: false, code: "PIPELINE_RUN_INVALID", message: "Latest pipeline_0710 marker is malformed" };
  }

  if (finishedTs >= startedAtMs) {
    return {
      ok: false,
      code: "PIPELINE_RUN_SUPERSEDED",
      message: "A newer pipeline_0710 attempt completed after the sync started",
    };
  }
  if (latest.ok !== true) {
    return { ok: false, code: "PIPELINE_RUN_FAILED", message: "Latest pipeline_0710 attempt did not succeed" };
  }
  if (typeof latest.status !== "number" || latest.status < 200 || latest.status > 299) {
    return { ok: false, code: "PIPELINE_RUN_FAILED", message: "Latest pipeline_0710 attempt has a non-2xx status" };
  }
  if (startedAtMs - finishedTs > PIPELINE_MAX_AGE_MS) {
    return { ok: false, code: "PIPELINE_RUN_STALE", message: "Latest pipeline_0710 attempt is older than 4 hours" };
  }

  return {
    ok: true,
    pipelineRunId: latest.pipeline_run_id as string,
    pipelineFinishedAt: new Date(finishedTs).toISOString(),
  };
}
