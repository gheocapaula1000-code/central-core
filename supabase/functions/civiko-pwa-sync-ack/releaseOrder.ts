// Ordine di rilascio Civiko One / Padova.
// Rollout reale: 05:10 pipeline_0510, 05:45 pipeline_0545, 07:10 pipeline_0710,
// sync PWA ~07:25, release_gate chiamato da job separato (~+20 min).
// Il gate NON deve esigere che release_gate condivida il pipeline_run_id con 0710:
// deve verificare l'ordine temporale STRETTO sui latest-attempt exact audit.
// Specchio in TypeScript della logica SQL di public.civiko_padova_release_gate_v.

export type PipelineAttempt = {
  pipeline_run_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  ok: boolean | null;
  status: number | null;
};

export type AckWindow = {
  started_at: string | null;
  finished_at: string | null;
};

export type ReleaseOrderInput = {
  p0510: PipelineAttempt | null;
  p0545: PipelineAttempt | null;
  p0710: PipelineAttempt | null;
  ack: AckWindow | null;
  checked_at: string;
};

export type ReleaseOrderResult = {
  ok: boolean;
  reason:
    | "OK"
    | "PIPELINE_0510_NOT_OK"
    | "PIPELINE_0545_NOT_OK"
    | "PIPELINE_0710_NOT_OK"
    | "PIPELINE_0510_WINDOW_INVALID"
    | "PIPELINE_0545_WINDOW_INVALID"
    | "PIPELINE_0710_WINDOW_INVALID"
    | "ACK_MISSING"
    | "OVERLAP_0510_0545"
    | "OVERLAP_0545_0710"
    | "ACK_BEFORE_0710_END"
    | "ACK_WINDOW_INVALID"
    | "CHECKED_AT_INVALID"
    | "ACK_AFTER_CHECK";
};

const t = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

// Un latest-attempt fallito o ancora in corso maschera i successi precedenti.
export function attemptSucceeded(a: PipelineAttempt | null): boolean {
  if (!a) return false;
  if (a.ok !== true) return false;
  if (a.status === null || a.status < 200 || a.status > 299) return false;
  return t(a.finished_at) !== null && t(a.started_at) !== null;
}

// Finestra interna STRETTAMENTE valida: entrambi finiti e started_at < finished_at.
// Il solo parsing dei due timestamp non basta.
export function windowValid(
  started_at: string | null | undefined,
  finished_at: string | null | undefined,
): boolean {
  const s = t(started_at);
  const f = t(finished_at);
  return s !== null && f !== null && s < f;
}

export function evaluateReleaseOrder(input: ReleaseOrderInput): ReleaseOrderResult {
  const { p0510, p0545, p0710, ack, checked_at } = input;

  if (!attemptSucceeded(p0510)) return { ok: false, reason: "PIPELINE_0510_NOT_OK" };
  if (!attemptSucceeded(p0545)) return { ok: false, reason: "PIPELINE_0545_NOT_OK" };
  if (!attemptSucceeded(p0710)) return { ok: false, reason: "PIPELINE_0710_NOT_OK" };
  if (!ack) return { ok: false, reason: "ACK_MISSING" };

  const end0510 = t(p0510!.finished_at)!;
  const start0545 = t(p0545!.started_at)!;
  const end0545 = t(p0545!.finished_at)!;
  const start0710 = t(p0710!.started_at)!;
  const end0710 = t(p0710!.finished_at)!;
  const ackStart = t(ack.started_at);
  const ackEnd = t(ack.finished_at);
  const checked = t(checked_at);

  if (!(end0510 < start0545)) return { ok: false, reason: "OVERLAP_0510_0545" };
  if (!(end0545 < start0710)) return { ok: false, reason: "OVERLAP_0545_0710" };
  if (ackStart === null || ackEnd === null) return { ok: false, reason: "ACK_MISSING" };
  if (!(end0710 < ackStart)) return { ok: false, reason: "ACK_BEFORE_0710_END" };
  if (!(ackStart < ackEnd)) return { ok: false, reason: "ACK_WINDOW_INVALID" };
  if (checked === null || !(ackEnd < checked)) return { ok: false, reason: "ACK_AFTER_CHECK" };

  return { ok: true, reason: "OK" };
}
