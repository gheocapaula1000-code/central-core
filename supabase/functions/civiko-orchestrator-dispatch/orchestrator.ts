// civiko-orchestrator-dispatch — logica pura, testabile e isolata Civiko One.
// Nessun I/O qui: solo contratti di pipeline (stage paralleli bounded), budget,
// validazione fail-closed dei payload REALI, sanificazione del risultato,
// avanzamento deterministico della certificazione fotografica e latest-wins
// sull'audit canonico civiko_orchestrator_action_runs.

export type SimpleAction =
  | "apify_immobiliare"
  | "apify_idealista"
  | "apify_subito"
  | "portal_casa"
  | "private_leads_nightly"
  | "collect_pending"
  | "private_leads_classify"
  | "tipo_lead_repair"
  | "price_snapshot"
  | "contendibili_backfill"
  | "contendibili_recompute"
  | "contendibili_image_certify"
  | "contendibili_pairs"
  | "contendibili_evidence"
  | "contendibili_extras"
  | "offmarket_discover"
  | "offmarket_scores"
  | "early_warning"
  | "radar_full"
  | "signals_classify";

export type PipelineAction = "pipeline_0510" | "pipeline_0545" | "pipeline_0710";

/** Marker canonico della pipeline dentro l'audit delle azioni. */
export const PIPELINE_MARKER_ACTION = "__pipeline__";

// ── Budget e timeout ────────────────────────────────────────────────────────
/** Budget totale hard: deve restare sotto il timeout esterno dell'edge. */
export const PIPELINE_BUDGET_MS = 165_000;
export const MAX_ACTION_TIMEOUT_MS = 100_000;
export const MIN_ACTION_TIMEOUT_MS = 5_000;
export const STEP_MIN_MS = 5_000;
/** Riserva per chiudere la risposta + finalizzare l'audit del run. */
export const RESPONSE_RESERVE_MS = 3_000;
export const FINAL_AUDIT_RESERVE_MS = 5_000;
export const BUDGET_RESERVE_MS = RESPONSE_RESERVE_MS + FINAL_AUDIT_RESERVE_MS;

/**
 * Timeout esterni per azione. Radar e offmarket hanno runtime interni reali di
 * ~85 s e ~80 s: il timeout esterno deve essere >= di quelli e comunque sotto
 * il budget complessivo dell'orchestratore.
 */
export const ACTION_TIMEOUT_MS: Record<SimpleAction, number> = {
  apify_immobiliare: 45_000,
  apify_idealista: 45_000,
  apify_subito: 45_000,
  portal_casa: 30_000,
  private_leads_nightly: 30_000,
  collect_pending: 40_000,
  private_leads_classify: 30_000,
  tipo_lead_repair: 30_000,
  price_snapshot: 35_000,
  contendibili_backfill: 30_000,
  contendibili_recompute: 35_000,
  contendibili_image_certify: 25_000,
  contendibili_pairs: 25_000,
  contendibili_evidence: 25_000,
  contendibili_extras: 25_000,
  // >= 80 s di runtime interno reale, < budget orchestratore.
  offmarket_discover: 85_000,
  offmarket_scores: 85_000,
  early_warning: 85_000,
  // >= 85 s di runtime interno reale, < budget orchestratore.
  radar_full: 90_000,
  signals_classify: 25_000,
};

/** Budget residuo utilizzabile: mai negativo, riserva sempre sottratta. */
export function usableRemainingMs(remainingMs: number): number {
  return Math.max(0, remainingMs - BUDGET_RESERVE_MS);
}

/** Timeout effettivo dello step: esplicito, bounded e compatibile col budget. */
export function stepTimeoutMs(action: SimpleAction, remainingMs: number): number {
  const base = Math.min(
    MAX_ACTION_TIMEOUT_MS,
    Math.max(MIN_ACTION_TIMEOUT_MS, ACTION_TIMEOUT_MS[action]),
  );
  return Math.max(1_000, Math.min(base, usableRemainingMs(remainingMs)));
}

/** Timeout di uno stage parallelo: il più lento dello stage, bounded. */
export function stageTimeoutMs(actions: SimpleAction[], remainingMs: number): number {
  return Math.max(...actions.map((a) => stepTimeoutMs(a, remainingMs)));
}

/** Non resta budget sufficiente per eseguire un altro step: 504. */
export function budgetExhausted(remainingMs: number): boolean {
  return usableRemainingMs(remainingMs) < STEP_MIN_MS;
}

// ── Contratto pipeline: stage paralleli bounded ─────────────────────────────
export interface PipelineStep {
  action: SimpleAction;
  /** Invocazioni consecutive dello stesso step (hard limit bounded). */
  repeat?: number;
}

/** Uno stage: le azioni al suo interno partono in parallelo bounded. */
export type PipelineStage = PipelineStep[];

/** Certificazione fotografica: hard limit 4 listing totali, max 6 invocazioni. */
export const IMAGE_CERTIFY_HARD_LIMIT = 4;
export const IMAGE_CERTIFY_MAX_INVOCATIONS = 6;
/**
 * Budget downstream che la fase immagini NON può mai consumare in 0545:
 * pairs (25) + snapshot/recompute in parallelo (35) + extras (25).
 */
export const IMAGE_DOWNSTREAM_RESERVE_MS = 85_000;

export const PIPELINES: Record<PipelineAction, { at: string; stages: PipelineStage[] }> = {
  // 05:10 — raccolta Casa.it multipagina, i 3 Apify in parallelo bounded e la
  // routine notturna dei lead privati. Nessuna classificazione qui: avviene
  // una sola volta, in 0545.
  pipeline_0510: {
    at: "05:10",
    stages: [
      [{ action: "portal_casa" }],
      [
        { action: "apify_immobiliare" },
        { action: "apify_idealista" },
        { action: "apify_subito" },
      ],
      [{ action: "private_leads_nightly" }],
    ],
  },
  // 05:45 — collect/import corrente (collect-pending importa e promuove già:
  // nessuna promozione duplicata), classificazione privati + backfill +
  // evidence in parallelo, fingerprint fotografico bounded, pairs,
  // snapshot/recompute in parallelo, extras.
  pipeline_0545: {
    at: "05:45",
    stages: [
      [{ action: "collect_pending" }],
      [
        { action: "private_leads_classify" },
        { action: "tipo_lead_repair" },
        { action: "contendibili_backfill" },
        { action: "contendibili_evidence" },
      ],
      [{ action: "contendibili_image_certify", repeat: IMAGE_CERTIFY_MAX_INVOCATIONS }],
      [{ action: "contendibili_pairs" }],
      [{ action: "price_snapshot" }, { action: "contendibili_recompute" }],
      [{ action: "contendibili_extras" }],
    ],
  },
  // 07:10 — stage paralleli bounded: radar+discover, poi scores+early warning,
  // infine la classificazione dei segnali.
  pipeline_0710: {
    at: "07:10",
    stages: [
      [{ action: "radar_full" }, { action: "offmarket_discover" }],
      [{ action: "offmarket_scores" }, { action: "early_warning" }],
      [{ action: "signals_classify" }],
    ],
  },
};

/** Ordine deterministico effettivo (stage appiattiti, repeat espanso). */
export function expandedSteps(pipeline: PipelineAction): SimpleAction[] {
  return PIPELINES[pipeline].stages.flatMap((stage) =>
    stage.flatMap((s) => Array.from({ length: Math.max(1, s.repeat ?? 1) }, () => s.action))
  );
}

/** Azioni dichiarate da una pipeline (senza repeat). */
export function pipelineActions(pipeline: PipelineAction): SimpleAction[] {
  return PIPELINES[pipeline].stages.flatMap((stage) => stage.map((s) => s.action));
}

// ── Segmentazione: ogni invocazione resta sotto il budget hard ──────────────
// Il timeout esterno REALE è PIPELINE_BUDGET_MS. La somma dei budget di stage
// di 0545 e 0710 lo supera: gli stage vengono quindi impacchettati in segmenti
// dimostrabilmente eseguibili in una singola invocazione e la pipeline prosegue
// con una continuazione che riusa lo STESSO pipeline_run_id.

/** Overhead deterministico per stage: audit di avvio + audit finale + rete. */
export const STAGE_OVERHEAD_MS = 2_000;
/** Riserva per avviare la continuazione (handshake) prima di rispondere. */
export const CONTINUATION_RESERVE_MS = 2_000;
/** Capacità massima dimostrabile di UNA invocazione. */
export const SEGMENT_CAPACITY_MS = PIPELINE_BUDGET_MS - BUDGET_RESERVE_MS -
  CONTINUATION_RESERVE_MS;

/** Costo peggiore di uno stage: azione più lenta (le altre sono parallele). */
export function stageWorstCaseMs(stage: PipelineStage): number {
  const slowest = Math.max(...stage.map((s) => ACTION_TIMEOUT_MS[s.action]));
  return slowest + STAGE_OVERHEAD_MS;
}

export interface PipelineSegment {
  /** Indice del primo stage del segmento. */
  from: number;
  /** Indice dell'ultimo stage del segmento (incluso). */
  to: number;
  /** Somma dei costi peggiori degli stage del segmento. */
  worstCaseMs: number;
}

/**
 * Impacchettamento deterministico: ogni segmento ha worstCaseMs <=
 * SEGMENT_CAPACITY_MS, quindi ogni stage è raggiungibile con riserva provabile.
 */
export function segmentPipeline(pipeline: PipelineAction): PipelineSegment[] {
  const stages = PIPELINES[pipeline].stages;
  const segments: PipelineSegment[] = [];
  let from = 0;
  let acc = 0;
  for (let i = 0; i < stages.length; i++) {
    const cost = stageWorstCaseMs(stages[i]);
    if (cost > SEGMENT_CAPACITY_MS) {
      // Contratto violato: nessuno stage può eccedere una singola invocazione.
      throw new Error(`stage_${pipeline}_${i}_exceeds_segment_capacity`);
    }
    if (acc > 0 && acc + cost > SEGMENT_CAPACITY_MS) {
      segments.push({ from, to: i - 1, worstCaseMs: acc });
      from = i;
      acc = 0;
    }
    acc += cost;
  }
  segments.push({ from, to: stages.length - 1, worstCaseMs: acc });
  return segments;
}

/** Segmento che inizia esattamente allo stage indicato (fail-closed). */
export function segmentStartingAt(
  pipeline: PipelineAction,
  stageFrom: number,
): PipelineSegment | null {
  return segmentPipeline(pipeline).find((s) => s.from === stageFrom) ?? null;
}

/** Costo peggiore degli stage residui del segmento, dopo `afterStage`. */
export function remainingStagesWorstCaseMs(
  pipeline: PipelineAction,
  afterStage: number,
  toStage: number,
): number {
  const stages = PIPELINES[pipeline].stages;
  let total = 0;
  for (let i = afterStage + 1; i <= Math.min(toStage, stages.length - 1); i++) {
    total += stageWorstCaseMs(stages[i]);
  }
  return total;
}

// ── Parsing fail-closed ─────────────────────────────────────────────────────
export interface ParsedBody {
  obj: Record<string, unknown> | null;
  error: string | null;
}

/**
 * Body JSON nullo, vuoto, non-oggetto o invalido = guasto. Vale anche per gli
 * RPC: una risposta opaca non può mai passare per successo.
 */
export function parseStepBody(text: string | null | undefined): ParsedBody {
  if (typeof text !== "string" || !text.trim()) {
    return { obj: null, error: "empty_body" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { obj: null, error: "invalid_json" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { obj: null, error: "invalid_payload" };
  }
  if (Array.isArray(parsed)) {
    // Gli RPC PostgREST restituiscono legittimamente un array di righe:
    // lo normalizziamo in un oggetto ispezionabile, mai in "nessun body".
    return { obj: { rows: parsed, rows_count: parsed.length }, error: null };
  }
  return { obj: parsed as Record<string, unknown>, error: null };
}

// ── Ricerca bounded dentro payload annidati ─────────────────────────────────
const MAX_SCAN_DEPTH = 6;

function scan(
  value: unknown,
  depth: number,
  visit: (obj: Record<string, unknown>) => boolean,
): boolean {
  if (depth > MAX_SCAN_DEPTH || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) {
      if (scan(item, depth + 1, visit)) return true;
    }
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (visit(obj)) return true;
  for (const v of Object.values(obj)) {
    if (scan(v, depth + 1, visit)) return true;
  }
  return false;
}

/** Numero > 0 per la chiave, a qualunque profondità bounded. */
export function hasPositiveNumber(root: unknown, key: string): boolean {
  return scan(root, 0, (o) => {
    const v = o[key];
    return typeof v === "number" && Number.isFinite(v) && v > 0;
  });
}

/** Somma bounded dei valori numerici della chiave. */
export function sumNumber(root: unknown, key: string): number {
  let total = 0;
  scan(root, 0, (o) => {
    const v = o[key];
    if (typeof v === "number" && Number.isFinite(v)) total += v;
    return false;
  });
  return total;
}

/** Stringa non vuota per la chiave, a qualunque profondità bounded. */
export function hasNonEmptyString(root: unknown, key: string): boolean {
  return scan(root, 0, (o) => typeof o[key] === "string" && (o[key] as string).trim().length > 0);
}

/** Booleano esattamente true per la chiave. */
export function hasTrue(root: unknown, key: string): boolean {
  return scan(root, 0, (o) => o[key] === true);
}

/** Array non vuoto per la chiave. */
export function hasNonEmptyArray(root: unknown, key: string): boolean {
  return scan(root, 0, (o) => Array.isArray(o[key]) && (o[key] as unknown[]).length > 0);
}

// ── Esito semantico su payload REALI ────────────────────────────────────────
function truthyError(v: unknown): boolean {
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return false;
}

/**
 * Qualunque ok:false, error o errors annidato, a qualsiasi profondità, è
 * guasto. Superata la profondità massima si fallisce chiuso.
 */
export function nestedFailure(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== "object") return null;
  if (depth > MAX_SCAN_DEPTH) return "nested_depth_overflow";
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) {
      const f = nestedFailure(item, depth + 1);
      if (f) return f;
    }
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (obj.ok === false) return "nested_ok_false";
  if (obj.success === false) return "nested_success_false";
  if (typeof obj.status === "string" && /^(failed|failure|error|aborted|timed[-_]?out)$/i.test(obj.status.trim())) {
    return "nested_status_failed";
  }
  if (truthyError(obj.error)) return "nested_error";
  if (typeof obj.errors === "number" && obj.errors > 0) return "nested_errors_count";
  if (Array.isArray(obj.errors) && obj.errors.length > 0) return "nested_errors";
  if (typeof obj.errors_count === "number" && obj.errors_count > 0) return "nested_errors_count";
  if (Array.isArray(obj.failures) && obj.failures.length > 0) return "nested_failures";
  if (obj.skipped === true) return "nested_skipped";
  if (typeof obj.skipped === "string" && obj.skipped.trim()) return "nested_skipped";
  // Nessuna chiave esente: anche counters/metrics vengono ispezionati.
  for (const v of Object.values(obj)) {
    const f = nestedFailure(v, depth + 1);
    if (f) return f;
  }
  return null;
}

/** Portali obbligatori nel contratto di collect-pending. */
export const COLLECT_REQUIRED_PORTALS = ["immobiliare", "idealista", "subito"] as const;

/** Body aggiuntivo imposto dall'orchestratore per rendere il contratto esigibile. */
export const COLLECT_PENDING_CONTRACT_BODY = {
  require_candidates: true,
  require_terminal: true,
  required_portals: COLLECT_REQUIRED_PORTALS,
} as const;

/**
 * Prova di avanzamento reale, specifica per azione e basata sui payload che le
 * funzioni restituiscono davvero. Nessuna fixture, nessun "async_start" nudo.
 */
export function payloadFailure(
  action: SimpleAction,
  obj: Record<string, unknown> | null,
): string | null {
  if (!obj) return "invalid_body";

  if (action === "portal_casa") {
    // enqueue-padova-portal-scrapes restituisce enqueued: [] (ARRAY).
    const enqueued = obj.enqueued;
    if (!Array.isArray(enqueued)) return "casa_enqueued_not_array";
    if (enqueued.length === 0) return "casa_enqueued_empty";
    if (!hasNonEmptyString(enqueued, "queue_id")) return "casa_queue_id_missing";
    return null;
  }

  if (action === "apify_immobiliare" || action === "apify_idealista" || action === "apify_subito") {
    if (!hasPositiveNumber(obj, "started_count")) return "apify_started_count_zero";
    // async_start da solo non basta: serve un identificativo di run reale.
    if (!hasNonEmptyString(obj, "run_id") && !hasNonEmptyString(obj, "dataset_id")) {
      return "apify_run_identifier_missing";
    }
    return null;
  }

  if (action === "collect_pending") {
    if (!hasPositiveNumber(obj, "scanned")) return "collect_scanned_zero";
    const completed = sumNumber(obj, "completed_count");
    if (completed < COLLECT_REQUIRED_PORTALS.length) return "collect_completed_insufficient";
    if (!hasTrue(obj, "required_portals_complete")) return "collect_required_portals_incomplete";
    if (sumNumber(obj, "errors_count") > 0) return "collect_errors_present";
    // Zero novità è ammesso SOLO come dichiarazione esplicita e non scavalca
    // né i portali terminali né gli item provider già verificati sopra.
    if (hasPositiveNumber(obj, "imports_count")) return null;
    if (obj.zero_novelty === true) return null;
    return "collect_no_imports";
  }

  return null;
}

/** HTTP 200 non basta: skipped/error/zero provider inatteso sono guasti. */
export function semanticFailure(
  action: SimpleAction,
  obj: Record<string, unknown> | null,
): string | null {
  if (!obj) return "invalid_body";
  if (obj.ok === false) return "ok_false";
  if (obj.skipped === true) return "skipped";
  if (typeof obj.skipped === "string" && obj.skipped.trim()) return "skipped";
  if (truthyError(obj.error)) return "error";
  if (Array.isArray(obj.errors) && obj.errors.length > 0) return "errors";
  const nested = nestedFailure(obj);
  if (nested) return nested;
  return payloadFailure(action, obj);
}

/** Status HTTP propagato: mai 2xx quando un qualunque step fallisce. */
export function pipelineStatus(
  steps: Array<{ ok: boolean; status: number }>,
  budgetExhausted: boolean,
): number {
  const failing = steps.find((s) => !s.ok);
  if (!failing) return 200;
  if (budgetExhausted) return 504;
  if (failing.status >= 400 && failing.status <= 599) return failing.status;
  return 502;
}

// ── Sanificazione del risultato conservato nell'audit ───────────────────────
/** Solo identificativi operativi: correlano il run, non contengono PII. */
export const SAFE_ID_KEYS = ["run_id", "dataset_id", "queue_id"] as const;
const SAFE_LABEL_KEYS = new Set([
  "job",
  "slug",
  "portal",
  "action",
  "status",
  "match_version",
  "evidence_kind",
  "skipped",
  "reason",
  "error_code",
]);
const SANITIZE_MAX_DEPTH = 5;
const SANITIZE_MAX_ARRAY = 20;
const SANITIZE_MAX_KEYS = 60;
const SAFE_LABEL_MAX_LENGTH = 80;

function sanitizeValue(value: unknown, key: string, depth: number): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const keep = (SAFE_ID_KEYS as readonly string[]).includes(key) || SAFE_LABEL_KEYS.has(key);
    return keep ? value.slice(0, SAFE_LABEL_MAX_LENGTH) : undefined;
  }
  if (Array.isArray(value)) {
    if (depth >= SANITIZE_MAX_DEPTH) return undefined;
    const out = value
      .slice(0, SANITIZE_MAX_ARRAY)
      .map((v) => sanitizeValue(v, key, depth + 1))
      .filter((v) => v !== undefined);
    return out;
  }
  if (value && typeof value === "object") {
    if (depth >= SANITIZE_MAX_DEPTH) return undefined;
    return sanitizeResult(value, depth + 1);
  }
  return undefined;
}

/**
 * Conserva il JSON di risposta SANIFICATO (non i soli contatori): identificativi
 * di correlazione, numeri, booleani e array sanificati. Le stringhe libere sono
 * scartate, tranne poche etichette non sensibili.
 */
export function sanitizeResult(raw: unknown, depth = 0): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const [k, v] of Object.entries(src)) {
    if (kept >= SANITIZE_MAX_KEYS) break;
    const s = sanitizeValue(v, k, depth);
    if (s === undefined) continue;
    if (Array.isArray(s) && s.length === 0 && !Array.isArray(v)) continue;
    if (s !== null && typeof s === "object" && !Array.isArray(s) && Object.keys(s).length === 0) {
      continue;
    }
    out[k] = s;
    kept++;
  }
  return out;
}

// ── Certificazione fotografica: avanzamento deterministico ──────────────────
export interface ImageCertifyProgress {
  attempted?: unknown;
  remaining?: unknown;
  /** Marker monotono di avanzamento del run (non un id/offset di coda). */
  progress_marker?: unknown;
  zero_novelty?: unknown;
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function imageCertifyMarker(progress: ImageCertifyProgress): number | null {
  return numOrNull(progress.progress_marker);
}

/**
 * Nessun cursore su una coda mutante: la Edge marca atomicamente i listing
 * trattati (anche senza foto o non decodificabili) e restituisce un marker di
 * progresso monotono. Si ripete solo se il marker avanza davvero.
 */
export function shouldRepeatImageCertify(
  invocation: number,
  progress: ImageCertifyProgress,
  previousMarker: number | null,
): boolean {
  if (invocation >= IMAGE_CERTIFY_MAX_INVOCATIONS) return false;
  if (progress.zero_novelty === true) return false;
  const remaining = numOrNull(progress.remaining);
  if (remaining !== null && remaining <= 0) return false;
  const attempted = numOrNull(progress.attempted);
  if (attempted !== null && attempted <= 0) return false;
  const marker = imageCertifyMarker(progress);
  if (marker === null) return false;
  if (previousMarker !== null && marker <= previousMarker) return false;
  return true;
}

/**
 * La fase immagini non può erodere il budget downstream di 0545: si ripete solo
 * se, dopo lo step, resta almeno IMAGE_DOWNSTREAM_RESERVE_MS.
 */
export function imageBudgetAllows(remainingMs: number): boolean {
  return usableRemainingMs(remainingMs) - ACTION_TIMEOUT_MS.contendibili_image_certify >=
    IMAGE_DOWNSTREAM_RESERVE_MS;
}

/** Budget minimo per completare la coda downstream di 0545 dopo le immagini. */
export function downstreamBudgetOk(remainingMs: number): boolean {
  return usableRemainingMs(remainingMs) >= IMAGE_DOWNSTREAM_RESERVE_MS;
}

// ── Audit canonico: civiko_orchestrator_action_runs ─────────────────────────
export interface ActionRunRow {
  action: string;
  started_at: string;
  finished_at: string | null;
  ok: boolean | null;
  status: number | null;
  error_code: string | null;
  pipeline?: string | null;
  pipeline_run_id?: string | null;
  attempt_no?: number | null;
}

function runTime(r: ActionRunRow): number {
  const t = Date.parse(r.finished_at ?? r.started_at);
  return Number.isFinite(t) ? t : 0;
}

/** Chiave anti-omonimia: la stessa azione in 0510 e 0545 non si maschera. */
export function actionKey(r: ActionRunRow): string {
  return `${r.pipeline ?? "none"}::${r.action}`;
}

/**
 * ESATTO ultimo marker __pipeline__ di ciascuna pipeline, incluso failed e
 * in-progress: un vecchio successo non può mai coprire un tentativo più nuovo.
 */
export function latestPipelineMarkers(
  rows: ActionRunRow[],
): Map<PipelineAction, ActionRunRow> {
  const out = new Map<PipelineAction, ActionRunRow>();
  const known = new Set(Object.keys(PIPELINES));
  for (const r of rows) {
    if (r.action !== PIPELINE_MARKER_ACTION) continue;
    if (typeof r.pipeline !== "string" || !known.has(r.pipeline)) continue;
    if (typeof r.pipeline_run_id !== "string" || !r.pipeline_run_id) continue;
    const key = r.pipeline as PipelineAction;
    const prev = out.get(key);
    if (!prev || runTime(r) >= runTime(prev)) out.set(key, r);
  }
  return out;
}

/** Solo gli step appartenenti a quegli esatti run (stesso run E stessa pipeline). */
export function stepsOfExactRuns(
  rows: ActionRunRow[],
  latest: Map<PipelineAction, ActionRunRow>,
): ActionRunRow[] {
  const byRun = new Map<string, string>();
  for (const [pipeline, marker] of latest) {
    if (marker.pipeline_run_id) byRun.set(marker.pipeline_run_id, pipeline);
  }
  return rows.filter((r) => {
    if (r.action === PIPELINE_MARKER_ACTION) return false;
    if (typeof r.pipeline_run_id !== "string") return false;
    const pipeline = byRun.get(r.pipeline_run_id);
    return Boolean(pipeline) && r.pipeline === pipeline;
  });
}

/** Ultimo TENTATIVO per (pipeline, azione): attempt_no più alto, poi tempo. */
export function latestRunsByAction(rows: ActionRunRow[]): Map<string, ActionRunRow> {
  const out = new Map<string, ActionRunRow>();
  for (const r of rows) {
    const key = actionKey(r);
    const prev = out.get(key);
    if (!prev) {
      out.set(key, r);
      continue;
    }
    const a = r.attempt_no ?? 1;
    const b = prev.attempt_no ?? 1;
    if (a > b || (a === b && runTime(r) >= runTime(prev))) out.set(key, r);
  }
  return out;
}

/** Azioni la cui ultima esecuzione nell'esatto run non è ok (o non terminata). */
export function failingActions(rows: ActionRunRow[]): string[] {
  const bad: string[] = [];
  for (const [key, run] of latestRunsByAction(rows)) {
    if (run.ok !== true || run.finished_at === null) bad.push(key);
    else if (typeof run.status === "number" && (run.status < 200 || run.status > 299)) bad.push(key);
  }
  return bad.sort();
}

/** Chiavi attese: pipeline::azione, per ciascuna delle 3 pipeline. */
export const REQUIRED_ACTION_KEYS: string[] = (Object.keys(PIPELINES) as PipelineAction[])
  .flatMap((p) => pipelineActions(p).map((a) => `${p}::${a}`));

export function missingActions(rows: ActionRunRow[]): string[] {
  const latest = latestRunsByAction(rows);
  return REQUIRED_ACTION_KEYS.filter((k) => {
    const run = latest.get(k);
    return !run || run.ok !== true;
  });
}

/** Le 3 pipeline devono avere un ultimo marker concluso e riuscito. */
export function pipelinesNotOk(latest: Map<PipelineAction, ActionRunRow>): string[] {
  return (Object.keys(PIPELINES) as PipelineAction[]).filter((p) => {
    const run = latest.get(p);
    if (!run || run.ok !== true || !run.finished_at) return true;
    return typeof run.status === "number" && (run.status < 200 || run.status > 299);
  });
}

// ── Release gate ────────────────────────────────────────────────────────────
export type GateMode = "routine" | "initial_validation";

export function parseGateMode(raw: unknown): GateMode {
  return raw === "initial_validation" ? "initial_validation" : "routine";
}

export interface GateIntegrity {
  portali_freschi: number;
  mismatch_professionale: number;
  listings_freschi: number;
  classificazione_ultima: string | null;
  recompute_ultimo: string | null;
  contendibili_totali: number;
  recompute_corrente: boolean;
  /** Nome reale della colonna della vista: pipeline_0710_ultimo. */
  pipeline_0710_ultimo: string | null;
  pipeline_0710_ok: boolean;
  pipeline_0710_run_id: string | null;
  pipeline_0545_run_id: string | null;
  pwa_sync_ack_ultimo_ok: string | null;
  pwa_sync_ack_corrente: boolean;
  contendibili_fuori_perimetro: number;
  privati_fuori_perimetro: number;
}

/**
 * Ricevuta PWA reale: l'ack ok più recente deve essere concluso DOPO la fine
 * dell'ESATTA ultima pipeline_0710. Il recompute non è un surrogato.
 */
export function ackAfterPipeline(
  ackFinishedAt: string | null,
  pipeline0710FinishedAt: string | null,
): boolean {
  if (!ackFinishedAt || !pipeline0710FinishedAt) return false;
  const ack = Date.parse(ackFinishedAt);
  const pipe = Date.parse(pipeline0710FinishedAt);
  if (!Number.isFinite(ack) || !Number.isFinite(pipe)) return false;
  return ack > pipe;
}

export const CIVIKO_PORTALS = ["casa", "immobiliare", "idealista", "subito"] as const;

export interface GateRequirement {
  key: string;
  passed: boolean;
}

export interface GateEvaluationInput {
  mode: GateMode;
  metric: (group: string, name: string) => number;
  integrity: GateIntegrity;
  /** SOLO gli step degli esatti ultimi run delle 3 pipeline. */
  actionRuns: ActionRunRow[];
  /** Ultimo marker di ciascuna pipeline (anche fallito o in corso). */
  pipelineRuns: Map<PipelineAction, ActionRunRow>;
}

export function buildGateRequirements(input: GateEvaluationInput): GateRequirement[] {
  const { metric: g, integrity, mode, actionRuns, pipelineRuns } = input;
  const failing = failingActions(actionRuns);
  const missing = missingActions(actionRuns);
  const badPipelines = pipelinesNotOk(pipelineRuns);

  const base: GateRequirement[] = [
    ...CIVIKO_PORTALS.map((p) => ({
      key: `portale_${p}_fresh`,
      passed: g("portals", `collect_items_${p}_fresh`) > 0,
    })),
    { key: "casa_processor_no_dead", passed: g("casa_pipeline", "queue_processor_dead") === 0 },
    { key: "promozione_corrente", passed: integrity.listings_freschi > 0 },
    { key: "mismatch_professionale_zero", passed: integrity.mismatch_professionale === 0 },
    {
      key: "classificazione_corrente",
      passed: g("classified_in_window", "signals_classified_updated") > 0,
    },
    // Il recompute appartiene all'esatto ultimo pipeline_0545, mai al 0710.
    { key: "recompute_corrente_0545", passed: integrity.recompute_corrente === true },
    { key: "pipeline_0710_ok", passed: integrity.pipeline_0710_ok === true },
    {
      key: "pwa_sync_ack_dopo_pipeline_0710",
      passed: integrity.pwa_sync_ack_corrente === true &&
        ackAfterPipeline(integrity.pwa_sync_ack_ultimo_ok, integrity.pipeline_0710_ultimo),
    },
    { key: "perimetro_contendibili_padova_8_zone", passed: integrity.contendibili_fuori_perimetro === 0 },
    { key: "perimetro_privati_padova_8_zone", passed: integrity.privati_fuori_perimetro === 0 },
    { key: "ultime_tre_pipeline_ok", passed: badPipelines.length === 0 },
    { key: "nessun_fallimento_recente", passed: failing.length === 0 },
    { key: "tutti_gli_step_hanno_lavorato", passed: missing.length === 0 },
  ];

  if (mode === "routine") {
    // Notte ordinaria: zero novità è valido SOLO se la catena corrente è
    // completa (tutti gli step del run esatto ok) e le fonti sono fresche.
    return base;
  }

  // Collaudo iniziale: novità reali su TUTTI e 4 i portali nello stesso ciclo.
  return [
    ...base,
    ...CIVIKO_PORTALS.map((p) => ({
      key: `initial_nuovi_import_${p}`,
      passed: g("imported", `listings_${p}_imported_in_window`) > 0,
    })),
    {
      key: "initial_contendibile_certificato_2_piu",
      passed: g("categories", "contendibili_total") > 0,
    },
    {
      key: "initial_fingerprint_fresco",
      passed: g("categories", "image_fingerprints_fresh") > 0,
    },
  ];
}
