// civiko-orchestrator-dispatch — logica pura, testabile e isolata Civiko One.
// Nessun I/O qui: solo contratti di pipeline, timeout, valutazione semantica,
// latest-wins sull'audit e costruzione dei requisiti del release gate.

export type SimpleAction =
  | "apify_immobiliare"
  | "apify_idealista"
  | "apify_subito"
  | "portal_casa"
  | "collect_pending"
  | "listings_promote"
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

// ── Budget e timeout ────────────────────────────────────────────────────────
// Budget totale massimo della pipeline: deve restare sotto il timeout esterno.
export const PIPELINE_BUDGET_MS = 165_000;
// Nessun default illimitato: ogni azione ha un timeout esplicito e bounded.
export const MAX_ACTION_TIMEOUT_MS = 60_000;
export const MIN_ACTION_TIMEOUT_MS = 5_000;
export const STEP_MIN_MS = 5_000;
// Margine sempre lasciato al budget complessivo per chiudere la risposta.
export const BUDGET_RESERVE_MS = 3_000;

export const ACTION_TIMEOUT_MS: Record<SimpleAction, number> = {
  apify_immobiliare: 45_000,
  apify_idealista: 45_000,
  apify_subito: 45_000,
  portal_casa: 30_000,
  collect_pending: 45_000,
  listings_promote: 45_000,
  private_leads_classify: 30_000,
  tipo_lead_repair: 30_000,
  price_snapshot: 30_000,
  contendibili_backfill: 45_000,
  contendibili_recompute: 60_000,
  contendibili_image_certify: 25_000,
  contendibili_pairs: 30_000,
  contendibili_evidence: 30_000,
  contendibili_extras: 45_000,
  offmarket_discover: 45_000,
  offmarket_scores: 30_000,
  early_warning: 30_000,
  radar_full: 45_000,
  signals_classify: 30_000,
};

/** Timeout effettivo dello step: esplicito, bounded e compatibile col budget. */
export function stepTimeoutMs(action: SimpleAction, remainingMs: number): number {
  const base = Math.min(
    MAX_ACTION_TIMEOUT_MS,
    Math.max(MIN_ACTION_TIMEOUT_MS, ACTION_TIMEOUT_MS[action]),
  );
  return Math.max(1_000, Math.min(base, remainingMs - BUDGET_RESERVE_MS));
}

// ── Contratto pipeline ──────────────────────────────────────────────────────
export interface PipelineStep {
  action: SimpleAction;
  /** Invocazioni consecutive dello stesso step (hard limit bounded). */
  repeat?: number;
}

/** Certificazione fotografica: hard limit 4 elementi per invocazione, max 6. */
export const IMAGE_CERTIFY_HARD_LIMIT = 4;
export const IMAGE_CERTIFY_MAX_INVOCATIONS = 6;

export const PIPELINES: Record<PipelineAction, { at: string; steps: PipelineStep[] }> = {
  // 05:10 — raccolta Casa.it + Apify (immobiliare/idealista/subito) e
  // classificazione dei lead privati.
  pipeline_0510: {
    at: "05:10",
    steps: [
      { action: "portal_casa" },
      { action: "apify_immobiliare" },
      { action: "apify_idealista" },
      { action: "apify_subito" },
      { action: "private_leads_classify" },
    ],
  },
  // 05:45 — collect pending, promozione, privati classify/backfill,
  // evidence enqueue, fingerprint fotografico bounded, pairs,
  // snapshot/recompute, extras.
  pipeline_0545: {
    at: "05:45",
    steps: [
      { action: "collect_pending" },
      { action: "listings_promote" },
      { action: "tipo_lead_repair" },
      { action: "private_leads_classify" },
      { action: "contendibili_backfill" },
      { action: "contendibili_evidence" },
      { action: "contendibili_image_certify", repeat: IMAGE_CERTIFY_MAX_INVOCATIONS },
      { action: "contendibili_pairs" },
      { action: "price_snapshot" },
      { action: "contendibili_recompute" },
      { action: "contendibili_extras" },
    ],
  },
  // 07:10 — radar/offmarket, scores/early warning e classificazione finale.
  pipeline_0710: {
    at: "07:10",
    steps: [
      { action: "radar_full" },
      { action: "offmarket_discover" },
      { action: "offmarket_scores" },
      { action: "early_warning" },
      { action: "signals_classify" },
    ],
  },
};

/** Ordine deterministico effettivo (repeat espanso). */
export function expandedSteps(pipeline: PipelineAction): SimpleAction[] {
  return PIPELINES[pipeline].steps.flatMap((s) =>
    Array.from({ length: Math.max(1, s.repeat ?? 1) }, () => s.action)
  );
}

// ── Esito semantico ─────────────────────────────────────────────────────────
export const ZERO_GUARD: Partial<Record<SimpleAction, readonly string[]>> = {
  apify_immobiliare: ["run_id", "dataset_id", "processed", "inserted", "enqueued"],
  apify_idealista: ["run_id", "dataset_id", "processed", "inserted", "enqueued"],
  apify_subito: ["run_id", "dataset_id", "processed", "inserted", "enqueued"],
  portal_casa: ["enqueued", "processed", "rows_out"],
  collect_pending: ["processed", "inserted", "updated", "rows_out"],
};

function hasProgress(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((k) => {
    const v = obj[k];
    if (typeof v === "number") return Number.isFinite(v) && v > 0;
    if (typeof v === "string") return v.trim().length > 0;
    return v === true;
  });
}

/** HTTP 200 non basta: skipped/error/zero provider inatteso sono guasti. */
export function semanticFailure(
  action: SimpleAction,
  obj: Record<string, unknown> | null,
): string | null {
  if (!obj) return null;
  if (obj.ok === false) return "ok_false";
  if (obj.skipped === true) return "skipped";
  if (typeof obj.error === "string" && obj.error.trim()) return "error";
  const keys = ZERO_GUARD[action];
  if (keys && !hasProgress(obj, keys)) return "zero_provider_result";
  return null;
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

// ── Audit latest-wins ───────────────────────────────────────────────────────
export interface ActionRunRow {
  action: string;
  finished_at: string | null;
  started_at: string;
  ok: boolean | null;
  status: number | null;
  error_code: string | null;
}

function runTime(r: ActionRunRow): number {
  const t = Date.parse(r.finished_at ?? r.started_at);
  return Number.isFinite(t) ? t : 0;
}

/** Ultima esecuzione per azione: un vecchio successo non copre un fallimento. */
export function latestRunsByAction(rows: ActionRunRow[]): Map<string, ActionRunRow> {
  const out = new Map<string, ActionRunRow>();
  for (const r of rows) {
    const prev = out.get(r.action);
    if (!prev || runTime(r) >= runTime(prev)) out.set(r.action, r);
  }
  return out;
}

/** Azioni la cui ULTIMA esecuzione non è ok (o non è mai terminata). */
export function failingActions(rows: ActionRunRow[]): string[] {
  const latest = latestRunsByAction(rows);
  const bad: string[] = [];
  for (const [action, run] of latest) {
    if (run.ok !== true || run.finished_at === null) bad.push(action);
  }
  return bad.sort();
}

/** Azioni attese dalle 3 pipeline con ultima esecuzione riuscita presente. */
export const REQUIRED_ACTIONS: SimpleAction[] = Array.from(
  new Set(
    (Object.keys(PIPELINES) as PipelineAction[]).flatMap((p) => expandedSteps(p)),
  ),
);

export function missingActions(rows: ActionRunRow[]): string[] {
  const latest = latestRunsByAction(rows);
  return REQUIRED_ACTIONS.filter((a) => {
    const run = latest.get(a);
    return !run || run.ok !== true;
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
  pipeline_0710_ultimo_ok: string | null;
  pwa_sync_ack_ultimo_ok: string | null;
  pwa_sync_ack_corrente: boolean;
  contendibili_fuori_perimetro: number;
  privati_fuori_perimetro: number;
}

/**
 * Ricevuta PWA reale: l'ack ok più recente deve essere concluso DOPO la fine
 * dell'ultima pipeline_0710 riuscita. Il timestamp di recompute non è un
 * surrogato accettabile.
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
  /** metrica -> valore (già appiattito, null = non verificabile). */
  metric: (group: string, name: string) => number;
  integrity: GateIntegrity;
  actionRuns: ActionRunRow[];
}

export function buildGateRequirements(input: GateEvaluationInput): GateRequirement[] {
  const { metric: g, integrity, mode, actionRuns } = input;
  const failing = failingActions(actionRuns);
  const missing = missingActions(actionRuns);

  const base: GateRequirement[] = [
    // I 4 portali devono essere freschi nella finestra.
    ...CIVIKO_PORTALS.map((p) => ({
      key: `portale_${p}_fresh`,
      passed: g("portals", `collect_items_${p}_fresh`) > 0,
    })),
    { key: "casa_processor_no_dead", passed: g("casa_pipeline", "queue_processor_dead") === 0 },
    // Promozione e classificazione correnti.
    { key: "promozione_corrente", passed: integrity.listings_freschi > 0 },
    { key: "mismatch_professionale_zero", passed: integrity.mismatch_professionale === 0 },
    {
      key: "classificazione_corrente",
      passed: g("classified_in_window", "signals_classified_updated") > 0,
    },
    { key: "recompute_corrente", passed: integrity.recompute_corrente === true },
    // Ricevuta PWA reale successiva all'ultima pipeline_0710 riuscita.
    {
      key: "pwa_sync_ack_dopo_pipeline_0710",
      passed: integrity.pwa_sync_ack_corrente === true &&
        ackAfterPipeline(integrity.pwa_sync_ack_ultimo_ok, integrity.pipeline_0710_ultimo_ok),
    },
    // Integrità perimetro Padova / 8 zone ufficiali.
    { key: "perimetro_contendibili_padova_8_zone", passed: integrity.contendibili_fuori_perimetro === 0 },
    { key: "perimetro_privati_padova_8_zone", passed: integrity.privati_fuori_perimetro === 0 },
    // Nessun fallimento nell'ultima esecuzione di ciascuna azione.
    { key: "nessun_fallimento_recente", passed: failing.length === 0 },
    { key: "tutti_gli_step_hanno_lavorato", passed: missing.length === 0 },
  ];

  if (mode === "routine") {
    // Notte ordinaria: zero novità è valido se tutti gli step hanno lavorato,
    // le fonti sono fresche e non ci sono errori. Nessuna categoria >0 imposta.
    return base;
  }

  // Collaudo iniziale: servono novità reali dimostrabili.
  return [
    ...base,
    {
      key: "initial_nuovi_import_reali",
      passed: g("imported", "listings_casa_imported_in_window") > 0 ||
        g("imported", "listings_imported_in_window") > 0,
    },
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
