import { isAuctionRecord } from "../_shared/auctionExclusion.ts";

// civiko-orchestrator-dispatch
// Gateway additivo e isolato per l'orchestratore esterno (Replit / Civiko One).
// NON modifica alcuna funzione esistente: si limita a inoltrare, con
// allowlist hardcoded, verso Edge Functions già presenti nel Central Core.
//
// Auth: Authorization: Bearer <CIVIKO_ORCHESTRATOR_DISPATCH_SECRET>, fail-closed,
// confronto timing-safe. Il CENTRAL_CORE_JOB_SECRET è usato solo lato Core per
// autenticare le chiamate interne e non viene mai restituito né loggato.
//
// Nessun retry interno: la ripetizione è responsabilità dell'orchestratore.
// Guardie di costo, idempotenza e lock restano quelle delle funzioni destinazione.
//
// Pipeline: sequenziali e fail-closed (si fermano al primo step non ok).
// release_gate: conteggi reali dal database, nessuna stima.
// Nessun cron viene creato o attivato da questa funzione (enabled=false).

const DISPATCH_SECRET = Deno.env.get("CIVIKO_ORCHESTRATOR_DISPATCH_SECRET") ?? "";
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MAX_BODY_BYTES = 2048;
// Il client Replit chiude ogni azione a 180 s. Il gateway mantiene sempre
// almeno 15 s di margine per serializzare l'esito e fallire in modo leggibile.
const ORCHESTRATOR_TIMEOUT_MS = 180_000;
const PIPELINE_BUDGET_MS = 165_000;
const PIPELINE_RESERVE_MS = 12_000;
const AUDIT_TIMEOUT_MS = 2_000;
const IMAGE_BATCH_MAX_INVOCATIONS = 6;
// Prima di ogni micro-batch fotografico devono restare almeno 85 secondi per
// pairs atomico, recompute, extras, audit finale e serializzazione. Il loop
// può quindi eseguire 1..6 batch, ma non sottrae mai tempo ai downstream.
const IMAGE_BATCH_DOWNSTREAM_RESERVE_MS = 85_000;
const GATE_TIMEOUT_MS = 15_000;

import {
  evaluateRecomputeReconciliation,
  isReconcilableFailure,
  type ReconcileVerdict,
} from "./recomputeReconcile.ts";



type SimpleAction =
  | "apify_batch"
  | "apify_batch_capped"
  | "apify_immobiliare"
  | "apify_idealista"
  | "apify_subito"
  | "portal_casa"
  | "portal_casa_capped"
  | "collect_pending"
  | "contendibili_backfill"
  | "contendibili_recompute"
  | "contendibili_evidence"
  | "image_certify"
  | "image_pairs"
  | "contendibili_extras"
  | "private_leads"
  | "private_classify"
  | "private_price_snapshot"
  | "offmarket_discover"
  | "offmarket_scores"
  | "early_warning"
  | "radar_full"
  | "signals_classify";

type PipelineAction =
  | "pipeline_0510"
  | "pipeline_0510_capped"
  | "pipeline_0545"
  | "pipeline_0710";

type Action = "healthcheck" | "release_gate" | SimpleAction | PipelineAction;


interface Target {
  // Solo nome funzione + query hardcoded: nessun URL o path arbitrario dal client.
  fn: string;
  query?: string;
  rpc?: string;
  body: Record<string, unknown>;
  // Sempre inferiore al timeout dell'orchestratore esterno.
  timeoutMs: number;
}

// Allowlist hardcoded — anti-SSRF. Nessun input del client entra in URL o path.
const ALLOWED: Record<SimpleAction, Target> = {
  // Tre paid launch sequenziali dentro una Edge Civiko-only. Le guardie di
  // costo dei wrapper non corrono in race, mentre Casa/private sono
  // indipendenti e possono condividere lo stesso stage esterno.
  apify_batch: {
    fn: "civiko-padova-apify-launch-batch",
    body: {},
    timeoutMs: 145_000,
  },
  // Variante Civiko-only con hard cap 2.00 USD, 25 item per portale e una sola
  // search URL, verificata lato provider con abort automatico. Additiva:
  // apify_batch resta invariata.
  apify_batch_capped: {
    fn: "civiko-padova-apify-launch-batch-capped",
    body: {},
    timeoutMs: 145_000,
  },
  apify_immobiliare: { fn: "cron-apify-immobiliare-nightly", body: {}, timeoutMs: 45_000 },
  apify_idealista: { fn: "cron-apify-idealista-nightly", body: {}, timeoutMs: 45_000 },
  apify_subito: { fn: "cron-apify-subito-nightly", body: {}, timeoutMs: 45_000 },
  // Casa.it: esclusivamente pipeline multipagina esistente via scraping_queue.
  portal_casa: {
    fn: "enqueue-padova-portal-scrapes",
    body: { mode: "full", portals: ["casa.it"], max_pages: 5 },
    timeoutMs: 30_000,
  },
  // Stessa funzione e stesso contratto, ma limitata a 2 pagine per il run capped.
  portal_casa_capped: {
    fn: "enqueue-padova-portal-scrapes",
    body: { mode: "full", portals: ["casa.it"], max_pages: 2 },
    timeoutMs: 30_000,
  },

  collect_pending: {
    fn: "padova-apify-collect-pending",
    // Zero novità è valido soltanto quando i run provider sono terminati con
    // dataset realmente vuoto; la Edge distingue quel caso dagli zero anomali.
    body: {
      stale_minutes: 5,
      max_runs: 10,
      require_progress: false,
      require_candidates: true,
      require_terminal: true,
      required_portals: ["immobiliare", "idealista", "subito"],
    },
    timeoutMs: 40_000,
  },
  // Preparazione gratuita delle evidenze già presenti sui listing.
  contendibili_backfill: {
    fn: "padova_backfill_unit_evidence",
    rpc: "padova_backfill_unit_evidence",
    body: { p_batch: 5000, p_force: false },
    timeoutMs: 14_000,
  },
  // Recompute v4 autoritativo, fail-closed e transazionale.
  contendibili_recompute: {
    fn: "recompute_padova_listings_contendibili",
    rpc: "recompute_padova_listings_contendibili",
    body: {},
    timeoutMs: 18_000,
  },
  // Solo candidati in quarantena: cap 24, idempotenza giornaliera.
  contendibili_evidence: {
    fn: "civiko-contendibili-evidence-refresh",
    body: { limit: 24, trigger: "orchestrator" },
    timeoutMs: 14_000,
  },
  // Quattro annunci per giro: evita il limite memoria del worker. La funzione
  // sceglie prima i listing mai fingerprintati o meno recenti.
  image_certify: {
    fn: "civiko-contendibili-image-certify",
    body: {
      limit: 4,
      prefer_stale: true,
      fingerprints_only: true,
      trigger: "orchestrator",
    },
    timeoutMs: 12_000,
  },
  image_pairs: {
    fn: "civiko-contendibili-image-certify",
    body: { pairs_only: true, trigger: "orchestrator" },
    timeoutMs: 12_000,
  },
  // Popola ribassi/pressione e la tabella autonoma dei cambi agenzia.
  contendibili_extras: {
    fn: "recompute_padova_contendibili_extras",
    rpc: "recompute_padova_contendibili_extras",
    body: {},
    timeoutMs: 5_000,
  },
  private_leads: {
    fn: "civiko-private-leads-nightly",
    body: { trigger: "orchestrator" },
    timeoutMs: 45_000,
  },
  private_classify: {
    fn: "civiko-private-leads-classify",
    body: { since_hours: 36, trigger: "orchestrator" },
    timeoutMs: 14_000,
  },
  private_price_snapshot: {
    fn: "civiko-private-leads-price-snapshot",
    body: { trigger: "orchestrator" },
    timeoutMs: 14_000,
  },
  offmarket_discover: {
    fn: "cron-offmarket-padova-nightly",
    query: "job=discover-early-offmarket-signals",
    body: {},
    timeoutMs: 85_000,
  },
  offmarket_scores: {
    fn: "cron-offmarket-padova-nightly",
    query: "job=build-offmarket-opportunity-scores",
    body: {},
    timeoutMs: 30_000,
  },
  early_warning: {
    fn: "cron-offmarket-padova-nightly",
    query: "job=build-padova-early-warning",
    body: {},
    timeoutMs: 30_000,
  },
  radar_full: {
    fn: "cron-radar-padova-nightly",
    query: "mode=full",
    body: {},
    timeoutMs: 80_000,
  },
  signals_classify: {
    fn: "civiko-signals-classify",
    body: { dry_run: false },
    timeoutMs: 20_000,
  },
};

interface PipelineSpec {
  at: string;
  // Gli stage sono sequenziali; le azioni nello stesso stage sono indipendenti
  // e possono correre in parallelo. Ogni azione compare una sola volta.
  stages: SimpleAction[][];
}

// Pipeline fail-closed. Solo azioni dell'allowlist, nessun doppio lancio.
const PIPELINES: Record<PipelineAction, PipelineSpec> = {
  // 05:10 Europe/Rome — raccolta portali (Casa.it multipagina + Apify).
  pipeline_0510: {
    at: "05:10",
    stages: [["apify_batch", "portal_casa"]],
  },
  // 05:10 Europe/Rome — variante capped Civiko-only: stessa semantica di
  // raccolta, ma con hard cap di costo provider e volumi minimi.
  pipeline_0510_capped: {
    at: "05:10",
    stages: [["apify_batch_capped", "portal_casa_capped"]],
  },

  // 05:45 Europe/Rome — import, privati, evidenze e recompute autoritativo.
  pipeline_0545: {
    at: "05:45",
    stages: [
      ["collect_pending"],
      ["private_classify", "contendibili_backfill"],
      ["contendibili_evidence"],
      ["image_certify"],
      ["image_pairs"],
      ["private_price_snapshot", "contendibili_recompute"],
      ["contendibili_extras"],
    ],
  },
  // 07:10 Europe/Rome — radar, off-market e classificazione finale.
  pipeline_0710: {
    at: "07:10",
    stages: [
      ["radar_full", "offmarket_discover"],
      ["offmarket_scores", "early_warning"],
      ["signals_classify"],
    ],
  },
};

function pipelineSteps(pipeline: PipelineSpec): SimpleAction[] {
  return pipeline.stages.flat();
}

function pipelineMaxExecutions(pipeline: PipelineSpec): number {
  const steps = pipelineSteps(pipeline);
  return steps.length + (steps.includes("image_certify") ? IMAGE_BATCH_MAX_INVOCATIONS - 1 : 0);
}

/**
 * Deterministic upper bound used by tests and healthcheck.  It includes both
 * fail-closed audit writes for every action and the pipeline marker/finalizer.
 * Parallel actions contribute only the longest branch of their stage.
 */
export function pipelineWorstCaseMs(pipeline: PipelineSpec): number {
  const actionAudit = AUDIT_TIMEOUT_MS * 2;
  const pipelineAudit = AUDIT_TIMEOUT_MS * 2;
  const fixed = pipeline.stages.reduce((sum, stage) => {
    if (stage.includes("image_certify")) return sum;
    return sum + Math.max(...stage.map((action) => ALLOWED[action].timeoutMs + actionAudit));
  }, pipelineAudit);
  if (!pipelineSteps(pipeline).includes("image_certify")) return fixed;
  const fullImage = (ALLOWED.image_certify.timeoutMs + actionAudit) *
    IMAGE_BATCH_MAX_INVOCATIONS;
  const imageBudget = Math.max(0, PIPELINE_BUDGET_MS - PIPELINE_RESERVE_MS - fixed);
  return fixed + Math.min(fullImage, imageBudget);
}

for (const [name, spec] of Object.entries(PIPELINES)) {
  if (pipelineWorstCaseMs(spec) + PIPELINE_RESERVE_MS > PIPELINE_BUDGET_MS) {
    throw new Error(`invalid_pipeline_budget:${name}`);
  }
}

const SCHEDULE_TIMEZONE = "Europe/Rome";
// Nessun cron creato o attivato da questa funzione.
const CRON_ENABLED = false;

const ACTIONS = [
  "healthcheck",
  "release_gate",
  ...Object.keys(ALLOWED),
  ...Object.keys(PIPELINES),
] as const;

function scheduleContract() {
  return {
    timezone: SCHEDULE_TIMEZONE,
    enabled: CRON_ENABLED,
    pipelines: (Object.keys(PIPELINES) as PipelineAction[]).map((k) => ({
      action: k,
      at: PIPELINES[k].at,
      steps: pipelineSteps(PIPELINES[k]),
      stages: PIPELINES[k].stages,
      max_executions: pipelineMaxExecutions(PIPELINES[k]),
      enabled: CRON_ENABLED,
    })),
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Lunghezze diverse: confronto comunque a costo costante sul buffer più lungo.
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function json(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Campi osservabili ammessi nelle risposte al Replit orchestrator. La visita è
// ricorsiva ma l'allowlist impedisce di propagare URL, payload, token, raw data
// o messaggi arbitrari provenienti dai provider.
const SAFE_IDENTIFIER_KEYS = new Set([
  "job", "slug", "run_id", "pipeline_run_id", "dataset_id", "ingest_run_id",
  "queue_id",
  "job_id", "portal", "status", "mode", "run_mode", "async_start", "dry_run",
  "skipped", "skipped_reason", "processed", "scanned", "pending", "inserted",
  "created", "updated", "imported", "items", "items_count", "zero_novelty",
  "rows_out", "enqueued", "failed", "zombies_marked", "attempt_no",
  "candidates_found", "groups_considered", "groups_eligible", "dataset_size",
  "mapped", "mapped_total", "deduped", "padova_kept", "started_count",
  "unchanged", "existing", "rejected_out_of_scope", "skipped_out_of_scope",
  "municipality_missing", "out_of_scope_written",
  "active_non_padova_excluded", "padova_null_zone_excluded",
  "completed_count", "imports_count", "errors_count", "radar_signals_written",
  "required_portals_complete",
  "snapshot_inseriti", "snapshot_rows_today", "candidates_total", "snapshotted",
  "duplicates_ignored", "promossi_a_privato_stanco", "totale_staging", "upserted",
  "n_privato", "n_privato_stanco", "contendibili_before", "contendibili_after",
  "certificati", "quarantinati", "righe_senza_civico", "con_3_piu_agenzie",
  "multi_portale_before", "multi_portale_after", "urls_scannati", "urls_con_cambio",
  "cambi_scritti", "contendibili_marcati", "remaining", "match_version",
  "evidence_kind", "result_riprocessati", "image_refs_estratti",
  "attempted",
  "fingerprints_only",
  "queue_complete", "pairs_snapshot_complete", "source_rows_scanned",
  "immagini_decodificate", "fingerprint_validi", "fingerprint_scartati",
  "annunci_con_2_fingerprint", "coppie_con_foto_condivise", "coppie_certificanti",
  "coppie_scartate_stesso_annuncio", "budget_richieste_usate", "triggered_at",
  "completed_at", "duration_ms", "http_status",
  "gate_passed", "cron_activation_allowed", "metrics_available", "checked_at",
]);

const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;

function safeCode(value: unknown): string | null {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : null;
}

export function safeIdentifiers(raw: unknown, depth = 0): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || depth > 6) return {};
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const nestedEvidence: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(src)) {
    if (SAFE_IDENTIFIER_KEYS.has(key)) {
      if (typeof value === "number" || typeof value === "boolean") out[key] = value;
      else if (key === "enqueued" && Array.isArray(value)) {
        const sanitized = value.slice(0, 80).flatMap((item) => {
          if (typeof item === "string" && SAFE_CODE.test(item)) return [{ queue_id: item }];
          if (!item || typeof item !== "object" || Array.isArray(item)) return [];
          const safe = safeIdentifiers(item, depth + 1);
          return Object.keys(safe).length > 0 ? [safe] : [];
        });
        out.enqueued_count = value.length;
        if (sanitized.length) out.enqueued = sanitized;
      }
      else {
        const code = safeCode(value);
        if (code) out[key] = code;
      }
      continue;
    }
    // Sottoalberi noti: conserviamo esclusivamente gli stessi campi allowlist.
    if (["result", "enrichment", "promoted", "sampling", "subito"].includes(key)) {
      const nested = safeIdentifiers(value, depth + 1);
      if (Object.keys(nested).length) out[key] = nested;
    } else if (["launched", "started", "results"].includes(key) && Array.isArray(value)) {
      out[`${key}_count`] = value.length;
      const sanitized = value.slice(0, 20)
        .map((item) => safeIdentifiers(item, depth + 1))
        .filter((item) => Object.keys(item).length > 0);
      if (sanitized.length) out[key] = sanitized;
    } else if (key === "errors" && Array.isArray(value)) {
      out.errors_count = value.length;
    } else if (value && typeof value === "object") {
      // I nomi di contenitore provider non sono trusted e non vengono copiati.
      // Conserviamo soltanto i discendenti allowlist sotto una chiave neutra,
      // così run_id/dataset_id/queue_id restano correlabili anche se il wrapper
      // reale aggiunge un livello non previsto.
      const candidates = Array.isArray(value) ? value.slice(0, 80) : [value];
      for (const candidate of candidates) {
        const safe = safeIdentifiers(candidate, depth + 1);
        if (Object.keys(safe).length > 0) nestedEvidence.push(safe);
      }
    }
  }
  if (nestedEvidence.length) out.evidence = nestedEvidence;
  return out;
}

function hasNestedIdentifier(raw: unknown, keys: readonly string[], depth = 0): boolean {
  if (depth > 6 || raw == null) return false;
  if (Array.isArray(raw)) {
    return raw.slice(0, 100).some((item) => hasNestedIdentifier(item, keys, depth + 1));
  }
  if (typeof raw !== "object") return false;
  const src = raw as Record<string, unknown>;
  if (keys.some((key) => typeof src[key] === "string" && SAFE_CODE.test(src[key] as string))) {
    return true;
  }
  return Object.values(src).some((value) => hasNestedIdentifier(value, keys, depth + 1));
}

/**
 * Richiede che tutti gli identificatori appartengano allo stesso envelope.
 * Evita di certificare una risposta dove, per esempio, run_id e dataset_id
 * provengono da due figli diversi e quindi non sono correlabili.
 */
function hasNestedIdentifierBundle(
  raw: unknown,
  keys: readonly string[],
  depth = 0,
): boolean {
  if (depth > 6 || raw == null) return false;
  if (Array.isArray(raw)) {
    return raw.slice(0, 100).some((item) =>
      hasNestedIdentifierBundle(item, keys, depth + 1)
    );
  }
  if (typeof raw !== "object") return false;
  const src = raw as Record<string, unknown>;
  if (keys.every((key) => typeof src[key] === "string" && SAFE_CODE.test(src[key] as string))) {
    return true;
  }
  return Object.values(src).some((value) =>
    hasNestedIdentifierBundle(value, keys, depth + 1)
  );
}

export function semanticFailure(raw: unknown, action?: SimpleAction, depth = 0): string | null {
  if (depth > 6) return "downstream_payload_too_deep";
  if (Array.isArray(raw)) {
    if (depth === 0) return "invalid_downstream_payload";
    for (const item of raw.slice(0, 100)) {
      if (item && typeof item === "object") {
        const nestedFailure = semanticFailure(item, undefined, depth + 1);
        if (nestedFailure) return nestedFailure;
      }
    }
    return null;
  }
  if (!raw || typeof raw !== "object") return "invalid_downstream_payload";
  const src = raw as Record<string, unknown>;
  if (depth === 0 && Object.keys(src).length === 0) return "empty_downstream_payload";
  if (src.ok === false) return safeCode(src.code) ?? safeCode(src.error) ?? "downstream_ok_false";
  if (src.success === false) return "downstream_success_false";
  if (typeof src.status === "string" && /^(?:failed|failure|error|dead|aborted|timed[_ -]?out)$/i.test(src.status.trim())) {
    return "downstream_status_failed";
  }
  if (src.skipped === true || (typeof src.skipped === "string" && src.skipped.trim() !== "")) {
    return safeCode(src.reason) ?? safeCode(src.skipped_reason) ?? safeCode(src.skipped) ??
      "downstream_skipped";
  }
  if (
    (Array.isArray(src.errors) && src.errors.length > 0) ||
    (typeof src.errors === "number" && src.errors > 0) ||
    (src.errors && typeof src.errors === "object" && !Array.isArray(src.errors) &&
      Object.keys(src.errors as Record<string, unknown>).length > 0)
  ) return "downstream_errors";
  if (typeof src.errors_count === "number" && src.errors_count > 0) return "downstream_errors";
  if (src.error) return safeCode(src.error) ?? "downstream_error";
  // Fail closed on every nested provider envelope, not only on currently
  // known wrapper keys. This also catches runAll/result arrays that return an
  // outer HTTP 200 while one inner action reports ok:false/error.
  for (const nested of Object.values(src)) {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedFailure = semanticFailure(nested, undefined, depth + 1);
      if (nestedFailure) return nestedFailure;
    } else if (Array.isArray(nested)) {
      const nestedFailure = semanticFailure(nested, undefined, depth + 1);
      if (nestedFailure) return nestedFailure;
    }
  }
  if (depth === 0 && (action === "portal_casa" || action === "portal_casa_capped") &&
      (!Array.isArray(src.enqueued) || src.enqueued.length === 0 ||
        !hasNestedIdentifier(src.enqueued, ["queue_id"]))) {
    return "unexpected_zero_enqueued";
  }
  if (depth === 0 && (action === "apify_batch" || action === "apify_batch_capped")) {
    const launched = Array.isArray(src.launched) ? src.launched : [];
    const families = new Set(launched.flatMap((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return [];
      const record = row as Record<string, unknown>;
      return typeof record.portal === "string" &&
          hasNestedIdentifierBundle(record, ["run_id", "dataset_id"])
        ? [record.portal]
        : [];
    }));
    if (Number(src.started_count ?? 0) < 4 || Number(src.errors_count ?? -1) !== 0 ||
        src.required_portals_complete !== true ||
        !["immobiliare", "idealista", "subito", "private_leads"].every((portal) =>
          families.has(portal)
        )) {
      return "apify_batch_incomplete";
    }
    // La variante capped deve provare cap dichiarato, stima e verifica
    // provider-side: senza echo completo l'esito non è certificabile.
    if (action === "apify_batch_capped") {
      const capUsd = Number(src.cost_cap_usd ?? NaN);
      const estUsd = Number(src.estimated_cost_usd ?? NaN);
      const observedUsd = Number(src.observed_cost_usd ?? NaN);
      if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > 2 ||
          !Number.isFinite(estUsd) || estUsd > capUsd ||
          !Number.isFinite(observedUsd) || observedUsd > capUsd ||
          src.cost_cap_respected !== true || src.provider_cap_verified !== true ||
          !src.caps_applied || typeof src.caps_applied !== "object" ||
          !Array.isArray(src.per_portal_estimates) || src.per_portal_estimates.length < 4) {
        return "capped_cost_cap_unverified";
      }
    }
  }

  if (depth === 0 && ["apify_immobiliare", "apify_idealista", "apify_subito"].includes(
      action ?? "",
    ) && (Number(src.started_count ?? 0) <= 0 ||
      !hasNestedIdentifierBundle(src, ["run_id", "dataset_id"]))) {
    return "unexpected_zero_provider_runs";
  }
  if (depth === 0 && action === "collect_pending") {
    const worked = Number(src.scanned ?? 0) > 0 &&
      Number(src.completed_count ?? 0) >= 3 &&
      src.required_portals_complete === true &&
      Number(src.errors_count ?? -1) === 0;
    const progressOrLegitimateZero = Number(src.imports_count ?? 0) > 0 ||
      src.zero_novelty === true;
    const results = Array.isArray(src.results) ? src.results : [];
    const terminalProviderItems = results.length >= 3 && results.every((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const row = item as Record<string, unknown>;
      const itemCount = Number(row.items ?? -1);
      return row.status === "SUCCEEDED" && itemCount >= 0 &&
        (itemCount > 0 || row.zero_novelty === true || src.zero_novelty === true) &&
        hasNestedIdentifierBundle(row, ["run_id", "dataset_id"]);
    });
    if (!worked || !progressOrLegitimateZero || !terminalProviderItems ||
        Number(src.out_of_scope_written ?? -1) !== 0) {
      return "collect_pending_no_current_evidence";
    }
  }
  if (depth === 0 && action === "private_leads" &&
      (Number(src.started_count ?? 0) <= 0 || Number(src.errors_count ?? -1) !== 0 ||
        !hasNestedIdentifierBundle(src, ["run_id", "dataset_id"]))) {
    return "private_leads_launch_incomplete";
  }
  if (depth === 0 && action === "private_classify") {
    const scanned = Number(src.totale_staging ?? src.scanned ?? 0);
    const upserted = Number(src.upserted ?? 0);
    const zeroOk = src.zero_novelty === true && scanned > 0 &&
      Number(src.unchanged ?? src.deduped ?? 0) >= scanned;
    if (scanned <= 0 || (upserted <= 0 && !zeroOk)) return "private_classification_no_current_write";
  }
  if (depth === 0 && action === "private_price_snapshot") {
    const candidates = Number(src.candidates_total ?? 0);
    const accounted = Number(src.snapshotted ?? 0) + Number(src.duplicates_ignored ?? 0);
    if (candidates <= 0 || accounted <= 0 || Number(src.snapshot_rows_today ?? 0) <= 0) {
      return "private_snapshot_incomplete";
    }
  }
  if (depth === 0 && action === "image_certify") {
    const processed = Number(src.processed ?? src.attempted ?? 0);
    if (src.fingerprints_only !== true || processed < 0 ||
        Number(src.remaining ?? -1) < 0) return "image_snapshot_incomplete";
  }
  if (depth === 0 && action === "image_pairs" && src.pairs_snapshot_complete !== true) {
    return "image_pairs_snapshot_incomplete";
  }
  if (depth === 0 && action === "contendibili_recompute") {
    if (typeof src.match_version !== "string" || !src.match_version.startsWith("v4-") ||
        !Number.isFinite(Number(src.contendibili_after))) {
      return "recompute_contract_incomplete";
    }
  }
  return null;
}

const POSTGREST_REASON_MAX_LENGTH = 240;
const SAFE_POSTGREST_CODE = /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/;
const UNSAFE_POSTGREST_MESSAGE =
  /(?:https?:\/\/|www\.|\b(?:authorization|bearer|apikey|api[_-]?key|token|secret|password|service[_-]?role)\b|[{}\[\]]|[A-Za-z0-9_-]{40,})/i;

// Propaga per gli RPC 400 solo SQLSTATE/PGRST code e un eventuale messaggio
// breve privo di URL, credenziali, JSON o token. `details` e `hint` ignorati.
function safePostgrestReason(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const code = typeof src.code === "string" && SAFE_POSTGREST_CODE.test(src.code)
    ? src.code
    : null;
  if (!code) return null;
  const message = typeof src.message === "string"
    ? src.message
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    : "";
  if (!message || UNSAFE_POSTGREST_MESSAGE.test(message)) return code;
  return `${code}: ${message.slice(0, POSTGREST_REASON_MAX_LENGTH)}`;
}

interface StepResult {
  action: SimpleAction;
  target: string;
  ok: boolean;
  status: number;
  reason: string | null;
  result: Record<string, unknown>;
}

interface ActionContext {
  pipelineRunId: string;
  pipelineAction: string;
  attemptNo: number;
}

interface ActionAuditInput extends ActionContext {
  action: string;
  target: string;
  result: StepResult;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

async function persistActionAudit(input: ActionAuditInput, upsert = false): Promise<boolean> {
  if (!SERVICE_KEY || !SUPABASE_URL) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUDIT_TIMEOUT_MS);
  try {
    const conflict = "pipeline_run_id,action,attempt_no";
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/civiko_orchestrator_action_runs${
        upsert ? `?on_conflict=${conflict}` : ""
      }`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: upsert
          ? "resolution=merge-duplicates,return=minimal"
          : "return=minimal",
      },
      body: JSON.stringify({
        pipeline_run_id: input.pipelineRunId,
        run_id: input.pipelineRunId,
        pipeline_action: input.pipelineAction,
        pipeline: input.pipelineAction === "standalone" ? null : input.pipelineAction,
        action: input.action,
        attempt_no: input.attemptNo,
        target: input.target,
        ok: input.result.ok,
        http_status: input.result.status,
        status: input.result.status,
        // `reason_code` non esiste nello schema reale: PostgREST rispondeva 400
        // (PGRST204) facendo fallire l'audit e quindi il release_gate.
        error_code: safeCode(input.result.reason),
        result: input.result.result ?? {},
        counters: input.result.result ?? {},
        started_at: input.startedAt,
        finished_at: input.finishedAt,
        duration_ms: input.durationMs,
      }),
      signal: controller.signal,
      },
    );
    if (!res.ok) {
      console.error(
        `[civiko-orchestrator-dispatch] audit_failed action=${input.action} status=${res.status}`,
      );
    }
    return res.ok;
  } catch {
    console.error(`[civiko-orchestrator-dispatch] audit_failed action=${input.action}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function auditStep(
  ctx: ActionContext,
  result: StepResult,
  startedAt: string,
  startedMs: number,
): Promise<StepResult> {
  const finishedAt = new Date().toISOString();
  const auditOk = await persistActionAudit({
    ...ctx,
    action: result.action,
    target: result.target,
    result,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.now() - startedMs),
  }, true);
  if (auditOk || !result.ok) return result;
  return { ...result, ok: false, status: 502, reason: "audit_write_failed" };
}

async function persistPipelineAudit(
  pipelineRunId: string,
  pipelineAction: PipelineAction,
  ok: boolean,
  status: number,
  reason: string | null,
  startedAt: string,
  startedMs: number,
  executed: number,
  planned: number,
): Promise<boolean> {
  const placeholder: StepResult = {
    action: "signals_classify",
    target: "pipeline",
    ok,
    status,
    reason,
    result: { pipeline_run_id: pipelineRunId, completed_count: executed, pending: planned - executed },
  };
  return persistActionAudit({
    pipelineRunId,
    pipelineAction,
    attemptNo: 1,
    action: "__pipeline__",
    target: "pipeline",
    result: placeholder,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedMs),
  }, true);
}

/**
 * Legge l'evidenza DB canonica del recompute e decide fail-closed.
 * Nessuna scrittura: solo letture su padova_recompute_last_result e
 * padova_contendibili (la stessa evidenza usata dal release gate).
 */
async function reconcileRecompute(startedAt: string): Promise<ReconcileVerdict> {
  const lastResultRows = await realRows(
    `padova_recompute_last_result?select=created_at,result&order=created_at.desc&limit=5`,
  );
  const updatedCount = await realCount(
    `padova_contendibili?select=id&commercial_zone_slug=in.(${CIVIKO_SCOPE_SLUGS.join(",")})&n_agenzie=gte.2&updated_at=gte.${startedAt}`,
  );
  const newest = await realRows(
    `padova_contendibili?select=updated_at&order=updated_at.desc&limit=1`,
  );
  return evaluateRecomputeReconciliation({
    startedAt,
    lastResultRows: lastResultRows === null
      ? null
      : lastResultRows.map((row) => ({
        created_at: String(row.created_at ?? ""),
        result: row.result,
      })),
    contendibiliUpdatedCount: updatedCount,
    contendibiliMaxUpdatedAt: newest?.[0]?.updated_at
      ? String(newest[0].updated_at)
      : null,
  });
}



async function runAction(
  action: SimpleAction,
  context: ActionContext,
  maxTimeoutMs?: number,
): Promise<StepResult> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const target = ALLOWED[action];
  const isRpc = typeof target.rpc === "string";
  const targetName = isRpc ? `rpc/${target.rpc}` : target.fn;
  const url = isRpc
    ? `${SUPABASE_URL}/rest/v1/rpc/${target.rpc}`
    : `${SUPABASE_URL}/functions/v1/${target.fn}${target.query ? `?${target.query}` : ""}`;

  // Persist a failed/in-progress marker before the downstream call. The final
  // audit upserts this identity. If the worker is killed or finalization
  // cannot be persisted, the exact-run gate retains a non-success row.
  const startAuditOk = await persistActionAudit({
    ...context,
    action,
    target: targetName,
    result: {
      action,
      target: targetName,
      ok: false,
      status: 102,
      reason: "in_progress",
      result: {},
    },
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
  }, true);
  if (!startAuditOk) {
    return {
      action,
      target: targetName,
      ok: false,
      status: 502,
      reason: "audit_start_failed",
      result: {},
    };
  }

  if ((isRpc && !SERVICE_KEY) || (!isRpc && !JOB_SECRET)) {
    return auditStep(context, {
      action,
      target: targetName,
      ok: false,
      status: 500,
      reason: isRpc ? "service_key_missing" : "job_secret_missing",
      result: {},
    }, startedAt, startedMs);
  }

  const timeoutMs = Math.max(
    1_000,
    Math.min(
      target.timeoutMs,
      maxTimeoutMs ?? target.timeoutMs,
      ORCHESTRATOR_TIMEOUT_MS - 15_000,
    ),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = isRpc
      ? {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      }
      : {
        "Content-Type": "application/json",
        "x-job-secret": JOB_SECRET,
      };
    // Nessun retry interno: gestito dall'orchestratore.
    const requestBody = action === "image_certify"
      ? { ...target.body, pipeline_run_id: context.pipelineRunId }
      : target.body;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const text = await res.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    const obj = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
    const semanticError = res.ok ? semanticFailure(payload, action) : null;
    const downstreamReason = obj
      ? safeCode(obj.reason) ?? safeCode(obj.code) ?? safeCode(obj.error)
      : null;
    const reason = isRpc && res.status === 400
      ? safePostgrestReason(payload) ?? "postgrest_bad_request"
      : semanticError ?? downstreamReason ?? (res.ok ? null : `downstream_http_${res.status}`);

    console.log(
      `[civiko-orchestrator-dispatch] action=${action} target=${targetName} status=${res.status}`,
    );

    return auditStep(context, {
      action,
      target: targetName,
      ok: res.ok && semanticError === null,
      status: res.status,
      reason,
      result: safeIdentifiers(payload),
    }, startedAt, startedMs);
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    console.error(
      `[civiko-orchestrator-dispatch] action=${action} failure=${aborted ? "timeout" : "network_error"}`,
    );
    const status = aborted ? 504 : 502;
    const reason = aborted ? "timeout" : "network_error";
    // Il recompute v4 dura ~95 s e prosegue nel database anche dopo l'abort
    // dell'azione: riconcilia SOLO con evidenza DB fresca, coerente e senza
    // errori. Nessun audit fittizio, nessun allentamento del gate.
    if (action === "contendibili_recompute" && isReconcilableFailure(status, reason)) {
      const verdict = await reconcileRecompute(startedAt);
      if (verdict.reconciled) {
        console.log(
          `[civiko-orchestrator-dispatch] action=${action} reconciled_after_timeout source=${verdict.evidence_source}`,
        );
        return auditStep(context, {
          action,
          target: targetName,
          ok: true,
          status: 200,
          reason: null,
          result: {
            ...verdict.result,
            evidence: verdict.evidence,
            evidence_source: verdict.evidence_source,
            evidence_observed_at: verdict.observed_at,
            reconciled_after_timeout: true,
            original_status: status,
            original_reason: reason,
          },
        }, startedAt, startedMs);
      }
      const failureReason = (verdict as { reason?: string }).reason ?? "reconcile_failed";
      return auditStep(context, {
        action,
        target: targetName,
        ok: false,
        status,
        reason: failureReason,
        result: { reconciled_after_timeout: false, original_reason: reason },
      }, startedAt, startedMs);
    }
    return auditStep(context, {
      action,
      target: targetName,
      ok: false,
      status,
      reason,
      result: {},
    }, startedAt, startedMs);
  } finally {
    clearTimeout(timer);
  }
}

// Conteggio reale via PostgREST (count=exact). Ritorna null se non verificabile:
// il gate resta fail-closed.
async function realCount(pathAndQuery: string): Promise<number | null> {
  if (!SERVICE_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
      method: "HEAD",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "count=exact",
        Range: "0-0",
      },
      signal: controller.signal,
    });
    if (!res.ok && res.status !== 206) return null;
    const cr = res.headers.get("content-range") ?? "";
    const total = cr.split("/")[1];
    const n = Number(total);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function realRows(pathAndQuery: string): Promise<Record<string, unknown>[] | null> {
  if (!SERVICE_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const payload = await res.json().catch(() => null);
    return Array.isArray(payload)
      ? payload.filter((row) => row && typeof row === "object" && !Array.isArray(row))
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const GATE_WINDOW_HOURS = 4;
const CIVIKO_SCOPE_SLUGS = [
  "centro-storico",
  "nord-arcella",
  "est-brenta",
  "est-forcellini-camin",
  "sud-est-sant-osvaldo",
  "sud-voltabarozzo-guizza",
  "sud-ovest-mandria",
  "ovest-chiesanuova-brentelle",
] as const;

const RIBASSI_RPC_CONCURRENCY = 2;

async function verifiedPriceDropsCount(): Promise<number | null> {
  if (!SERVICE_KEY) return null;
  const callSlug = async (slug: string): Promise<number | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GATE_TIMEOUT_MS);
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/rpc/get_padova_verified_price_drops_by_zone_v2`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
          },
          body: JSON.stringify({
            p_commercial_zone_slug: slug,
            p_quartiere: null,
            p_limit: 20,
            p_min_drop_pct: 5,
            p_max_age_days: 14,
          }),
          signal: controller.signal,
        },
      );
      if (!res.ok) return null;
      const payload = await res.json().catch(() => null);
      if (!Array.isArray(payload)) return null;
      return payload.filter((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const row = value as Record<string, unknown>;
        const current = Number(row.current_price_eur);
        const initial = Number(row.initial_price_eur);
        const drop = Number(row.total_drop_pct);
        return row.commercial_zone_slug === slug &&
          typeof row.url === "string" &&
          row.url.startsWith("https://") &&
          current >= 10_000 &&
          current <= 5_000_000 &&
          initial > current &&
          drop >= 5 &&
          !isAuctionRecord(row);
      }).length;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // Batching deterministico: max 2 RPC contemporanee, ordine preservato.
  const counts: Array<number | null> = [];
  for (let i = 0; i < CIVIKO_SCOPE_SLUGS.length; i += RIBASSI_RPC_CONCURRENCY) {
    const batch = CIVIKO_SCOPE_SLUGS.slice(i, i + RIBASSI_RPC_CONCURRENCY);
    const batchCounts = await Promise.all(batch.map((slug) => callSlug(slug)));
    for (const count of batchCounts) counts.push(count);
  }
  return counts.some((count) => count === null)
    ? null
    : counts.reduce((sum, count) => sum + (count ?? 0), 0);
}


// Metriche reali, raggruppate. Nessun valore dedotto: se una query non è
// verificabile il valore resta null e il gate è fail-closed.
interface GateSpec {
  group: "runs" | "fresh" | "derived" | "categories" | "scope";
  metric: string;
  q: string;
}

function gateSpecs(since: string): GateSpec[] {
  const casaCtx = `processor_context->>portal=eq.casa.it`;
  const scope = CIVIKO_SCOPE_SLUGS.join(",");
  const portalSpecs: Array<{ key: string; collect: string; listing: string }> = [
    { key: "immobiliare", collect: "immobiliare", listing: "immobiliare" },
    { key: "idealista", collect: "idealista", listing: "idealista" },
    { key: "subito", collect: "subito", listing: "subito" },
    { key: "casa", collect: "casa,casa.it", listing: "casa" },
  ];
  const fresh: GateSpec[] = portalSpecs.flatMap((portal) => [
    {
      group: "fresh",
      metric: `collect_${portal.key}_current`,
      q: `padova_collect_v2_items?select=id&portal=${portal.key === "casa" ? "in.(casa,casa.it)" : `eq.${portal.collect}`}&citta=ilike.Padova&updated_at=gte.${since}`,
    },
    {
      group: "fresh",
      metric: `listings_${portal.key}_current`,
      q:
        `padova_listings?select=id&fonte=eq.${portal.listing}&comune=eq.Padova&commercial_zone_slug=in.(${scope})&last_seen_at=gte.${since}`,
    },
    {
      // Il collaudo iniziale richiede righe realmente nuove, non il solo
      // aggiornamento di record storici. Nelle routine la metrica resta
      // osservabile ma non viene imposta: sono ammessi aggiornamenti senza
      // novita' nette quando tutta la catena corrente e' certificata.
      group: "fresh",
      metric: `collect_${portal.key}_created_current`,
      q: `padova_collect_v2_items?select=id&portal=${portal.key === "casa" ? "in.(casa,casa.it)" : `eq.${portal.collect}`}&citta=ilike.Padova&created_at=gte.${since}`,
    },
  ]);
  return [
    // Run provider correnti: tre Apify + Casa/Firecrawl.
    {
      group: "runs",
      metric: "apify_immobiliare_succeeded",
      q:
        `padova_apify_runs?select=id&portal=like.immobiliare_collect_*&status=eq.SUCCEEDED&finished_at=gte.${since}`,
    },
    {
      group: "runs",
      metric: "apify_idealista_succeeded",
      q:
        `padova_apify_runs?select=id&portal=like.idealista_collect_*&status=eq.SUCCEEDED&finished_at=gte.${since}`,
    },
    {
      group: "runs",
      metric: "apify_subito_succeeded",
      q:
        `padova_apify_runs?select=id&portal=eq.subito_collect&status=eq.SUCCEEDED&finished_at=gte.${since}`,
    },
    {
      group: "runs",
      metric: "casa_provider_succeeded",
      q: `scraping_queue?select=id&${casaCtx}&created_at=gte.${since}&status=eq.succeeded`,
    },
    {
      group: "runs",
      metric: "casa_processor_succeeded",
      q: `scraping_queue?select=id&${casaCtx}&created_at=gte.${since}&processing_status=eq.succeeded`,
    },
    {
      group: "runs",
      metric: "casa_processor_dead",
      q: `scraping_queue?select=id&${casaCtx}&created_at=gte.${since}&processing_status=eq.dead`,
    },
    ...fresh,
    // Audit autoritativo del recompute: resta valido anche con zero gruppi.
    {
      group: "derived",
      metric: "contendibili_recomputed_current",
      q: `padova_recompute_last_result?select=id&created_at=gte.${since}&result->>ok=eq.true`,
    },
    {
      group: "derived",
      metric: "fingerprints_current",
      q: `civiko_listing_image_fingerprints?select=listing_id&updated_at=gte.${since}`,
    },
    {
      group: "derived",
      metric: "photo_pairs_current",
      q: `civiko_listing_photo_pair_evidence?select=listing_a&shared_photos=gte.2&updated_at=gte.${since}`,
    },
    {
      group: "derived",
      metric: "private_snapshot_current",
      q: `padova_listings_price_history?select=id&created_at=gte.${since}`,
    },
    {
      group: "derived",
      metric: "price_observations_current",
      q: `listing_price_snapshots?select=id&municipality=eq.Padova&captured_at=gte.${since}`,
    },
    {
      group: "derived",
      metric: "signals_classified_current",
      q: `civiko_signals_classified?select=signal_id&updated_at=gte.${since}`,
    },
    // Stato PWA corrente. In esercizio può essere legittimamente zero: il gate
    // verifica audit, coerenza e perimetro; il collaudo iniziale usa requisiti
    // aggiuntivi espliciti.
    {
      group: "categories",
      metric: "contendibili_all",
      q: `padova_contendibili?select=id`,
    },
    {
      group: "categories",
      metric: "contendibili_scope",
      q:
        `padova_contendibili?select=id&commercial_zone_slug=in.(${scope})&n_agenzie=gte.2`,
    },
    {
      group: "categories",
      metric: "contendibili_multi_agenzia",
      q:
        `padova_contendibili?select=id&commercial_zone_slug=in.(${scope})&n_agenzie=gte.3`,
    },
    {
      group: "categories",
      metric: "cambi_agenzia",
      q: `padova_cambi_agenzia?select=id&is_active=eq.true&commercial_zone_slug=in.(${scope})`,
    },
    {
      group: "categories",
      metric: "privati_scope",
      q:
        `padova_listings?select=id&comune=eq.Padova&tipo_lead=in.(PRIVATO,PRIVATO_STANCO,privato,privato_stanco)&expired_at=is.null&commercial_zone_slug=in.(${scope})`,
    },
    {
      group: "categories",
      metric: "offmarket_verified",
      q:
        `early_offmarket_signal_candidates_by_zone_v?select=id&commercial_zone_slug=in.(${scope})&comune=eq.Padova&privacy_safe=eq.true&needs_review=eq.false&import_recommendation=eq.importable&confidence_score=gte.0.7&status=in.(approved,promoted,importable)&source_url=like.https://*`,
    },
    {
      group: "categories",
      metric: "radar",
      q: `radar_signals?select=id&municipality=eq.Padova&is_active=eq.true`,
    },
    {
      group: "scope",
      metric: "active_comune_null",
      q: `padova_listings?select=id&expired_at=is.null&comune=is.null`,
    },
    {
      group: "scope",
      metric: "new_active_non_padova",
      // padova_listings non ha created_at: la colonna reale di ingresso è
      // imported_at. Con created_at PostgREST rispondeva 400 e il gate restava
      // permanentemente metrics_available=false.
      q: `padova_listings?select=id&expired_at=is.null&comune=not.ilike.Padova&imported_at=gte.${since}`,
    },
    {
      group: "scope",
      metric: "new_padova_null_zone",
      q: `padova_listings?select=id&expired_at=is.null&comune=ilike.Padova&commercial_zone_slug=is.null&imported_at=gte.${since}`,
    },

    {
      group: "scope",
      metric: "invalid_assigned_zone",
      q: `padova_listings?select=id&expired_at=is.null&comune=eq.Padova&commercial_zone_slug=not.is.null&commercial_zone_slug=not.in.(${scope})`,
    },
    {
      group: "scope",
      metric: "professional_private_mismatch",
      q: `civiko_padova_tipo_lead_mismatch_v?select=id`,
    },
  ];
}

async function releaseGate(
  initialValidation: boolean,
  gateRunId: string,
  gateStartedAtMs: number,
) {
  const gateCheckedAtMs = Date.now();
  const since = new Date(gateCheckedAtMs - GATE_WINDOW_HOURS * 60 * 60_000).toISOString();
  const specs = gateSpecs(since);

  const metrics: Record<string, Record<string, number | null>> = {
    runs: {},
    fresh: {},
    derived: {},
    categories: {},
    scope: {},
  };
  const failedQueries: string[] = [];
  // Civiko-specific: l'assenza di un audit cron prerequisito NON e' un errore
  // di query. Va distinta da un fallimento PostgREST, altrimenti il gate
  // ritorna 502 metrics_unavailable in modo permanente quando i cron non sono
  // ancora stati eseguiti. Il gate resta comunque fail-closed: senza queste
  // prove i requirement corrispondenti non passano.
  const missingPrerequisites: string[] = [];

  // Batching limitato: il gate resta sotto il budget Replit senza una raffica
  // illimitata di HEAD count verso PostgREST.
  for (let i = 0; i < specs.length; i += 5) {
    const batch = specs.slice(i, i + 5);
    const counts = await Promise.all(batch.map((spec) => realCount(spec.q)));
    for (let j = 0; j < batch.length; j++) {
      const spec = batch[j];
      const count = counts[j];
      metrics[spec.group][spec.metric] = count;
      if (count === null) failedQueries.push(spec.metric);
    }
  }
  const ribassiCount = await verifiedPriceDropsCount();
  metrics.categories.contendibili_ribassi = ribassiCount;
  if (ribassiCount === null) failedQueries.push("contendibili_ribassi");

  const auditRows = await realRows(
    `civiko_orchestrator_action_runs?select=id,pipeline_run_id,pipeline_action,action,attempt_no,ok,http_status,result,started_at,finished_at,created_at&started_at=gte.${since}&order=started_at.desc,created_at.desc,id.desc&limit=120`,
  );
  if (auditRows === null) failedQueries.push("orchestrator_action_audit");

  // Evidenza DB dei run provider e della coda Casa nella stessa finestra.
  // Queste righe vengono correlate piu' sotto agli identificativi restituiti
  // dalle azioni dell'esatto ultimo pipeline_0510: un successo storico nella
  // finestra non puo' certificare il run corrente.
  const providerRunRows = await realRows(
    `padova_apify_runs?select=run_id,portal,status,items_count,imported,started_at,finished_at&started_at=gte.${since}&order=started_at.desc&limit=80`,
  );
  if (providerRunRows === null) failedQueries.push("provider_run_evidence");
  const casaQueueRows = await realRows(
    `scraping_queue?select=id,status,processing_status,created_at&processor_context->>portal=eq.casa.it&created_at=gte.${since}&order=created_at.desc&limit=40`,
  );
  if (casaQueueRows === null) failedQueries.push("casa_queue_evidence");
  const recomputeAuditRows = await realRows(
    `padova_recompute_last_result?select=created_at,result&created_at=gte.${since}&order=created_at.desc&limit=20`,
  );
  if (recomputeAuditRows === null) failedQueries.push("recompute_audit_evidence");

  const pwaAckRows = await realRows(
    // La tabella espone created_at, non received_at: la vecchia proiezione
    // faceva fallire la query e quindi l'intero gate.
    `civiko_pwa_sync_acks?select=run_id,pipeline_run_id,source_app,municipality,commercial_zone_slugs,started_at,finished_at,ok,counts,error_code,created_at&finished_at=gte.${since}&order=finished_at.desc&limit=20`,
  );
  if (pwaAckRows === null) failedQueries.push("pwa_sync_ack");

  // La prima riga per pipeline è l'ultimo tentativo nella finestra: un vecchio
  // successo non può nascondere un run successivo fallito.
  const latestPipelineRow = (pipeline: PipelineAction): Record<string, unknown> | undefined =>
    auditRows?.find((candidate) =>
      candidate.pipeline_action === pipeline && candidate.action === "__pipeline__"
    );
  const latestPipelineOk = (pipeline: PipelineAction): boolean => {
    const row = latestPipelineRow(pipeline);
    const started = Date.parse(String(row?.started_at ?? ""));
    const finished = Date.parse(String(row?.finished_at ?? ""));
    return row?.ok === true && Number(row.http_status) >= 200 && Number(row.http_status) < 300 &&
      Number.isFinite(started) && Number.isFinite(finished) && started < finished;
  };
  const latestRunActionRows = (
    pipeline: PipelineAction,
    action: SimpleAction,
  ): Record<string, unknown>[] => {
    const pipelineRow = latestPipelineRow(pipeline);
    const runId = pipelineRow?.pipeline_run_id;
    if (typeof runId !== "string") return [];
    return auditRows?.filter((candidate) =>
      candidate.pipeline_run_id === runId && candidate.action === action
    ) ?? [];
  };
  const latestRunActionOk = (pipeline: PipelineAction, action: SimpleAction): boolean => {
    const rows = latestRunActionRows(pipeline, action);
    return rows.length > 0 && rows.every((row) =>
      row.ok === true && Number(row.http_status) >= 200 && Number(row.http_status) < 300 &&
      Number.isFinite(Date.parse(String(row.started_at ?? ""))) &&
      Number.isFinite(Date.parse(String(row.finished_at ?? ""))) &&
      Date.parse(String(row.started_at)) < Date.parse(String(row.finished_at))
    );
  };

  const latestRunActionResult = (
    pipeline: PipelineAction,
    action: SimpleAction,
  ): Record<string, unknown> | null => {
    const result = latestRunActionRows(pipeline, action)[0]?.result;
    return result && typeof result === "object" && !Array.isArray(result)
      ? result as Record<string, unknown>
      : null;
  };
  const identifierValues = (raw: unknown, key: string, depth = 0): string[] => {
    if (depth > 6 || raw == null) return [];
    if (Array.isArray(raw)) {
      return raw.slice(0, 80).flatMap((value) => identifierValues(value, key, depth + 1));
    }
    if (typeof raw !== "object") return [];
    const src = raw as Record<string, unknown>;
    const own = typeof src[key] === "string" ? [src[key] as string] : [];
    return own.concat(
      Object.values(src).flatMap((value) => identifierValues(value, key, depth + 1)),
    );
  };
  const recordsWithIdentifier = (
    raw: unknown,
    key: string,
    depth = 0,
  ): Record<string, unknown>[] => {
    if (depth > 6 || raw == null) return [];
    if (Array.isArray(raw)) {
      return raw.slice(0, 80).flatMap((value) => recordsWithIdentifier(value, key, depth + 1));
    }
    if (typeof raw !== "object") return [];
    const src = raw as Record<string, unknown>;
    const own = typeof src[key] === "string" ? [src] : [];
    return own.concat(
      Object.values(src).flatMap((value) => recordsWithIdentifier(value, key, depth + 1)),
    );
  };

  // Il gate accetta esplicitamente la raccolta 05:10 standard oppure la
  // variante capped, mai entrambe: vince l'ultimo tentativo per started_at.
  // Tutti i requisiti semantici e di freschezza restano identici.
  const COLLECTION_PIPELINES: PipelineAction[] = ["pipeline_0510", "pipeline_0510_capped"];
  const collectionPipeline: PipelineAction = COLLECTION_PIPELINES
    .map((pipeline) => ({ pipeline, row: latestPipelineRow(pipeline) }))
    .filter((candidate) => candidate.row !== undefined)
    .sort((a, b) =>
      (Date.parse(String(b.row?.started_at ?? "")) || 0) -
      (Date.parse(String(a.row?.started_at ?? "")) || 0)
    )[0]?.pipeline ?? "pipeline_0510";
  const collectionApifyAction: SimpleAction = collectionPipeline === "pipeline_0510_capped"
    ? "apify_batch_capped"
    : "apify_batch";
  const collectionCasaAction: SimpleAction = collectionPipeline === "pipeline_0510_capped"
    ? "portal_casa_capped"
    : "portal_casa";

  // Identificativi dell'esatto ultimo 05:10, correlati sia alla risposta
  // trusted di collect-pending dell'esatto 05:45 sia alle righe DB provider.
  // In questo modo un vecchio SUCCEEDED entro quattro ore non maschera un
  // lancio corrente non ancora importato. Dataset validi ma senza nuove righe
  // restano ammessi tramite zero_novelty.
  const launchBatchResult = latestRunActionResult(collectionPipeline, collectionApifyAction);

  const launchRecords = recordsWithIdentifier(launchBatchResult, "run_id");
  const launchedRunIds = {
    immobiliare: Array.from(new Set(launchRecords.flatMap((row) =>
      row.portal === "immobiliare" && typeof row.run_id === "string" ? [row.run_id] : []
    ))),
    idealista: Array.from(new Set(launchRecords.flatMap((row) =>
      row.portal === "idealista" && typeof row.run_id === "string" ? [row.run_id] : []
    ))),
    subito: Array.from(new Set(launchRecords.flatMap((row) =>
      row.portal === "subito" && typeof row.run_id === "string" ? [row.run_id] : []
    ))),
  };
  const launchedProviderIds = Object.values(launchedRunIds).flat();
  const collectPendingResult = latestRunActionResult("pipeline_0545", "collect_pending");
  const collectEvidence = recordsWithIdentifier(collectPendingResult, "run_id");
  const collectByRunId = new Map<string, Record<string, unknown>>();
  for (const record of collectEvidence) {
    const runId = record.run_id;
    if (typeof runId === "string" && !collectByRunId.has(runId)) collectByRunId.set(runId, record);
  }
  const providerByRunId = new Map<string, Record<string, unknown>>();
  for (const record of providerRunRows ?? []) {
    const runId = record.run_id;
    if (typeof runId === "string" && !providerByRunId.has(runId)) providerByRunId.set(runId, record);
  }
  const providerFamiliesPresent = Object.values(launchedRunIds).every((ids) => ids.length > 0);
  const launchedProvidersCollected = providerFamiliesPresent && launchedProviderIds.every((runId) => {
    const collected = collectByRunId.get(runId);
    const persisted = providerByRunId.get(runId);
    const itemCount = Number(collected?.items ?? -1);
    return collected?.status === "SUCCEEDED" &&
      itemCount >= 0 &&
      (itemCount > 0 || collected?.zero_novelty === true || collectPendingResult?.zero_novelty === true) &&
      Number(collected.errors_count ?? 0) === 0 &&
      persisted?.status === "SUCCEEDED" &&
      Number(persisted.items_count ?? -1) >= 0 &&
      Number(persisted.imported ?? -1) >= 0;
  });
  const collectSummaryOk = Boolean(collectPendingResult) &&
    Number(collectPendingResult?.errors_count ?? -1) === 0 &&
    (Number(collectPendingResult?.imports_count ?? 0) > 0 ||
      collectPendingResult?.zero_novelty === true);

  const casaQueueIds = Array.from(new Set(identifierValues(
    latestRunActionResult(collectionPipeline, collectionCasaAction),
    "queue_id",
  )));
  const casaQueueById = new Map<string, Record<string, unknown>>();
  for (const record of casaQueueRows ?? []) {
    const id = record.id;
    if (typeof id === "string" && !casaQueueById.has(id)) casaQueueById.set(id, record);
  }
  const casaCurrentQueueComplete = casaQueueIds.length > 0 && casaQueueIds.every((queueId) => {
    const row = casaQueueById.get(queueId);
    return row?.status === "succeeded" && row?.processing_status === "succeeded";
  });
  const fourPortalCurrentRunEvidence = launchedProvidersCollected && collectSummaryOk &&
    casaCurrentQueueComplete;

  const recomputeActionStartedMs = Date.parse(String(
    latestRunActionRows("pipeline_0545", "contendibili_recompute")[0]?.started_at ?? "",
  ));
  const recomputeCurrentAuditOk = Number.isFinite(recomputeActionStartedMs) &&
    (recomputeAuditRows ?? []).some((row) => {
      const createdMs = Date.parse(String(row.created_at ?? ""));
      const result = row.result;
      return Number.isFinite(createdMs) && createdMs >= recomputeActionStartedMs &&
        result && typeof result === "object" && !Array.isArray(result) &&
        (result as Record<string, unknown>).ok === true;
    });
  const contendibiliExactRecomputeCount = Number.isFinite(recomputeActionStartedMs)
    ? await realCount(
      `padova_contendibili?select=id&commercial_zone_slug=in.(${CIVIKO_SCOPE_SLUGS.join(",")})&n_agenzie=gte.2&updated_at=gte.${new Date(recomputeActionStartedMs).toISOString()}`,
    )
    : null;
  metrics.derived.contendibili_exact_recompute = contendibiliExactRecomputeCount;
  if (contendibiliExactRecomputeCount === null) {
    if (Number.isFinite(recomputeActionStartedMs)) {
      failedQueries.push("contendibili_exact_recompute");
    } else {
      missingPrerequisites.push("contendibili_recompute_audit_absent");
    }
  }

  const currentImageQueueComplete = latestRunActionRows("pipeline_0545", "image_certify")
    .some((row) => {
      const result = row.result;
      return result && typeof result === "object" && !Array.isArray(result) &&
        (result as Record<string, unknown>).queue_complete === true;
    });
  const currentImageFingerprintWritten = latestRunActionRows("pipeline_0545", "image_certify")
    .some((row) => {
      const result = row.result;
      return result && typeof result === "object" && !Array.isArray(result) &&
        Number((result as Record<string, unknown>).fingerprint_validi ?? 0) > 0;
    });
  const currentImagePairsComplete = latestRunActionRows("pipeline_0545", "image_pairs")
    .some((row) => {
      const result = row.result;
      return result && typeof result === "object" && !Array.isArray(result) &&
        (result as Record<string, unknown>).pairs_snapshot_complete === true;
    });
  const currentImageSnapshotComplete = currentImageQueueComplete && currentImagePairsComplete;

  const pipeline0510 = latestPipelineRow(collectionPipeline);
  const pipeline0545 = latestPipelineRow("pipeline_0545");
  const pipeline0710 = latestPipelineRow("pipeline_0710");
  const pipeline0510StartedMs = Date.parse(String(pipeline0510?.started_at ?? ""));
  const pipeline0510FinishedMs = Date.parse(String(pipeline0510?.finished_at ?? ""));
  const pipeline0545StartedMs = Date.parse(String(pipeline0545?.started_at ?? ""));
  const pipeline0545FinishedMs = Date.parse(String(pipeline0545?.finished_at ?? ""));
  const pipeline0710StartedMs = Date.parse(String(pipeline0710?.started_at ?? ""));
  const pipeline0710FinishedOwnMs = Date.parse(String(pipeline0710?.finished_at ?? ""));
  const pipelineSequenceOk = latestPipelineOk(collectionPipeline) &&
    latestPipelineOk("pipeline_0545") && latestPipelineOk("pipeline_0710") &&
    Number.isFinite(pipeline0510StartedMs) && Number.isFinite(pipeline0510FinishedMs) &&
    Number.isFinite(pipeline0545StartedMs) && Number.isFinite(pipeline0545FinishedMs) &&
    Number.isFinite(pipeline0710StartedMs) && Number.isFinite(pipeline0710FinishedOwnMs) &&
    pipeline0510StartedMs < pipeline0510FinishedMs &&
    pipeline0545StartedMs < pipeline0545FinishedMs &&
    pipeline0710StartedMs < pipeline0710FinishedOwnMs &&
    pipeline0510FinishedMs < pipeline0545StartedMs &&
    pipeline0545FinishedMs < pipeline0710StartedMs;
  const pipeline0710RunId = typeof pipeline0710?.pipeline_run_id === "string"
    ? pipeline0710.pipeline_run_id
    : null;

  // Freshness legata all'esatto ultimo 05:10, non semplicemente a una finestra
  // storica. Gli ID provider/queue restano la prova primaria; questi count
  // certificano che eventuali write dichiarate appartengono allo stesso ciclo.
  const exactRunSince = typeof pipeline0510?.started_at === "string"
    ? pipeline0510.started_at
    : null;
  const exactPortalSpecs = [
    { key: "immobiliare", collect: "eq.immobiliare", listing: "immobiliare" },
    { key: "idealista", collect: "eq.idealista", listing: "idealista" },
    { key: "subito", collect: "eq.subito", listing: "subito" },
    { key: "casa", collect: "in.(casa,casa.it)", listing: "casa" },
  ] as const;
  if (exactRunSince) {
    const exactCounts = await Promise.all(exactPortalSpecs.flatMap((portal) => [
      realCount(
        `padova_collect_v2_items?select=id&portal=${portal.collect}&citta=ilike.Padova&updated_at=gte.${exactRunSince}`,
      ),
      realCount(
        `padova_collect_v2_items?select=id&portal=${portal.collect}&citta=ilike.Padova&created_at=gte.${exactRunSince}`,
      ),
      realCount(
        `padova_listings?select=id&fonte=eq.${portal.listing}&comune=eq.Padova&commercial_zone_slug=in.(${CIVIKO_SCOPE_SLUGS.join(",")})&last_seen_at=gte.${exactRunSince}`,
      ),
    ]));
    exactPortalSpecs.forEach((portal, index) => {
      const [updated, created, listingsCurrent] = exactCounts.slice(index * 3, index * 3 + 3);
      metrics.fresh[`collect_${portal.key}_exact_run`] = updated;
      metrics.fresh[`collect_${portal.key}_created_exact_run`] = created;
      metrics.fresh[`listings_${portal.key}_exact_run`] = listingsCurrent;
      if (updated === null) failedQueries.push(`collect_${portal.key}_exact_run`);
      if (created === null) failedQueries.push(`collect_${portal.key}_created_exact_run`);
      if (listingsCurrent === null) failedQueries.push(`listings_${portal.key}_exact_run`);
    });
  } else {
    missingPrerequisites.push("pipeline_0510_run_absent");
  }
  // L'ack deve riferirsi esattamente all'ultimo tentativo 07:10. Un ack di un
  // run precedente, anche riuscito e ancora nella finestra, non e' riusabile.
  const pwaSyncAck = pipeline0710RunId
    ? pwaAckRows?.find((candidate) => candidate.pipeline_run_id === pipeline0710RunId)
    : undefined;
  const pwaFinishedMs = Date.parse(
    typeof pwaSyncAck?.finished_at === "string" ? pwaSyncAck.finished_at : "",
  );
  const pwaStartedMs = Date.parse(
    typeof pwaSyncAck?.started_at === "string" ? pwaSyncAck.started_at : "",
  );
  const pipelineFinishedMs = Date.parse(
    typeof pipeline0710?.finished_at === "string" ? pipeline0710.finished_at : "",
  );
  const requiredPwaCountKeys = [
    "dashboard", "radar", "mappa", "contendibili", "privati", "ribassi",
    "cambi_agenzia", "offmarket", "quartieri",
  ] as const;
  const pwaCounts = pwaSyncAck?.counts;
  const pwaCountsComplete = Boolean(
    pwaCounts && typeof pwaCounts === "object" && !Array.isArray(pwaCounts) &&
      Object.keys(pwaCounts as Record<string, unknown>).length === requiredPwaCountKeys.length &&
      requiredPwaCountKeys.every((key) => {
        const value = Number((pwaCounts as Record<string, unknown>)[key]);
        return Number.isInteger(value) && value >= 0;
      }),
  );
  const pwaZoneSlugs = pwaSyncAck?.commercial_zone_slugs;
  const pwaScopeComplete = pwaSyncAck?.municipality === "Padova" &&
    Array.isArray(pwaZoneSlugs) &&
    pwaZoneSlugs.length === CIVIKO_SCOPE_SLUGS.length &&
    [...pwaZoneSlugs].sort().every((slug, index) =>
      slug === [...CIVIKO_SCOPE_SLUGS].sort()[index]
    );
  const pwaSyncAckStructurallyOk = latestPipelineOk("pipeline_0710") &&
    pwaSyncAck?.source_app === "civiko-one" &&
    pwaSyncAck?.ok === true &&
    pwaSyncAck?.error_code == null &&
    Number.isFinite(pwaFinishedMs) &&
    Number.isFinite(pwaStartedMs) &&
    Number.isFinite(pipelineFinishedMs) &&
    // Strict ordering proves that this sync started only after the exact
    // pipeline completed, then itself completed. Equality is rejected.
    pwaStartedMs > pipelineFinishedMs &&
    pwaFinishedMs > pwaStartedMs &&
    pwaFinishedMs < gateStartedAtMs &&
    pwaCountsComplete &&
    pwaScopeComplete;

  const metricsAvailable = Boolean(SERVICE_KEY) && failedQueries.length === 0;

  const g = (group: keyof typeof metrics, metric: string): number =>
    (metrics[group][metric] as number) ?? 0;

  const pwaCount = (key: string): number =>
    Number((pwaCounts as Record<string, unknown> | undefined)?.[key] ?? -1);
  // Confronto semantico sui contatori per cui Core e PWA condividono lo stesso
  // significato. L'ack non puo' certificare una cache obsoleta solo perche'
  // temporalmente successiva alla classificazione.
  const pwaCountsMatchCore = pwaCountsComplete &&
    pwaCount("contendibili") === g("categories", "contendibili_scope") &&
    pwaCount("privati") === g("categories", "privati_scope") &&
    pwaCount("ribassi") === g("categories", "contendibili_ribassi") &&
    pwaCount("cambi_agenzia") === g("categories", "cambi_agenzia") &&
    pwaCount("offmarket") === g("categories", "offmarket_verified") &&
    pwaCount("radar") === g("categories", "radar") &&
    pwaCount("quartieri") === CIVIKO_SCOPE_SLUGS.length;
  const pwaSyncAckOk = pwaSyncAckStructurallyOk && pwaCountsMatchCore;
  const gateStartAudit = auditRows?.find((row) =>
    row.pipeline_run_id === gateRunId &&
    row.pipeline_action === "release_gate" &&
    row.action === "__release_gate__"
  );
  const gateAuditStartedMs = Date.parse(String(gateStartAudit?.started_at ?? ""));
  const gateStartsAfterSync = gateStartAudit?.ok === false &&
    Number(gateStartAudit?.http_status) === 102 &&
    Number.isFinite(gateAuditStartedMs) &&
    gateAuditStartedMs >= gateStartedAtMs &&
    Number.isFinite(pwaFinishedMs) &&
    gateAuditStartedMs > pwaFinishedMs;

  const requirements = metricsAvailable
    ? [
      {
        key: "current_pipeline_audits_succeeded",
        // I tre cron hanno run_id distinti: il gate non pretende un run
        // condiviso, ma esige il loro ordine temporale stretto prima del sync.
        passed: pipelineSequenceOk,
      },
      {
        key: "four_portal_runs_succeeded",
        passed: latestRunActionOk(collectionPipeline, collectionCasaAction) &&
          latestRunActionOk(collectionPipeline, collectionApifyAction) &&
          latestRunActionOk("pipeline_0545", "collect_pending") &&
          fourPortalCurrentRunEvidence &&
          g("runs", "apify_immobiliare_succeeded") > 0 &&
          g("runs", "apify_idealista_succeeded") > 0 &&
          g("runs", "apify_subito_succeeded") > 0 &&
          g("runs", "casa_provider_succeeded") > 0 &&
          g("runs", "casa_processor_succeeded") > 0,
      },
      {
        // Anche una notte senza inserimenti netti deve aver realmente letto e
        // promosso dati freschi da tutti e quattro i portali. Il requisito non
        // impone categorie >0 e quindi preserva la zero-novita' legittima.
        key: "four_portal_data_fresh",
        passed: fourPortalCurrentRunEvidence &&
          (["immobiliare", "idealista", "subito", "casa"]
            .every((portal) => g("fresh", `collect_${portal}_exact_run`) > 0 &&
              g("fresh", `listings_${portal}_exact_run`) > 0) ||
            collectPendingResult?.zero_novelty === true),
      },
      {
        key: "image_snapshot_current_semantic_ok",
        passed: latestRunActionOk("pipeline_0545", "image_certify") &&
          latestRunActionOk("pipeline_0545", "image_pairs") &&
          currentImageSnapshotComplete,
      },
      {
        key: "casa_processor_no_dead",
        passed: g("runs", "casa_processor_dead") === 0,
      },
      {
        key: "recompute_current_semantic_ok",
        passed: latestRunActionOk("pipeline_0545", "contendibili_recompute") &&
          g("derived", "contendibili_recomputed_current") > 0 &&
          recomputeCurrentAuditOk,
      },
      {
        key: "classification_current_semantic_ok",
        passed: latestRunActionOk("pipeline_0545", "private_classify") &&
          latestRunActionOk("pipeline_0710", "radar_full") &&
          latestRunActionOk("pipeline_0710", "offmarket_discover") &&
          latestRunActionOk("pipeline_0710", "offmarket_scores") &&
          latestRunActionOk("pipeline_0710", "early_warning") &&
          latestRunActionOk("pipeline_0710", "signals_classify"),
      },
      {
        key: "territory_and_classification_consistent",
        passed: g("scope", "active_comune_null") === 0 &&
          g("scope", "new_active_non_padova") === 0 &&
          g("scope", "new_padova_null_zone") === 0 &&
          g("scope", "invalid_assigned_zone") === 0 &&
          g("scope", "professional_private_mismatch") === 0,
      },
      {
        key: "pwa_scope_consistent",
        passed: g("categories", "contendibili_all") ===
          g("categories", "contendibili_scope"),
      },
      {
        // Ack trusted e Civiko-only: stesso run_id dell'ultimo 07:10, esito
        // semantico positivo, conteggi completi e fine strettamente successiva
        // alla classificazione. Nessun totale storico sostituisce questo sync.
        key: "pwa_sync_after_classification",
        passed: pwaSyncAckOk,
      },
      {
        key: "release_gate_started_after_pwa_sync",
        passed: gateStartsAfterSync,
      },
      {
        key: "initial_real_imports_all_portals",
        applies: initialValidation,
        passed: !initialValidation || ["immobiliare", "idealista", "subito", "casa"]
          .every((portal) => g("fresh", `collect_${portal}_created_exact_run`) > 0 &&
            g("fresh", `listings_${portal}_exact_run`) > 0),
      },
      {
        key: "initial_real_contendibile",
        applies: initialValidation,
        passed: !initialValidation || g("derived", "contendibili_exact_recompute") > 0,
      },
      {
        key: "initial_fingerprint_evidence",
        applies: initialValidation,
        passed: !initialValidation || (currentImageSnapshotComplete &&
          currentImageFingerprintWritten &&
          g("derived", "fingerprints_current") > 0),
      },
    ]
    : [];

  const gate_passed = metricsAvailable && requirements.every((r) => r.passed);
  const cron_activation_allowed = gate_passed;
  const missing = requirements.filter((r) => !r.passed).map((r) => r.key);

  const finalCheckedAtMs = Math.max(Date.now(), gateStartedAtMs + 1);
  const payload: Record<string, unknown> = {
    ok: gate_passed,
    action: "release_gate",
    gate_passed,
    cron_activation_allowed,
    metrics_available: metricsAvailable,
    missing_prerequisites: missingPrerequisites,
    window_hours: GATE_WINDOW_HOURS,
    mode: initialValidation ? "initial_validation" : "routine",
    since,
    metrics,
    requirements,
    missing,
    current_run_evidence: {
      provider_run_ids: launchedRunIds,
      provider_runs_collected: launchedProvidersCollected,
      collect_summary_ok: collectSummaryOk,
      casa_queue_ids: casaQueueIds,
      casa_queue_complete: casaCurrentQueueComplete,
      four_portal_current_run_evidence: fourPortalCurrentRunEvidence,
      recompute_current_audit: recomputeCurrentAuditOk,
      strict_pipeline_sequence: pipelineSequenceOk,
      release_gate_run_id: gateRunId,
      release_gate_started_at: new Date(gateStartedAtMs).toISOString(),
      collection_pipeline: collectionPipeline,
      pipeline_0510_finished_at: pipeline0510?.finished_at ?? null,
      pipeline_0545_started_at: pipeline0545?.started_at ?? null,
      pipeline_0545_finished_at: pipeline0545?.finished_at ?? null,
      pipeline_0710_started_at: pipeline0710?.started_at ?? null,
    },
    pwa_sync_ack: pwaSyncAck
      ? {
        run_id: pwaSyncAck.run_id,
        pipeline_run_id: pwaSyncAck.pipeline_run_id,
        source_app: pwaSyncAck.source_app,
        municipality: pwaSyncAck.municipality,
        commercial_zone_slugs: pwaSyncAck.commercial_zone_slugs,
        started_at: pwaSyncAck.started_at,
        finished_at: pwaSyncAck.finished_at,
        received_at: pwaSyncAck.created_at,
        ok: pwaSyncAck.ok,
        error_code: pwaSyncAck.error_code,
        counts: pwaSyncAck.counts,
        same_pipeline_run: pwaSyncAck.pipeline_run_id === pipeline0710RunId,
        started_after_pipeline_0710: Number.isFinite(pwaStartedMs) &&
          Number.isFinite(pipelineFinishedMs) && pwaStartedMs > pipelineFinishedMs,
        finished_after_pipeline_0710: Number.isFinite(pwaFinishedMs) &&
          Number.isFinite(pipelineFinishedMs) && pwaFinishedMs > pipelineFinishedMs,
        counts_match_core: pwaCountsMatchCore,
        gate_ack_valid: pwaSyncAckOk,
      }
      : null,
    schedule: scheduleContract(),
    checked_at: new Date(finalCheckedAtMs).toISOString(),
  };

  if (!metricsAvailable) {
    payload.error = "metrics_unavailable";
    payload.failed_queries = SERVICE_KEY ? failedQueries : ["service_key_missing"];
    payload.missing_prerequisites = missingPrerequisites;
    return { status: 502, payload };
  }

  return { status: gate_passed ? 200 : 409, payload };
}


Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }

  if (!DISPATCH_SECRET) {
    // Mai loggare il valore o l'assenza dettagliata di altri secret.
    console.error("[civiko-orchestrator-dispatch] misconfigured");
    return json(500, { ok: false, error: "misconfigured" });
  }

  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || !timingSafeEqual(bearer, DISPATCH_SECRET)) {
    return json(401, { ok: false, error: "unauthorized" });
  }

  const ctype = req.headers.get("Content-Type") ?? "";
  if (!ctype.toLowerCase().includes("application/json")) {
    return json(415, { ok: false, error: "unsupported_media_type" });
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return json(413, { ok: false, error: "payload_too_large" });
  }

  let parsed: unknown;
  try {
    parsed = rawBody.trim() ? JSON.parse(rawBody) : {};
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json(400, { ok: false, error: "invalid_payload" });
  }

  const body = parsed as Record<string, unknown>;
  const action = body.action;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) {
    return json(400, { ok: false, error: "action_not_allowed", allowed: ACTIONS });
  }

  if (action === "healthcheck") {
    // Nessun provider, nessuna funzione chiamata: solo stato sanificato.
    return json(200, {
      ok: Boolean(DISPATCH_SECRET && JOB_SECRET && SUPABASE_URL && SERVICE_KEY),
      action: "healthcheck",
      config: {
        dispatch_secret: Boolean(DISPATCH_SECRET),
        job_secret: Boolean(JOB_SECRET),
        supabase_url: Boolean(SUPABASE_URL),
        service_key: Boolean(SERVICE_KEY),
      },
      actions: ACTIONS,
      schedule: scheduleContract(),
      checked_at: new Date().toISOString(),
    });
  }

  if (!JOB_SECRET || !SUPABASE_URL) {
    console.error("[civiko-orchestrator-dispatch] misconfigured");
    return json(500, { ok: false, error: "misconfigured" });
  }

  if (action === "release_gate") {
    if (body.initial_validation !== undefined && typeof body.initial_validation !== "boolean") {
      return json(400, { ok: false, error: "invalid_initial_validation" });
    }
    const gateRunId = crypto.randomUUID();
    const gateStartedAtMs = Date.now();
    const gateStartedAt = new Date(gateStartedAtMs).toISOString();
    const marker: StepResult = {
      action: "signals_classify",
      target: "release_gate",
      ok: false,
      status: 102,
      reason: "in_progress",
      result: { pipeline_run_id: gateRunId },
    };
    const startOk = await persistActionAudit({
      pipelineRunId: gateRunId,
      pipelineAction: "release_gate",
      attemptNo: 1,
      action: "__release_gate__",
      target: "release_gate",
      result: marker,
      startedAt: gateStartedAt,
      finishedAt: gateStartedAt,
      durationMs: 0,
    }, true);
    if (!startOk) return json(502, { ok: false, error: "gate_audit_start_failed" });

    const gate = await releaseGate(body.initial_validation === true, gateRunId, gateStartedAtMs);
    const finalAuditOk = await persistActionAudit({
      pipelineRunId: gateRunId,
      pipelineAction: "release_gate",
      attemptNo: 1,
      action: "__release_gate__",
      target: "release_gate",
      result: {
        action: "signals_classify",
        target: "release_gate",
        ok: gate.status === 200 && gate.payload.gate_passed === true,
        status: gate.status,
        reason: gate.status === 200 ? null : "release_gate_failed",
        result: safeIdentifiers(gate.payload),
      },
      startedAt: gateStartedAt,
      finishedAt: new Date(Math.max(Date.now(), gateStartedAtMs + 1)).toISOString(),
      durationMs: Math.max(1, Date.now() - gateStartedAtMs),
    }, true);
    if (!finalAuditOk && gate.status === 200) {
      return json(502, { ok: false, error: "gate_audit_final_failed" });
    }
    return json(gate.status, { ...gate.payload, release_gate_run_id: gateRunId });
  }


  if (action in PIPELINES) {
    const pipeline = PIPELINES[action as PipelineAction];
    const steps: StepResult[] = [];
    let failedAt: string | null = null;
    const pipelineRunId = crypto.randomUUID();
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    // Write the fail-closed marker before any provider can be reached. The
    // final write upserts this same identity; if the invocation is killed,
    // release_gate sees the unfinished/failed latest run instead of an older
    // successful pipeline.
    const startAuditOk = await persistPipelineAudit(
      pipelineRunId,
      action as PipelineAction,
      false,
      102,
      "in_progress",
      startedAtIso,
      startedAt,
      0,
      pipelineMaxExecutions(pipeline),
    );
    if (!startAuditOk) {
      return json(502, {
        ok: false,
        action,
        pipeline_run_id: pipelineRunId,
        error: "audit_start_failed",
      });
    }
    // Stage sequenziali, azioni indipendenti parallele. Fail-closed al primo
    // stage fallito e budget totale sempre sotto il timeout Replit.
    for (const stage of pipeline.stages) {
      const elapsed = Date.now() - startedAt;
      const remaining = PIPELINE_BUDGET_MS - elapsed - PIPELINE_RESERVE_MS;
      if (remaining < 1_000) {
        failedAt = "pipeline_timeout_budget";
        break;
      }
      const groupedResults = await Promise.all(stage.map(async (step): Promise<StepResult[]> => {
        if (step !== "image_certify") {
          return [await runAction(step, {
            pipelineRunId,
            pipelineAction: action as PipelineAction,
            attemptNo: 1,
          }, remaining)];
        }
        const batches: StepResult[] = [];
        for (let attemptNo = 1; attemptNo <= IMAGE_BATCH_MAX_INVOCATIONS; attemptNo++) {
          const batchRemaining = PIPELINE_BUDGET_MS - (Date.now() - startedAt) -
            IMAGE_BATCH_DOWNSTREAM_RESERVE_MS;
          if (batchRemaining < 1_000) break;
          const result = await runAction("image_certify", {
            pipelineRunId,
            pipelineAction: action as PipelineAction,
            attemptNo,
          }, batchRemaining);
          batches.push(result);
          if (!result.ok || result.result.queue_complete === true) break;
        }
        return batches;
      }));
      const stageResults = groupedResults.flat();
      steps.push(...stageResults);
      const failed = stageResults.find((result) => !result.ok);
      if (failed) {
        failedAt = failed.action;
        break;
      }
      if (stage.includes("image_certify")) {
        const imageRuns = stageResults.filter((result) => result.action === "image_certify");
        if (imageRuns.length === 0 ||
            imageRuns[imageRuns.length - 1].result.queue_complete !== true) {
          failedAt = "image_queue_remaining_after_limit";
          break;
        }
      }
    }
    let ok = failedAt === null;
    let responseStatus = ok ? 200 : (failedAt === "pipeline_timeout_budget" ? 504 : 502);
    const auditOk = await persistPipelineAudit(
      pipelineRunId,
      action as PipelineAction,
      ok,
      responseStatus,
      failedAt,
      startedAtIso,
      startedAt,
      steps.length,
      pipelineMaxExecutions(pipeline),
    );
    if (!auditOk && ok) {
      ok = false;
      responseStatus = 502;
      failedAt = "audit_write_failed";
    }
    return json(responseStatus, {
      ok,
      action,
      pipeline_run_id: pipelineRunId,
      at: pipeline.at,
      timezone: SCHEDULE_TIMEZONE,
      enabled: CRON_ENABLED,
      failed_at: failedAt,
      executed: steps.length,
      planned: pipelineMaxExecutions(pipeline),
      duration_ms: Date.now() - startedAt,
      steps,
    });
  }

  const standaloneRunId = crypto.randomUUID();
  const r = await runAction(action as SimpleAction, {
    pipelineRunId: standaloneRunId,
    pipelineAction: "standalone",
    attemptNo: 1,
  });
  return json(r.ok ? 200 : (r.status >= 400 ? r.status : 502), {
    ok: r.ok,
    action,
    target: r.target,
    status: r.status,
    reason: r.reason,
    result: r.result,
  });
});
