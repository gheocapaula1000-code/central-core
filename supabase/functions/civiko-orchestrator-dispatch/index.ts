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

import {
  ackAfterPipeline,
  buildGateRequirements,
  CIVIKO_PORTALS,
  expandedSteps,
  failingActions,
  IMAGE_CERTIFY_HARD_LIMIT,
  IMAGE_CERTIFY_MAX_INVOCATIONS,
  missingActions,
  parseGateMode,
  PIPELINE_BUDGET_MS,
  PIPELINES,
  pipelineStatus,
  semanticFailure,
  STEP_MIN_MS,
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
  collect_pending: {
    fn: "padova-apify-collect-pending",
    body: { stale_minutes: 5, max_runs: 10 },
  },
  // Importazione/promozione degli item raccolti in padova_listings.
  // Classificazione tipo_lead fail-closed lato SQL (nessun PRIVATO d'ufficio).
  listings_promote: {
    fn: "promote_padova_collect_v2_to_listings",
    rpc: "promote_padova_collect_v2_to_listings",
    body: {},
  },
  // Classificazione lead privati Subito (privato / privato_stanco).
  private_leads_classify: {
    fn: "civiko-private-leads-classify",
    body: { since_hours: 36 },
  },
  // Riallineamento fail-closed della natura del contatto (agenzia/privato)
  // con la sola regola ufficiale: nessun PRIVATO d'ufficio.
  tipo_lead_repair: {
    fn: "civiko_repair_padova_tipo_lead",
    rpc: "civiko_repair_padova_tipo_lead",
    body: {},
  },



  // Snapshot prezzi giornaliero + promozione privato_stanco su ribasso reale.
  price_snapshot: {
    fn: "civiko-private-leads-price-snapshot",
    body: {},
  },
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
  // Certificazione fotografica IMAGE_PHASH_V1: solo detail già memorizzati,
  // nessuno scraping e nessun provider a pagamento. Esclusiva Civiko One.
  // Hard limit bounded: IMAGE_CERTIFY_HARD_LIMIT elementi per invocazione.
  contendibili_image_certify: {
    fn: "civiko-contendibili-image-certify",
    body: { limit: IMAGE_CERTIFY_HARD_LIMIT, dry_run: false, offset: 0 },
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
  radar_full: {
    fn: "cron-radar-padova-nightly",
    query: "mode=full",
    body: {},
  },
  signals_classify: {
    fn: "civiko-signals-classify",
    body: { dry_run: false },
  },
};

// Pipeline sequenziali e fail-closed: contratto in ./orchestrator.ts.

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
      steps: expandedSteps(k),
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

// Estrae solo identificativi operativi non sensibili dalla risposta interna.
function safeIdentifiers(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const src = raw as Record<string, unknown>;
  const keys = [
    "job",
    "slug",
    "run_id",
    "dataset_id",
    "ingest_run_id",
    "portal",
    "skipped",
    "processed",
    "pending",
    "inserted",
    "updated",
    "rows_out",
    "enqueued",
    "candidates_found",
    "groups_considered",
    "groups_eligible",
    "contendibili_before",
    "contendibili_after",
    "certificati",
    "quarantinati",
    "righe_senza_civico",
    "con_3_piu_agenzie",
    "multi_portale_before",
    "multi_portale_after",
    "urls_scannati",
    "urls_con_cambio",
    "cambi_scritti",
    "contendibili_marcati",
    "remaining",
    "mismatch_residuo",
    "raw_json_annunci_processati",
    "raw_json_image_refs_estratti",

    "match_version",
    "triggered_at",
  ];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = src[k];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    }
  }
  return out;
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

// Azioni per cui uno zero è un esito ANOMALO: la raccolta/importazione deve
// produrre almeno un progresso reale, altrimenti la pipeline si ferma.
const ZERO_GUARD: Partial<Record<SimpleAction, readonly string[]>> = {
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

async function runAction(
  action: SimpleAction,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<StepResult> {

  const target = ALLOWED[action];
  const isRpc = typeof target.rpc === "string";
  const targetName = isRpc ? `rpc/${target.rpc}` : target.fn;
  const url = isRpc
    ? `${SUPABASE_URL}/rest/v1/rpc/${target.rpc}`
    : `${SUPABASE_URL}/functions/v1/${target.fn}${target.query ? `?${target.query}` : ""}`;

  if (isRpc && !SERVICE_KEY) {
    return {
      action,
      target: targetName,
      ok: false,
      status: 500,
      reason: "service_key_missing",
      result: {},
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
      : {
        "Content-Type": "application/json",
        "x-job-secret": JOB_SECRET,
      };
    // Nessun retry interno: gestito dall'orchestratore.
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(target.body),
      signal: controller.signal,
    });

    const text = await res.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    const obj = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    const semantic = res.ok ? semanticFailure(action, obj) : null;
    const reason = isRpc && res.status === 400
      ? safePostgrestReason(payload) ?? "postgrest_bad_request"
      : obj && typeof obj.reason === "string"
      ? obj.reason
      : obj && typeof obj.error === "string"
      ? obj.error
      : semantic;

    console.log(
      `[civiko-orchestrator-dispatch] action=${action} target=${targetName} status=${res.status}${
        semantic ? ` semantic=${semantic}` : ""
      }`,
    );

    return {
      action,
      target: targetName,
      ok: res.ok && semantic === null,

      status: res.status,
      reason,
      result: safeIdentifiers(payload),
    };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    console.error(
      `[civiko-orchestrator-dispatch] action=${action} failure=${aborted ? "timeout" : "network_error"}`,
    );
    return {
      action,
      target: targetName,
      ok: false,
      status: aborted ? 504 : 502,
      reason: aborted ? "timeout" : "network_error",
      result: {},
    };
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
    : counts.reduce<number>((sum, count) => sum + (count ?? 0), 0);
}


// Metriche reali, raggruppate. Nessun valore dedotto: se una query non è
// verificabile il valore resta null e il gate è fail-closed.
interface GateSpec {
  group: "imported" | "casa_pipeline" | "categories" | "classified_in_window" | "portals";
  metric: string;
  q: string;
}

/** I 4 portali del perimetro Civiko One / Padova. */
const CIVIKO_PORTALS = ["casa", "immobiliare", "idealista", "subito"] as const;

function gateSpecs(since: string): GateSpec[] {
  const casaCtx = `processor_context->>portal=eq.casa.it`;
  const scope = CIVIKO_SCOPE_SLUGS.join(",");
  const offmarketSince = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();
  return [
    // ESECUZIONE SEMANTICA DEI 4 PORTALI NELLA FINESTRA (solo Padova).
    ...CIVIKO_PORTALS.map((p) => ({
      group: "portals" as const,
      metric: `collect_items_${p}_fresh`,
      q:
        `padova_collect_v2_items?select=id&portal=eq.${p}&citta=ilike.padova&or=(created_at.gte.${since},updated_at.gte.${since})`,
    })),

    // PROVA CASA.IT — coda di scraping (provider + processor)
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
    // IMPORTED — padova_listings fonte casa.it
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
    // CATEGORIE REALMENTE VISIBILI DALLA PWA (scope Padova ufficiale).
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
    // CLASSIFICAZIONE IN FINESTRA
    {
      group: "classified_in_window",
      metric: "signals_classified_updated",
      q: `civiko_signals_classified?select=signal_id&updated_at=gte.${since}`,
    },
  ];
}

/** Integrità Civiko One letta dalla vista autoritativa. null = non verificabile. */
interface GateIntegrity {
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
  sync_pwa_dopo_classificazione: boolean;
  contendibili_fuori_perimetro: number;
  privati_fuori_perimetro: number;
}

/**
 * Traccia reale delle pipeline Civiko: il release gate esige un ack PWA
 * successivo alla fine dell'ultima pipeline_0710 riuscita, quindi la fine
 * della pipeline deve essere registrata in modo verificabile.
 */
async function recordPipelineStart(runId: string, pipeline: string): Promise<void> {
  if (!SERVICE_KEY) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/civiko_pipeline_runs`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify([{
        run_id: runId,
        pipeline,
        started_at: new Date().toISOString(),
      }]),
    });
    await res.body?.cancel();
    if (!res.ok) console.error(`[dispatch] pipeline_run start not recorded status=${res.status}`);
  } catch {
    console.error("[dispatch] pipeline_run start not recorded");
  }
}

async function recordPipelineEnd(
  runId: string,
  okRun: boolean,
  steps: StepResult[],
  errorCode: string | null,
): Promise<void> {
  if (!SERVICE_KEY) return;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/civiko_pipeline_runs?run_id=eq.${runId}`,
      {
        method: "PATCH",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          finished_at: new Date().toISOString(),
          ok: okRun,
          error_code: errorCode,
          steps: steps.map((s) => ({
            action: s.action,
            ok: s.ok,
            status: s.status,
            reason: s.reason ?? null,
          })),
        }),
      },
    );
    await res.body?.cancel();
    if (!res.ok) console.error(`[dispatch] pipeline_run end not recorded status=${res.status}`);
  } catch {
    console.error("[dispatch] pipeline_run end not recorded");
  }
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
    const num = (k: string) => Number(r[k] ?? NaN);
    const out: GateIntegrity = {
      portali_freschi: num("portali_freschi"),
      mismatch_professionale: num("mismatch_professionale"),
      listings_freschi: num("listings_freschi"),
      classificazione_ultima: typeof r.classificazione_ultima === "string"
        ? r.classificazione_ultima
        : null,
      recompute_ultimo: typeof r.recompute_ultimo === "string" ? r.recompute_ultimo : null,
      contendibili_totali: num("contendibili_totali"),
      recompute_corrente: r.recompute_corrente === true,
      pipeline_0710_ultimo_ok: typeof r.pipeline_0710_ultimo_ok === "string"
        ? r.pipeline_0710_ultimo_ok
        : null,
      pwa_sync_ack_ultimo_ok: typeof r.pwa_sync_ack_ultimo_ok === "string"
        ? r.pwa_sync_ack_ultimo_ok
        : null,
      pwa_sync_ack_corrente: r.pwa_sync_ack_corrente === true,
      sync_pwa_dopo_classificazione: r.sync_pwa_dopo_classificazione === true,
      contendibili_fuori_perimetro: num("contendibili_fuori_perimetro"),
      privati_fuori_perimetro: num("privati_fuori_perimetro"),
    };
    const numeric: Array<number> = [
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

async function releaseGate() {
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
    // Nessuna sostituzione con zero: la query fallita è tracciata.
    if (count === null) failedQueries.push(s.metric);
  }
  const ribassiCount = await verifiedPriceDropsCount();
  metrics.categories.contendibili_ribassi = ribassiCount;
  if (ribassiCount === null) failedQueries.push("contendibili_ribassi");

  const integrity = await readGateIntegrity();
  if (!integrity) failedQueries.push("release_gate_integrity_view");

  const metricsAvailable = Boolean(SERVICE_KEY) && failedQueries.length === 0 &&
    integrity !== null;

  const g = (group: keyof typeof metrics, metric: string): number =>
    (metrics[group][metric] as number) ?? 0;


  const requirements = metricsAvailable
    ? [
      {
        key: "casa_provider_succeeded",
        passed: g("casa_pipeline", "queue_provider_succeeded") > 0,
      },
      {
        key: "casa_processor_succeeded",
        passed: g("casa_pipeline", "queue_processor_succeeded") > 0,
      },
      {
        key: "casa_processor_no_dead",
        passed: g("casa_pipeline", "queue_processor_dead") === 0,
      },
      {
        key: "casa_collect_fresh",
        passed: g("casa_pipeline", "collect_items_casa_fresh") > 0,
      },
      {
        key: "casa_listing_fresh",
        passed: g("imported", "listings_casa_imported_in_window") > 0 ||
          g("imported", "listings_casa_seen_in_window") > 0,
      },
      {
        key: "pwa_contendibili_non_zero",
        passed: g("categories", "contendibili_total") > 0,
      },
      {
        key: "pwa_multi_agenzia_non_zero",
        passed: g("categories", "contendibili_multi_agenzia") > 0,
      },
      {
        key: "pwa_ribassi_non_zero",
        passed: g("categories", "contendibili_ribassi") > 0,
      },
      {
        key: "pwa_cambi_agenzia_non_zero",
        passed: g("categories", "contendibili_cambio_agenzia") > 0,
      },
      {
        key: "pwa_privati_non_zero",
        passed: g("categories", "privati_padova") > 0,
      },
      {
        key: "pwa_offmarket_non_zero",
        passed: g("categories", "offmarket_verified") > 0,
      },
      // ESECUZIONE SEMANTICA DEI 4 PORTALI NELLA FINESTRA
      ...CIVIKO_PORTALS.map((p) => ({
        key: `portale_${p}_fresh`,
        passed: g("portals", `collect_items_${p}_fresh`) > 0,
      })),
      // PROMOZIONE / CLASSIFICAZIONE CORRENTE
      {
        key: "promozione_corrente",
        passed: (integrity?.listings_freschi ?? 0) > 0,
      },
      {
        key: "mismatch_professionale_zero",
        passed: integrity?.mismatch_professionale === 0,
      },
      // RECOMPUTE CORRENTE E SYNC PWA SUCCESSIVO ALLA CLASSIFICAZIONE
      {
        key: "recompute_corrente",
        passed: integrity?.recompute_corrente === true,
      },
      {
        // Prova diretta: ack PWA ok, corrente, successivo alla fine
        // dell'ultima pipeline_0710 riuscita nella finestra.
        key: "pwa_sync_ack_corrente",
        passed: integrity?.pwa_sync_ack_corrente === true,
      },
      {
        key: "sync_pwa_dopo_classificazione",
        passed: integrity?.sync_pwa_dopo_classificazione === true,
      },
      // PERIMETRO PADOVA / 8 ZONE UFFICIALI
      {
        key: "perimetro_contendibili_padova_8_zone",
        passed: integrity?.contendibili_fuori_perimetro === 0,
      },
      {
        key: "perimetro_privati_padova_8_zone",
        passed: integrity?.privati_fuori_perimetro === 0,
      },
    ]
    : [];

  const gate_passed = metricsAvailable && requirements.every((r) => r.passed);
  const cron_activation_allowed = gate_passed;
  const missing = requirements.filter((r) => !r.passed).map((r) => r.key);

  const payload: Record<string, unknown> = {
    ok: gate_passed,
    action: "release_gate",
    gate_passed,
    cron_activation_allowed,
    metrics_available: metricsAvailable,
    window_hours: GATE_WINDOW_HOURS,
    since,
    metrics,
    integrity,
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
    const gate = await releaseGate();
    return json(gate.status, gate.payload);
  }


  if (action in PIPELINES) {
    const pipeline = PIPELINES[action as PipelineAction];
    const steps: StepResult[] = [];
    let failedAt: string | null = null;
    let budgetExhausted = false;
    const startedAt = Date.now();
    const runId = crypto.randomUUID();
    await recordPipelineStart(runId, action);
    // Sequenziale e fail-closed: si ferma al primo step non ok e comunque
    // entro il budget complessivo (< timeout Replit 180s).
    for (const step of pipeline.steps) {
      const remaining = PIPELINE_BUDGET_MS - (Date.now() - startedAt);
      if (remaining <= STEP_MIN_MS) {
        budgetExhausted = true;
        failedAt = step;
        steps.push({
          action: step,
          target: ALLOWED[step].rpc ? `rpc/${ALLOWED[step].rpc}` : ALLOWED[step].fn,
          ok: false,
          status: 504,
          reason: "pipeline_budget_exhausted",
          result: {},
        });
        break;
      }
      const r = await runAction(step, Math.min(DEFAULT_TIMEOUT_MS, remaining - 1_000));
      steps.push(r);
      if (!r.ok) {
        failedAt = step;
        break;
      }
    }
    const failing = steps.find((s) => !s.ok);
    const status = failedAt === null
      ? 200
      : budgetExhausted
      ? 504
      : failing && failing.status >= 400 && failing.status <= 599
      ? failing.status
      : 502;
    await recordPipelineEnd(
      runId,
      failedAt === null,
      steps,
      failedAt === null ? null : (budgetExhausted ? "BUDGET_EXHAUSTED" : "STEP_FAILED"),
    );
    return json(status, {
      ok: failedAt === null,
      action,
      run_id: runId,
      at: pipeline.at,
      timezone: SCHEDULE_TIMEZONE,
      enabled: CRON_ENABLED,
      failed_at: failedAt,
      failed_reason: failing?.reason ?? null,
      budget_exhausted: budgetExhausted,
      elapsed_ms: Date.now() - startedAt,
      budget_ms: PIPELINE_BUDGET_MS,
      executed: steps.length,
      planned: pipeline.steps.length,
      steps,
    });
  }

  const r = await runAction(action as SimpleAction);
  return json(
    r.ok ? 200 : (r.status >= 400 && r.status <= 599 ? r.status : 502),
    {
      ok: r.ok,
      action,
      target: r.target,
      status: r.status,
      reason: r.reason,
      result: r.result,
    },
  );

});
