// TrovaBandi — modulo puro di hardening runtime (nessuna I/O, nessun provider).
// Dominio isolato: non importa nulla di Civiko, shared auth o altre PWA.

/** Finestra di copertura richiesta dal gate dinamico. */
export const COVERAGE_WINDOW_HOURS = 26;
/** Oltre questa soglia un run RUNNING è considerato stale e va riconciliato. */
export const RUN_STALE_AFTER_MINUTES = 20;
/**
 * Un refresh regionale può anticipare una fonte regionale/nazionale soltanto
 * entro questa finestra rispetto alla fonte più arretrata: nessuna starvation.
 */
export const REGIONAL_BYPASS_MAX_MINUTES = 30;

export type RankableSource = {
  id: string;
  region: string | null;
  source_kind?: string | null;
  priority?: number | null;
  last_scanned_at?: string | null;
  next_scan_at: string | null;
  scan_interval_minutes?: number | null;
  fast_lane?: boolean | null;
  enabled?: boolean | null;
};

export type RunLike = {
  id?: string | null;
  source_id?: string | null;
  status?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  provider_usage?: Record<string, unknown> | null;
};

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

function isWholeNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Ordine equo: prima il next_scan_at più vecchio, poi chi non è mai stato
 * scansionato (o ha last_scanned_at più vecchio); priority è solo tie-break.
 * scan_interval_minutes non entra nell'ordinamento: la cadenza fast resta
 * garantita perché una fonte rapida torna dovuta prima delle altre.
 */
export function rankSources<T extends RankableSource>(sources: readonly T[]): T[] {
  return [...sources].sort((a, b) => {
    const an = time(a.next_scan_at) ?? Number.NEGATIVE_INFINITY;
    const bn = time(b.next_scan_at) ?? Number.NEGATIVE_INFINITY;
    if (an !== bn) return an - bn;
    const al = time(a.last_scanned_at);
    const bl = time(b.last_scanned_at);
    if (al === null && bl !== null) return -1;
    if (bl === null && al !== null) return 1;
    if (al !== null && bl !== null && al !== bl) return al - bl;
    const ap = Number(a.priority ?? 0);
    const bp = Number(b.priority ?? 0);
    if (ap !== bp) return bp - ap;
    return String(a.id).localeCompare(String(b.id));
  });
}

export type SelectionReason = "FAIR_OLDEST" | "REGIONAL_BYPASS" | "NO_SOURCE_DUE";

export type Selection<T> = {
  source: T | null;
  reason: SelectionReason;
  bypass_minutes: number;
};

/**
 * Selettore equo. Le fonti dovute sono ordinate con rankSources; un refresh
 * regionale può preferire una fonte della regione richiesta (o senza regione)
 * soltanto se il suo ritardo dista al massimo REGIONAL_BYPASS_MAX_MINUTES dalla
 * fonte più arretrata. Oltre quella finestra vince sempre la più arretrata.
 */
export function selectDueSource<T extends RankableSource>(
  sources: readonly T[],
  options: { nowMs: number; refreshRegion?: string | null } = { nowMs: Date.now() },
): Selection<T> {
  const now = options.nowMs;
  const due = rankSources(
    sources.filter((s) => s.enabled !== false && (time(s.next_scan_at) ?? now) <= now),
  );
  if (due.length === 0) return { source: null, reason: "NO_SOURCE_DUE", bypass_minutes: 0 };
  const head = due[0];
  const region = (options.refreshRegion ?? "").trim().toLowerCase();
  if (!region) return { source: head, reason: "FAIR_OLDEST", bypass_minutes: 0 };

  const headDue = time(head.next_scan_at) ?? now;

  const preferred = due.find((candidate) => {
    const candidateRegion = (candidate.region ?? "").trim().toLowerCase();
    if (candidateRegion !== region) return false;
    const delta = ((time(candidate.next_scan_at) ?? now) - headDue) / 60_000;
    return delta <= REGIONAL_BYPASS_MAX_MINUTES;
  });
  return preferred && preferred.id !== head.id
    ? {
        source: preferred,
        reason: "REGIONAL_BYPASS",
        bypass_minutes: Math.round(((time(preferred.next_scan_at) ?? now) - headDue) / 60_000),
      }
    : { source: head, reason: "FAIR_OLDEST", bypass_minutes: 0 };
}

/**
 * Uno scan reale a zero novità è valido solo se il run è SUCCEEDED, legato a
 * una fonte, con entrambi gli status provider OK e contatori pagine interi e
 * coerenti (anche 0: zero novità è un esito legittimo, non un guasto).
 */
export function isRealScan(run: RunLike | null | undefined): boolean {
  if (!run) return false;
  if (run.status !== "SUCCEEDED") return false;
  if (!run.source_id) return false;
  if (!run.finished_at) return false;
  const usage = run.provider_usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false;
  if (usage.firecrawl_search_status !== "OK") return false;
  if (usage.perplexity_search_status !== "OK") return false;
  const attempted = usage.pages_attempted;
  const scraped = usage.pages_scraped;
  if (!isWholeNonNegative(attempted) || !isWholeNonNegative(scraped)) return false;
  return scraped <= attempted;
}

export function staleRunCutoffIso(nowMs: number): string {
  return new Date(nowMs - RUN_STALE_AFTER_MINUTES * 60_000).toISOString();
}

export function coverageCutoffIso(nowMs: number): string {
  return new Date(nowMs - COVERAGE_WINDOW_HOURS * 60 * 60_000).toISOString();
}

export type GateInput = {
  nowMs: number;
  enabledSources: readonly RankableSource[];
  recentRuns: readonly RunLike[];
  staleRunningCount: number;
  verifiedActiveDistinct: number;
};

export type GateResult = {
  ok: boolean;
  checks: Record<string, boolean>;
  metrics: Record<string, number>;
};

/**
 * Gate dinamico: nessuna soglia commerciale inventata. Tutte le grandezze
 * derivano dal contenuto reale del registro fonti.
 */
export function evaluateGate(input: GateInput): GateResult {
  const cutoff = input.nowMs - COVERAGE_WINDOW_HOURS * 60 * 60_000;
  const enabled = input.enabledSources.filter((s) => s.enabled !== false);
  const enabledIds = new Set(enabled.map((s) => String(s.id)));
  const enabledKinds = new Set(
    enabled.map((s) => String(s.source_kind ?? "").trim()).filter(Boolean),
  );

  const coveredIds = new Set<string>();
  for (const run of input.recentRuns) {
    if (!isRealScan(run)) continue;
    const finished = time(run.finished_at);
    if (finished === null || finished < cutoff) continue;
    const id = String(run.source_id);
    if (enabledIds.has(id)) coveredIds.add(id);
  }
  const coveredKinds = new Set(
    enabled
      .filter((s) => coveredIds.has(String(s.id)))
      .map((s) => String(s.source_kind ?? "").trim())
      .filter(Boolean),
  );

  const metrics = {
    enabled_sources: enabled.length,
    covered_sources: coveredIds.size,
    enabled_source_kinds: enabledKinds.size,
    covered_source_kinds: coveredKinds.size,
    stale_running_runs: input.staleRunningCount,
    verified_active_distinct: input.verifiedActiveDistinct,
    coverage_window_hours: COVERAGE_WINDOW_HOURS,
  };
  const checks = {
    sources_registry_not_empty: enabled.length > 0 && enabledKinds.size > 0,
    all_enabled_sources_scanned: enabled.length > 0 && coveredIds.size === enabled.length,
    all_source_kinds_scanned: enabledKinds.size > 0 && coveredKinds.size === enabledKinds.size,
    no_stale_running_runs: input.staleRunningCount === 0,
    verified_catalogue_matches_kinds:
      enabledKinds.size > 0 && input.verifiedActiveDistinct >= enabledKinds.size,
  };
  return { ok: Object.values(checks).every(Boolean), checks, metrics };
}

/**
 * Contratto di risposta del collect.
 * P0: un run PARTIAL resta persistito con contatori/provider_usage/diagnostica,
 * ma la risposta HTTP deve essere fail-closed (ok:false, non-2xx) così che
 * gateway/orchestratore non marchino il job come riuscito.
 * SKIPPED/NO_SOURCE_DUE resta separato: nessun errore, ma neppure un segnale
 * di raccolta riuscita.
 */
export type CollectRunStatus = "SUCCEEDED" | "PARTIAL" | "SKIPPED";

export const COLLECTION_PARTIAL_CODE = "COLLECTION_PARTIAL";

export function collectResponseContract(runStatus: CollectRunStatus): {
  http: number;
  ok: boolean;
  error_code: string | null;
  collection_succeeded: boolean;
} {
  if (runStatus === "PARTIAL")
    return { http: 502, ok: false, error_code: COLLECTION_PARTIAL_CODE, collection_succeeded: false };
  if (runStatus === "SKIPPED")
    return { http: 200, ok: true, error_code: "NO_SOURCE_DUE", collection_succeeded: false };
  return { http: 200, ok: true, error_code: null, collection_succeeded: true };
}
