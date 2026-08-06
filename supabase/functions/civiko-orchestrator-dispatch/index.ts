import { isAuctionRecord } from "../_shared/auctionExclusion.ts";

// civiko-orchestrator-dispatch
// Gateway additivo e isolato per l'orchestratore esterno (Replit / Civiko One).
// Allowlist hardcoded verso Edge Functions/RPC già presenti nel Central Core.
//
// Auth: Authorization: Bearer <CIVIKO_ORCHESTRATOR_DISPATCH_SECRET>, fail-closed,
// confronto timing-safe. Il CENTRAL_CORE_JOB_SECRET autentica le chiamate
// interne e non viene mai restituito né loggato.
//
// Pipeline: stage paralleli bounded, fail-closed (si fermano al primo stage con
// uno step non ok) ed entro un budget totale hard.
// Audit canonico UNICO: civiko_orchestrator_action_runs (marker __pipeline__).
// Nessun cron viene creato o attivato da questa funzione.

import {
  ackAfterPipeline,
  ACTION_TIMEOUT_MS,
  budgetExhausted as noBudgetLeft,
  buildGateRequirements,
  CIVIKO_PORTALS,
  COLLECT_PENDING_CONTRACT_BODY,
  downstreamBudgetOk,
  expandedSteps,
  failingActions,
  IMAGE_CERTIFY_HARD_LIMIT,
  IMAGE_CERTIFY_MAX_INVOCATIONS,
  imageBudgetAllows,
  imageCertifyMarker,
  latestPipelineMarkers,
  latestRunsByAction,
  missingActions,
  parseGateMode,
  parseStepBody,
  PIPELINE_BUDGET_MS,
  PIPELINE_MARKER_ACTION,
  PIPELINES,
  pipelinesNotOk,
  pipelineStatus,
  sanitizeResult,
  semanticFailure,
  shouldRepeatImageCertify,
  stageTimeoutMs,
  stepsOfExactRuns,
  stepTimeoutMs,
} from "./orchestrator.ts";
import type {
  ActionRunRow,
  GateIntegrity,
  GateMode,
  PipelineAction,
  SimpleAction,
} from "./orchestrator.ts";

const DISPATCH_SECRET = Deno.env.get("CIVIKO_ORCHESTRATOR_DISPATCH_SECRET") ?? "";
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MAX_BODY_BYTES = 2048;
const GATE_TIMEOUT_MS = 15_000;
const AUDIT_TIMEOUT_MS = 8_000;

type Action = "healthcheck" | "release_gate" | SimpleAction | PipelineAction;

interface Target {
  // Solo nome funzione + query hardcoded: nessun URL o path arbitrario dal client.
  fn: string;
  query?: string;
  rpc?: string;
  body: Record<string, unknown>;
}

// Allowlist hardcoded — anti-SSRF. Nessun input del client entra in URL o path.
const ALLOWED: Record<SimpleAction, Target> = {
  apify_immobiliare: { fn: "cron-apify-immobiliare-nightly", body: {} },
  apify_idealista: { fn: "cron-apify-idealista-nightly", body: {} },
  apify_subito: { fn: "cron-apify-subito-nightly", body: {} },
  // Casa.it: esclusivamente pipeline multipagina esistente via scraping_queue.
  portal_casa: {
    fn: "enqueue-padova-portal-scrapes",
    body: { mode: "full", portals: ["casa.it"], max_pages: 5 },
  },
  // Routine notturna dei lead privati (0510).
  private_leads_nightly: { fn: "civiko-private-leads-nightly", body: {} },
  // collect-pending importa E promuove: nessuna promozione duplicata a valle.
  collect_pending: {
    fn: "padova-apify-collect-pending",
    body: { stale_minutes: 5, max_runs: 10, ...COLLECT_PENDING_CONTRACT_BODY },
  },
  // Classificazione lead privati Subito (privato / privato_stanco).
  private_leads_classify: {
    fn: "civiko-private-leads-classify",
    body: { since_hours: 36 },
  },
  // Riallineamento fail-closed della natura del contatto (agenzia/privato).
  tipo_lead_repair: {
    fn: "civiko_repair_padova_tipo_lead",
    rpc: "civiko_repair_padova_tipo_lead",
    body: {},
  },
  // Snapshot prezzi giornaliero + promozione privato_stanco su ribasso reale.
  price_snapshot: { fn: "civiko-private-leads-price-snapshot", body: {} },
  // Preparazione gratuita delle evidenze già presenti sui listing.
  contendibili_backfill: {
    fn: "padova_backfill_unit_evidence",
    rpc: "padova_backfill_unit_evidence",
    body: { p_batch: 5000, p_force: false },
  },
  // Recompute v3 autoritativo, fail-closed e transazionale.
  contendibili_recompute: {
    fn: "recompute_padova_listings_contendibili",
    rpc: "recompute_padova_listings_contendibili",
    body: {},
  },
  // Certificazione fotografica IMAGE_PHASH_V1 sui soli detail già memorizzati.
  // Nessun cursore: la Edge marca atomicamente i listing trattati.
  contendibili_image_certify: {
    fn: "civiko-contendibili-image-certify",
    body: { limit: IMAGE_CERTIFY_HARD_LIMIT, dry_run: false },
  },
  // Prove per coppia ricalcolate dai fingerprint già persistiti: nessun costo.
  contendibili_pairs: {
    fn: "civiko-contendibili-image-certify",
    body: { pairs_only: true, dry_run: false },
  },
  // Solo candidati in quarantena: cap 24, idempotenza giornaliera.
  contendibili_evidence: {
    fn: "civiko-contendibili-evidence-refresh",
    body: { limit: 24, trigger: "orchestrator" },
  },
  // Popola ribassi/pressione e la tabella autonoma dei cambi agenzia.
  contendibili_extras: {
    fn: "recompute_padova_contendibili_extras",
    rpc: "recompute_padova_contendibili_extras",
    body: {},
  },
  offmarket_discover: {
    fn: "cron-offmarket-padova-nightly",
    query: "job=discover-early-offmarket-signals",
    body: {},
  },
  offmarket_scores: {
    fn: "cron-offmarket-padova-nightly",
    query: "job=build-offmarket-opportunity-scores",
    body: {},
  },
  early_warning: {
    fn: "cron-offmarket-padova-nightly",
    query: "job=build-padova-early-warning",
    body: {},
  },
  radar_full: { fn: "cron-radar-padova-nightly", query: "mode=full", body: {} },
  signals_classify: { fn: "civiko-signals-classify", body: { dry_run: false } },
};

const SCHEDULE_TIMEZONE = "Europe/Rome";
// Nessun cron creato o attivato da questa funzione.
const CRON_ENABLED = false;

const ACTIONS = [
  "healthcheck",
  "release_gate",
  ...Object.keys(ALLOWED),
  ...Object.keys(PIPELINES),
] as const;

function targetName(action: SimpleAction): string {
  const t = ALLOWED[action];
  return t.rpc ? `rpc/${t.rpc}` : t.fn;
}

function scheduleContract() {
  return {
    timezone: SCHEDULE_TIMEZONE,
    enabled: CRON_ENABLED,
    pipelines: (Object.keys(PIPELINES) as PipelineAction[]).map((k) => ({
      action: k,
      at: PIPELINES[k].at,
      stages: PIPELINES[k].stages.map((stage) => stage.map((s) => s.action)),
      steps: expandedSteps(k),
      enabled: CRON_ENABLED,
    })),
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

function json(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const POSTGREST_REASON_MAX_LENGTH = 240;
const SAFE_POSTGREST_CODE = /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/;
const UNSAFE_POSTGREST_MESSAGE =
  /(?:https?:\/\/|www\.|\b(?:authorization|bearer|apikey|api[_-]?key|token|secret|password|service[_-]?role)\b|[{}\[\]]|[A-Za-z0-9_-]{40,})/i;

// Propaga per gli RPC 400 solo SQLSTATE/PGRST code e un eventuale messaggio
// breve privo di URL, credenziali, JSON o token.
function safePostgrestReason(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const code = typeof src.code === "string" && SAFE_POSTGREST_CODE.test(src.code)
    ? src.code
    : null;
  if (!code) return null;
  const message = typeof src.message === "string"
    ? src.message.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
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
  attempt_no: number;
  duration_ms: number;
  /** Payload oggetto (solo per progressione interna, mai restituito). */
  raw?: Record<string, unknown> | null;
}

async function runAction(
  action: SimpleAction,
  timeoutMs: number,
  bodyOverride?: Record<string, unknown>,
): Promise<Omit<StepResult, "attempt_no">> {
  const target = ALLOWED[action];
  const isRpc = typeof target.rpc === "string";
  const name = targetName(action);
  const url = isRpc
    ? `${SUPABASE_URL}/rest/v1/rpc/${target.rpc}`
    : `${SUPABASE_URL}/functions/v1/${target.fn}${target.query ? `?${target.query}` : ""}`;
  const t0 = Date.now();

  if (isRpc && !SERVICE_KEY) {
    return {
      action,
      target: name,
      ok: false,
      status: 500,
      reason: "service_key_missing",
      result: {},
      duration_ms: 0,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
  try {
    const headers: Record<string, string> = isRpc
      ? {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      }
      : { "Content-Type": "application/json", "x-job-secret": JOB_SECRET };
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...target.body, ...(bodyOverride ?? {}) }),
      signal: controller.signal,
    });

    const text = await res.text();
    // Parsing fail-closed anche per gli RPC: body nullo, vuoto, non-JSON o non
    // oggetto è guasto, con qualunque status HTTP.
    const parsed = parseStepBody(text);
    const obj = parsed.obj;
    const semantic = res.ok ? (parsed.error ?? semanticFailure(action, obj)) : null;

    const reason = isRpc && res.status === 400
      ? safePostgrestReason(obj) ?? "postgrest_bad_request"
      : obj && typeof obj.reason === "string"
      ? obj.reason
      : obj && typeof obj.error === "string"
      ? obj.error
      : semantic;

    console.log(
      `[civiko-orchestrator-dispatch] action=${action} target=${name} status=${res.status}${
        semantic ? ` semantic=${semantic}` : ""
      }`,
    );

    return {
      action,
      target: name,
      ok: res.ok && semantic === null,
      status: res.status,
      reason,
      // Audit: JSON di risposta SANIFICATO (non i soli contatori).
      result: sanitizeResult(obj),
      raw: obj,
      duration_ms: Date.now() - t0,
    };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    console.error(
      `[civiko-orchestrator-dispatch] action=${action} failure=${
        aborted ? "timeout" : "network_error"
      }`,
    );
    return {
      action,
      target: name,
      ok: false,
      status: aborted ? 504 : 502,
      reason: aborted ? "timeout" : "network_error",
      result: {},
      duration_ms: Date.now() - t0,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Audit canonico (upsert unique su pipeline_run_id,action,attempt_no) ─────
interface AuditRow {
  pipelineRunId: string;
  pipeline: string | null;
  action: string;
  attemptNo: number;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  status: number | null;
  errorCode: string | null;
  target: string | null;
  result: Record<string, unknown>;
  durationMs: number | null;
}

/**
 * L'audit è parte del contratto: se la scrittura fallisce, lo step (e quindi la
 * pipeline) NON può risultare riuscito. Ritorna null se scritto.
 */
async function upsertActionRun(row: AuditRow): Promise<string | null> {
  if (!SERVICE_KEY) return "audit_service_key_missing";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUDIT_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/civiko_orchestrator_action_runs` +
        `?on_conflict=pipeline_run_id,action,attempt_no`,
      {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify([{
          run_id: row.pipelineRunId,
          pipeline_run_id: row.pipelineRunId,
          action: row.action,
          pipeline: row.pipeline,
          pipeline_action: row.pipeline,
          attempt_no: row.attemptNo,
          target: row.target,
          started_at: row.startedAt,
          finished_at: row.finishedAt,
          ok: row.ok,
          status: row.status,
          http_status: row.status,
          error_code: row.errorCode ? row.errorCode.slice(0, 120) : null,
          counters: Object.fromEntries(
            Object.entries(row.result).filter(([, v]) => typeof v === "number"),
          ),
          result: row.result,
          duration_ms: row.durationMs,
        }]),
        signal: controller.signal,
      },
    );
    await res.body?.cancel();
    if (!res.ok) {
      console.error(`[dispatch] audit not recorded action=${row.action} status=${res.status}`);
      return "audit_write_failed";
    }
    return null;
  } catch {
    console.error(`[dispatch] audit not recorded action=${row.action}`);
    return "audit_write_failed";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Esegue registrando SEMPRE start e finalizzazione. Il marker di start esiste
 * prima di qualunque chiamata provider: un crash lascia l'ultimo tentativo
 * fallito, mai un vecchio successo.
 */
async function runAuditedAction(
  action: SimpleAction,
  timeoutMs: number,
  pipelineRunId: string,
  pipeline: string | null,
  attemptNo: number,
  bodyOverride?: Record<string, unknown>,
): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const base: AuditRow = {
    pipelineRunId,
    pipeline,
    action,
    attemptNo,
    startedAt,
    finishedAt: null,
    ok: false,
    status: null,
    errorCode: "IN_PROGRESS",
    target: targetName(action),
    result: {},
    durationMs: null,
  };
  const startAudit = await upsertActionRun(base);
  if (startAudit) {
    return {
      action,
      target: targetName(action),
      ok: false,
      status: 500,
      reason: startAudit,
      result: {},
      attempt_no: attemptNo,
      duration_ms: 0,
      raw: null,
    };
  }

  const step = await runAction(action, timeoutMs, bodyOverride);
  const finalAudit = await upsertActionRun({
    ...base,
    finishedAt: new Date().toISOString(),
    ok: step.ok,
    status: step.status,
    errorCode: step.ok ? null : (step.reason ?? "unknown"),
    result: step.result,
    durationMs: step.duration_ms,
  });
  if (finalAudit) {
    return { ...step, ok: false, status: step.ok ? 500 : step.status, reason: finalAudit, attempt_no: attemptNo };
  }
  return { ...step, attempt_no: attemptNo };
}

/** Marker __pipeline__: scritto failed/in-progress PRIMA di ogni provider. */
async function recordPipelineMarker(
  pipelineRunId: string,
  pipeline: string,
  startedAt: string,
  finished: { ok: boolean; status: number; errorCode: string | null; durationMs: number } | null,
): Promise<string | null> {
  return await upsertActionRun({
    pipelineRunId,
    pipeline,
    action: PIPELINE_MARKER_ACTION,
    attemptNo: 1,
    startedAt,
    finishedAt: finished ? new Date().toISOString() : null,
    ok: finished ? finished.ok : false,
    status: finished ? finished.status : null,
    errorCode: finished ? finished.errorCode : "IN_PROGRESS",
    target: pipeline,
    result: {},
    durationMs: finished ? finished.durationMs : null,
  });
}

/**
 * Continuazione della pipeline in una NUOVA invocazione, con lo stesso
 * pipeline_run_id: fail-closed, se la richiesta non parte il marker si chiude
 * come fallito. Non si attende l'esito del segmento successivo (chiuderà lui
 * il marker), ma si attende l'accettazione HTTP entro la riserva.
 */
async function dispatchContinuation(
  pipeline: PipelineAction,
  pipelineRunId: string,
  stageFrom: number,
  startedAt: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONTINUATION_RESERVE_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/civiko-orchestrator-dispatch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DISPATCH_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: pipeline,
        pipeline_run_id: pipelineRunId,
        stage_from: stageFrom,
        started_at: startedAt,
      }),
      signal: controller.signal,
    });
    await res.body?.cancel();
    if (res.status >= 400 && res.status !== 202) return "CONTINUATION_REJECTED";
    return null;
  } catch (e) {
    // L'abort dopo l'invio è atteso: la richiesta è già stata accettata.
    if (e instanceof DOMException && e.name === "AbortError") return null;
    return "CONTINUATION_DISPATCH_FAILED";
  } finally {
    clearTimeout(timer);
  }
}



// ── Metriche reali del release gate ─────────────────────────────────────────
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

  const counts: Array<number | null> = [];
  for (let i = 0; i < CIVIKO_SCOPE_SLUGS.length; i += RIBASSI_RPC_CONCURRENCY) {
    const batch = CIVIKO_SCOPE_SLUGS.slice(i, i + RIBASSI_RPC_CONCURRENCY);
    const batchCounts = await Promise.all(batch.map((slug) => callSlug(slug)));
    for (const count of batchCounts) counts.push(count);
  }
  return counts.some((count) => count === null)
    ? null
    : counts.reduce<number>((sum, count) => sum + (count ?? 0), 0);
}

interface GateSpec {
  group: "imported" | "casa_pipeline" | "categories" | "classified_in_window" | "portals";
  metric: string;
  q: string;
}

function gateSpecs(since: string): GateSpec[] {
  const casaCtx = `processor_context->>portal=eq.casa.it`;
  const scope = CIVIKO_SCOPE_SLUGS.join(",");
  const offmarketSince = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();
  return [
    ...CIVIKO_PORTALS.map((p) => ({
      group: "portals" as const,
      metric: `collect_items_${p}_fresh`,
      q:
        `padova_collect_v2_items?select=id&portal=eq.${p}&citta=ilike.padova&or=(created_at.gte.${since},updated_at.gte.${since})`,
    })),
    {
      group: "casa_pipeline",
      metric: "queue_provider_succeeded",
      q: `scraping_queue?select=id&${casaCtx}&created_at=gte.${since}&status=eq.succeeded`,
    },
    {
      group: "casa_pipeline",
      metric: "queue_processor_succeeded",
      q: `scraping_queue?select=id&${casaCtx}&created_at=gte.${since}&processing_status=eq.succeeded`,
    },
    {
      group: "casa_pipeline",
      metric: "queue_processor_dead",
      q: `scraping_queue?select=id&${casaCtx}&created_at=gte.${since}&processing_status=eq.dead`,
    },
    {
      group: "casa_pipeline",
      metric: "collect_items_casa_fresh",
      q:
        `padova_collect_v2_items?select=id&portal=eq.casa&or=(created_at.gte.${since},updated_at.gte.${since})`,
    },
    {
      group: "imported",
      metric: "listings_casa_total",
      q: `padova_listings?select=id&fonte=eq.casa`,
    },
    {
      group: "imported",
      metric: "listings_casa_imported_in_window",
      q: `padova_listings?select=id&fonte=eq.casa&imported_at=gte.${since}`,
    },
    {
      group: "imported",
      metric: "listings_casa_seen_in_window",
      q: `padova_listings?select=id&fonte=eq.casa&last_seen_at=gte.${since}`,
    },
    {
      group: "categories",
      metric: "contendibili_total",
      q:
        `padova_contendibili_by_zone_v?select=id&commercial_zone_slug=in.(${scope})&or=(agency_count_distinct.gte.2,and(agency_count_distinct.is.null,n_agenzie.gte.2))`,
    },
    {
      group: "categories",
      metric: "contendibili_multi_agenzia",
      q:
        `padova_contendibili_by_zone_v?select=id&commercial_zone_slug=in.(${scope})&n_agenzie=gte.3`,
    },
    {
      group: "categories",
      metric: "contendibili_cambio_agenzia",
      q: `padova_cambi_agenzia?select=id&is_active=eq.true`,
    },
    {
      group: "categories",
      metric: "privati_padova",
      q:
        `padova_listings?select=id&comune=eq.Padova&tipo_lead=in.(PRIVATO,privato,privato_stanco)&expired_at=is.null&commercial_zone_slug=in.(${scope})`,
    },
    {
      group: "categories",
      metric: "offmarket_verified",
      q:
        `early_offmarket_signal_candidates_by_zone_v?select=id&commercial_zone_slug=in.(${scope})&comune=eq.Padova&privacy_safe=eq.true&needs_review=eq.false&import_recommendation=eq.importable&confidence_score=gte.0.7&status=in.(approved,promoted,importable)&source_url=like.https://*&created_at=gte.${offmarketSince}`,
    },
    {
      group: "classified_in_window",
      metric: "signals_classified_updated",
      q: `civiko_signals_classified?select=signal_id&updated_at=gte.${since}`,
    },
    {
      group: "imported",
      metric: "listings_imported_in_window",
      q: `padova_listings?select=id&imported_at=gte.${since}`,
    },
    ...CIVIKO_PORTALS.map((p) => ({
      group: "imported" as const,
      metric: `listings_${p}_imported_in_window`,
      q: `padova_listings?select=id&fonte=eq.${p}&imported_at=gte.${since}`,
    })),
    {
      group: "categories",
      metric: "image_fingerprints_fresh",
      q: `civiko_listing_image_fingerprints?select=id&created_at=gte.${since}`,
    },
  ];
}

async function readGateIntegrity(): Promise<GateIntegrity | null> {
  if (!SERVICE_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATE_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/civiko_padova_release_gate_v?select=*&limit=1`,
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => null);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || typeof row !== "object") return null;
    const r = row as Record<string, unknown>;
    // Nomi REALI delle colonne della vista: pipeline_0710_ultimo /
    // pipeline_0710_ok. Nessun alias inesistente.
    if (!("pipeline_0710_ultimo" in r) || !("pipeline_0710_ok" in r)) return null;
    const num = (k: string) => Number(r[k] ?? NaN);
    const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : null);
    const out: GateIntegrity = {
      portali_freschi: num("portali_freschi"),
      mismatch_professionale: num("mismatch_professionale"),
      listings_freschi: num("listings_freschi"),
      classificazione_ultima: str("classificazione_ultima"),
      recompute_ultimo: str("recompute_ultimo"),
      contendibili_totali: num("contendibili_totali"),
      recompute_corrente: r.recompute_corrente === true,
      pipeline_0710_ultimo: str("pipeline_0710_ultimo"),
      pipeline_0710_ok: r.pipeline_0710_ok === true,
      pipeline_0710_run_id: str("pipeline_0710_run_id"),
      pipeline_0545_run_id: str("pipeline_0545_run_id"),
      pwa_sync_ack_ultimo_ok: str("pwa_sync_ack_ultimo_ok"),
      pwa_sync_ack_corrente: r.pwa_sync_ack_corrente === true,
      contendibili_fuori_perimetro: num("contendibili_fuori_perimetro"),
      privati_fuori_perimetro: num("privati_fuori_perimetro"),
    };
    const numeric = [
      out.portali_freschi,
      out.mismatch_professionale,
      out.listings_freschi,
      out.contendibili_totali,
      out.contendibili_fuori_perimetro,
      out.privati_fuori_perimetro,
    ];
    return numeric.every((n) => Number.isFinite(n)) ? out : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Audit canonico UNICO nella finestra: marker di pipeline e step delle azioni
 * provengono dalla stessa tabella. Lettura bounded.
 */
async function readActionRuns(since: string): Promise<ActionRunRow[] | null> {
  if (!SERVICE_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATE_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/civiko_orchestrator_action_runs` +
        `?select=action,pipeline,pipeline_run_id,attempt_no,started_at,finished_at,ok,status,error_code` +
        `&started_at=gte.${since}&order=started_at.asc&limit=2000`,
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => null);
    if (!Array.isArray(rows)) return null;
    return rows.filter((r) => r && typeof r === "object" && typeof r.action === "string")
      .map((r) => ({
        action: String(r.action),
        pipeline: typeof r.pipeline === "string" ? r.pipeline : null,
        pipeline_run_id: typeof r.pipeline_run_id === "string" ? r.pipeline_run_id : null,
        attempt_no: typeof r.attempt_no === "number" ? r.attempt_no : 1,
        started_at: String(r.started_at ?? ""),
        finished_at: typeof r.finished_at === "string" ? r.finished_at : null,
        ok: typeof r.ok === "boolean" ? r.ok : null,
        status: typeof r.status === "number" ? r.status : null,
        error_code: typeof r.error_code === "string" ? r.error_code : null,
      }));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function releaseGate(mode: GateMode) {
  const since = new Date(Date.now() - GATE_WINDOW_HOURS * 60 * 60_000).toISOString();
  const specs = gateSpecs(since);

  const metrics: Record<string, Record<string, number | null>> = {
    imported: {},
    casa_pipeline: {},
    categories: {},
    classified_in_window: {},
    portals: {},
  };
  const failedQueries: string[] = [];

  for (const s of specs) {
    const count = await realCount(s.q);
    metrics[s.group][s.metric] = count;
    if (count === null) failedQueries.push(s.metric);
  }
  const ribassiCount = await verifiedPriceDropsCount();
  metrics.categories.contendibili_ribassi = ribassiCount;
  if (ribassiCount === null) failedQueries.push("contendibili_ribassi");

  const integrity = await readGateIntegrity();
  if (!integrity) failedQueries.push("release_gate_integrity_view");

  const allActionRuns = await readActionRuns(since);
  if (!allActionRuns) failedQueries.push("orchestrator_action_runs");

  const latestPipelines = latestPipelineMarkers(allActionRuns ?? []);
  const actionRuns = allActionRuns ? stepsOfExactRuns(allActionRuns, latestPipelines) : null;

  const metricsAvailable = Boolean(SERVICE_KEY) && failedQueries.length === 0 &&
    integrity !== null && actionRuns !== null;

  const g = (group: string, metric: string): number =>
    (metrics[group]?.[metric] as number) ?? 0;

  const requirements = metricsAvailable && integrity && actionRuns
    ? buildGateRequirements({
      mode,
      metric: g,
      integrity,
      actionRuns,
      pipelineRuns: latestPipelines,
    })
    : [];

  const gate_passed = metricsAvailable && requirements.every((r) => r.passed);
  const cron_activation_allowed = gate_passed;
  const missing = requirements.filter((r) => !r.passed).map((r) => r.key);

  const payload: Record<string, unknown> = {
    ok: gate_passed,
    action: "release_gate",
    mode,
    gate_passed,
    cron_activation_allowed,
    metrics_available: metricsAvailable,
    window_hours: GATE_WINDOW_HOURS,
    since,
    metrics,
    integrity,
    audit_source: "civiko_orchestrator_action_runs",
    pipelines_latest: Array.from(latestPipelines.entries()).map(([pipeline, r]) => ({
      pipeline,
      pipeline_run_id: r.pipeline_run_id,
      ok: r.ok,
      status: r.status,
      finished_at: r.finished_at,
      error_code: r.error_code,
    })),
    pipelines_not_ok: allActionRuns ? pipelinesNotOk(latestPipelines) : null,
    actions_latest: actionRuns
      ? Array.from(latestRunsByAction(actionRuns).entries()).map(([key, r]) => ({
        key,
        action: r.action,
        pipeline: r.pipeline,
        attempt_no: r.attempt_no ?? 1,
        ok: r.ok,
        status: r.status,
        error_code: r.error_code,
        finished_at: r.finished_at,
      }))
      : null,
    actions_failing: actionRuns ? failingActions(actionRuns) : null,
    actions_missing: actionRuns ? missingActions(actionRuns) : null,
    pwa_ack_after_pipeline_0710: integrity
      ? ackAfterPipeline(integrity.pwa_sync_ack_ultimo_ok, integrity.pipeline_0710_ultimo)
      : null,
    requirements,
    missing,
    schedule: scheduleContract(),
    checked_at: new Date().toISOString(),
  };

  if (!metricsAvailable) {
    payload.error = "metrics_unavailable";
    payload.failed_queries = SERVICE_KEY ? failedQueries : ["service_key_missing"];
    return { status: 502, payload };
  }

  return { status: gate_passed ? 200 : 409, payload };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }

  if (!DISPATCH_SECRET) {
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
    return json(200, {
      ok: Boolean(DISPATCH_SECRET && JOB_SECRET && SUPABASE_URL),
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
    const gate = await releaseGate(parseGateMode(body.mode));
    return json(gate.status, gate.payload);
  }

  if (action in PIPELINES) {
    const pipelineAction = action as PipelineAction;
    const pipeline = PIPELINES[pipelineAction];
    const planned = expandedSteps(pipelineAction);

    // Segmentazione: ogni invocazione esegue un blocco di stage il cui costo
    // peggiore è dimostrabilmente < PIPELINE_BUDGET_MS; la continuazione riusa
    // lo STESSO pipeline_run_id, quindi l'audit resta una sola esecuzione.
    const rawStageFrom = body.stage_from;
    const stageFrom = typeof rawStageFrom === "number" && Number.isInteger(rawStageFrom)
      ? rawStageFrom
      : 0;
    const segments = segmentPipeline(pipelineAction);
    const segment = segmentStartingAt(pipelineAction, stageFrom);
    if (!segment) {
      return json(400, { ok: false, action, error: "invalid_segment", stage_from: stageFrom });
    }
    const isFirstSegment = stageFrom === 0;
    const isLastSegment = segment.to >= pipeline.stages.length - 1;

    const continuedRunId = typeof body.pipeline_run_id === "string" ? body.pipeline_run_id : "";
    if (!isFirstSegment && !continuedRunId) {
      return json(400, { ok: false, action, error: "continuation_run_id_missing" });
    }
    const pipelineRunId = isFirstSegment ? crypto.randomUUID() : continuedRunId;
    const startedAtIso = (!isFirstSegment && typeof body.started_at === "string" &&
        !Number.isNaN(Date.parse(body.started_at)))
      ? body.started_at
      : new Date().toISOString();

    const steps: StepResult[] = [];
    let failedAt: string | null = null;
    let exhausted = false;
    const startedMs = Date.now();

    if (isFirstSegment) {
      // Marker __pipeline__ failed/in-progress PRIMA di qualunque provider.
      const startAudit = await recordPipelineMarker(
        pipelineRunId,
        pipelineAction,
        startedAtIso,
        null,
      );
      if (startAudit) {
        return json(500, {
          ok: false,
          action,
          pipeline_run_id: pipelineRunId,
          run_id: pipelineRunId,
          error: startAudit,
        });
      }
    }

    const remainingMs = () => PIPELINE_BUDGET_MS - (Date.now() - startedMs);
    const pushBudgetFailure = (step: SimpleAction, reason: string) => {
      exhausted = true;
      failedAt = step;
      steps.push({
        action: step,
        target: targetName(step),
        ok: false,
        status: 504,
        reason,
        result: {},
        attempt_no: 1,
        duration_ms: 0,
      });
    };

    outer:
    for (let stageIndex = segment.from; stageIndex <= segment.to; stageIndex++) {
      const stage = pipeline.stages[stageIndex];
      const isImageStage = stage.length === 1 &&
        stage[0].action === "contendibili_image_certify";
      // Riserva reale: solo gli stage RESIDUI DI QUESTO segmento.
      const downstreamReserve = remainingStagesWorstCaseMs(
        pipelineAction,
        stageIndex,
        segment.to,
      ) + (isLastSegment ? 0 : CONTINUATION_RESERVE_MS);

      if (noBudgetLeft(remainingMs())) {
        pushBudgetFailure(stage[0].action, "pipeline_budget_exhausted");
        break outer;
      }

      if (isImageStage) {
        // Fase immagini: almeno un batch hard-4, mai oltre la riserva residua.
        let marker: number | null = null;
        let attempt = 0;
        while (attempt < IMAGE_CERTIFY_MAX_INVOCATIONS) {
          if (!imageBudgetAllows(remainingMs(), downstreamReserve)) break;
          attempt++;
          const r = await runAuditedAction(
            "contendibili_image_certify",
            stepTimeoutMs("contendibili_image_certify", remainingMs()),
            pipelineRunId,
            pipelineAction,
            attempt,
            { limit: IMAGE_CERTIFY_HARD_LIMIT, pipeline_run_id: pipelineRunId },
          );
          steps.push(r);
          if (!r.ok) {
            failedAt = r.action;
            break outer;
          }
          const progress = (r.raw ?? {}) as Record<string, unknown>;
          if (!shouldRepeatImageCertify(attempt, progress, marker)) break;
          marker = imageCertifyMarker(progress) ?? marker;
        }
        if (attempt === 0) {
          // Nemmeno una invocazione: budget insufficiente, fail-closed 504.
          pushBudgetFailure("contendibili_image_certify", "image_budget_insufficient");
          break outer;
        }
        if (!downstreamBudgetOk(remainingMs(), downstreamReserve)) {
          pushBudgetFailure(
            pipeline.stages[Math.min(stageIndex + 1, pipeline.stages.length - 1)][0].action,
            "downstream_budget_insufficient",
          );
          break outer;
        }
        continue;
      }

      // Stage parallelo bounded: tutte le azioni partono insieme, il timeout è
      // quello della più lenta, sempre clampato sul budget residuo.
      const timeout = stageTimeoutMs(stage.map((s) => s.action), remainingMs());
      const results = await Promise.all(
        stage.map((s) =>
          runAuditedAction(
            s.action,
            Math.min(timeout, stepTimeoutMs(s.action, remainingMs())),
            pipelineRunId,
            pipelineAction,
            1,
            { pipeline_run_id: pipelineRunId },
          )
        ),
      );
      for (const r of results) steps.push(r);
      const failedStep = results.find((r) => !r.ok);
      if (failedStep) {
        failedAt = failedStep.action;
        break outer;
      }
    }

    const failing = steps.find((s) => !s.ok);
    let status = pipelineStatus(steps, exhausted);
    const segmentOk = failedAt === null && status === 200;

    // Continuazione: solo se il segmento è riuscito e restano stage.
    let continuation: string | null = null;
    if (segmentOk && !isLastSegment) {
      continuation = await dispatchContinuation(
        pipelineAction,
        pipelineRunId,
        segment.to + 1,
        startedAtIso,
      );
      if (continuation) {
        failedAt = "continuation";
        status = 502;
      }
    }

    // Il marker finale si chiude SOLO all'ultimo segmento o su fallimento.
    const closing = !segmentOk || isLastSegment || continuation !== null;
    if (closing) {
      const endAudit = await recordPipelineMarker(pipelineRunId, pipelineAction, startedAtIso, {
        ok: failedAt === null && status === 200,
        status,
        errorCode: failedAt === null
          ? null
          : (exhausted ? "BUDGET_EXHAUSTED" : (continuation ?? "STEP_FAILED")),
        durationMs: Date.now() - startedMs,
      });
      if (endAudit) {
        failedAt = failedAt ?? "audit";
        status = status === 200 ? 500 : status;
      }
    }

    return json(closing ? status : 202, {
      ok: failedAt === null && (status === 200 || !closing),
      action,
      pipeline_run_id: pipelineRunId,
      run_id: pipelineRunId,
      at: pipeline.at,
      timezone: SCHEDULE_TIMEZONE,
      enabled: CRON_ENABLED,
      failed_at: failedAt,
      failed_reason: failing?.reason ?? continuation ?? null,
      budget_exhausted: exhausted,
      elapsed_ms: Date.now() - startedMs,
      budget_ms: PIPELINE_BUDGET_MS,
      segment: { index: segments.findIndex((s) => s.from === segment.from), ...segment },
      segments: segments.length,
      segment_capacity_ms: SEGMENT_CAPACITY_MS,
      pipeline_complete: closing && failedAt === null,
      continuation_dispatched: segmentOk && !isLastSegment && continuation === null,
      executed: steps.length,
      planned: planned.length,
      image_certify_max_invocations: IMAGE_CERTIFY_MAX_INVOCATIONS,
      steps: steps.map(({ raw: _raw, ...s }) => s),
    });
  }

  const single = action as SimpleAction;
  const runId = crypto.randomUUID();
  const r = await runAuditedAction(
    single,
    stepTimeoutMs(single, PIPELINE_BUDGET_MS),
    runId,
    null,
    1,
  );
  return json(
    r.ok ? 200 : (r.status >= 400 && r.status <= 599 ? r.status : 502),
    {
      ok: r.ok,
      action,
      run_id: runId,
      target: r.target,
      status: r.status,
      reason: r.reason,
      result: r.result,
    },
  );
});
