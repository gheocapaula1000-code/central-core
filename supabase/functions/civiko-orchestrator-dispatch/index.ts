// civiko-orchestrator-dispatch
// Gateway additivo e isolato per Civiko One e per l'orchestratore Replit.
// Tutti i target, i body e le sequenze sono hardcoded (anti-SSRF).

import { createClient } from "npm:@supabase/supabase-js@2";

const DISPATCH_SECRET =
  Deno.env.get("CIVIKO_ORCHESTRATOR_DISPATCH_SECRET") ?? "";
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MAX_BODY_BYTES = 2048;
const DEFAULT_TIMEOUT_MS = 150_000;
const METRICS_WINDOW_HOURS = 4;

type AtomicAction =
  | "apify_immobiliare"
  | "apify_idealista"
  | "apify_subito"
  | "portal_casa"
  | "collect_pending"
  | "radar_full"
  | "signals_classify"
  | "offmarket_discover"
  | "offmarket_scores"
  | "early_warning";

type Action =
  | "healthcheck"
  | AtomicAction
  | "pipeline_0510"
  | "pipeline_0545"
  | "pipeline_0710"
  | "release_gate";

interface Target {
  fn: string;
  query?: string;
  body: Record<string, unknown>;
}

const ALLOWED: Record<AtomicAction, Target> = {
  apify_immobiliare: { fn: "cron-apify-immobiliare-nightly", body: {} },
  apify_idealista: { fn: "cron-apify-idealista-nightly", body: {} },
  apify_subito: { fn: "cron-apify-subito-nightly", body: {} },
  portal_casa: {
    fn: "enqueue-padova-portal-scrapes",
    body: { mode: "full", portals: ["casa.it"], max_pages: 30 },
  },
  collect_pending: {
    fn: "padova-apify-collect-pending",
    body: { stale_minutes: 5, max_runs: 10 },
  },
  radar_full: {
    fn: "cron-radar-padova-nightly",
    query: "mode=full&force=1",
    body: {},
  },
  signals_classify: {
    fn: "civiko-signals-classify",
    body: { dry_run: false, limit_per_source: 2000 },
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
};

// Europe/Rome è configurato nel job Replit. Qui restano solo le sequenze:
// il gateway non crea né abilita cron.
const PIPELINES: Record<
  "pipeline_0510" | "pipeline_0545" | "pipeline_0710",
  readonly AtomicAction[]
> = {
  pipeline_0510: [
    "apify_immobiliare",
    "apify_idealista",
    "portal_casa",
    "apify_subito",
  ],
  pipeline_0545: ["collect_pending", "radar_full", "signals_classify"],
  pipeline_0710: ["offmarket_discover", "offmarket_scores", "early_warning"],
};

const ACTIONS = [
  "healthcheck",
  ...Object.keys(ALLOWED),
  ...Object.keys(PIPELINES),
  "release_gate",
] as const;

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
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function safeIdentifiers(raw: unknown): Record<string, unknown> {
  if (!isObject(raw)) return {};
  const scalarKeys = [
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
    "written",
    "radar_signals_written",
    "triggered_at",
    "duration_ms",
  ];
  const out: Record<string, unknown> = {};
  for (const k of scalarKeys) {
    const v = raw[k];
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    )
      out[k] = v;
  }
  if (Array.isArray(raw.enqueued)) out.enqueued_count = raw.enqueued.length;
  if (Array.isArray(raw.warnings)) out.warnings_count = raw.warnings.length;
  for (const k of [
    "processed_by_source",
    "sensitivity_breakdown",
    "usable_breakdown",
  ]) {
    if (!isObject(raw[k])) continue;
    const clean: Record<string, number> = {};
    for (const [name, value] of Object.entries(
      raw[k] as Record<string, unknown>,
    )) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        clean[name] = value;
    }
    out[k] = clean;
  }
  return out;
}

interface StepResult {
  action: AtomicAction;
  target: string;
  ok: boolean;
  status: number;
  reason: string | null;
  result: Record<string, unknown>;
}

async function runTarget(action: AtomicAction): Promise<StepResult> {
  const target = ALLOWED[action];
  const url = `${SUPABASE_URL}/functions/v1/${target.fn}${target.query ? `?${target.query}` : ""}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-job-secret": JOB_SECRET,
      },
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
    const payloadOk = !isObject(payload) || payload.ok !== false;
    const ok = res.ok && payloadOk;
    const reason =
      isObject(payload) && typeof payload.reason === "string"
        ? payload.reason
        : isObject(payload) && typeof payload.error === "string"
          ? payload.error
          : ok
            ? null
            : `http_${res.status}`;
    console.log(
      `[civiko-orchestrator-dispatch] action=${action} target=${target.fn} status=${res.status} ok=${ok}`,
    );
    return {
      action,
      target: target.fn,
      ok,
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
      target: target.fn,
      ok: false,
      status: aborted ? 504 : 502,
      reason: aborted ? "timeout" : "network_error",
      result: {},
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runPipeline(action: keyof typeof PIPELINES): Promise<Response> {
  const startedAt = new Date().toISOString();
  const steps: StepResult[] = [];
  for (const step of PIPELINES[action]) {
    const result = await runTarget(step);
    steps.push(result);
    if (!result.ok) {
      return json(502, {
        ok: false,
        action,
        fail_closed: true,
        failed_step: step,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        steps,
      });
    }
  }
  return json(200, {
    ok: true,
    action,
    fail_closed: true,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    steps,
  });
}

async function releaseGate(): Promise<Response> {
  if (!SERVICE_KEY) return json(500, { ok: false, error: "misconfigured" });
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });
  const since = new Date(
    Date.now() - METRICS_WINDOW_HOURS * 3_600_000,
  ).toISOString();

  async function count(
    label: string,
    query: PromiseLike<{
      count: number | null;
      error: { message?: string } | null;
    }>,
  ) {
    const { count: value, error } = await query;
    if (error) throw new Error(`metric_failed:${label}`);
    return value ?? 0;
  }

  try {
    const [
      listingsTotal,
      casaTotal,
      casaImportedFresh,
      casaSeenFresh,
      privati,
      contendibili,
      hot3,
      ribassi,
      cambiAgenzia,
      offmarketPromoted,
      classifiedFresh,
      casaQueueSucceeded,
      casaProcessingSucceeded,
      casaProcessingDead,
    ] = await Promise.all([
      count(
        "listings_total",
        sb.from("padova_listings").select("id", { count: "exact", head: true }),
      ),
      count(
        "casa_total",
        sb
          .from("padova_listings")
          .select("id", { count: "exact", head: true })
          .eq("fonte", "casa.it"),
      ),
      count(
        "casa_imported_fresh",
        sb
          .from("padova_listings")
          .select("id", { count: "exact", head: true })
          .eq("fonte", "casa.it")
          .gte("imported_at", since),
      ),
      count(
        "casa_seen_fresh",
        sb
          .from("padova_listings")
          .select("id", { count: "exact", head: true })
          .eq("fonte", "casa.it")
          .gte("last_seen_at", since),
      ),
      count(
        "privati",
        sb
          .from("padova_listings")
          .select("id", { count: "exact", head: true })
          .eq("comune", "Padova")
          .eq("tipo_lead", "PRIVATO"),
      ),
      count(
        "contendibili",
        sb
          .from("padova_contendibili")
          .select("id", { count: "exact", head: true }),
      ),
      count(
        "hot3",
        sb
          .from("padova_contendibili")
          .select("id", { count: "exact", head: true })
          .gte("n_agenzie", 3),
      ),
      count(
        "ribassi",
        sb
          .from("padova_contendibili")
          .select("id", { count: "exact", head: true })
          .gt("n_ribassi", 0),
      ),
      count(
        "cambi_agenzia",
        sb
          .from("padova_contendibili")
          .select("id", { count: "exact", head: true })
          .eq("cambio_agenzia", true),
      ),
      count(
        "offmarket_promoted",
        sb
          .from("early_offmarket_signal_candidates")
          .select("id", { count: "exact", head: true })
          .eq("status", "promoted"),
      ),
      count(
        "classified_fresh",
        sb
          .from("civiko_signals_classified")
          .select("id", { count: "exact", head: true })
          .gte("updated_at", since),
      ),
      count(
        "casa_queue_succeeded",
        sb
          .from("scraping_queue")
          .select("id", { count: "exact", head: true })
          .contains("processor_context", { portal: "casa.it" })
          .gte("created_at", since)
          .eq("status", "succeeded"),
      ),
      count(
        "casa_processing_succeeded",
        sb
          .from("scraping_queue")
          .select("id", { count: "exact", head: true })
          .contains("processor_context", { portal: "casa.it" })
          .gte("created_at", since)
          .eq("processing_status", "succeeded"),
      ),
      count(
        "casa_processing_dead",
        sb
          .from("scraping_queue")
          .select("id", { count: "exact", head: true })
          .contains("processor_context", { portal: "casa.it" })
          .gte("created_at", since)
          .eq("processing_status", "dead"),
      ),
    ]);

    const categoriesEffective =
      contendibili + privati + ribassi + cambiAgenzia + offmarketPromoted;
    const gatePassed =
      casaQueueSucceeded > 0 &&
      casaProcessingSucceeded > 0 &&
      casaProcessingDead === 0 &&
      (casaImportedFresh > 0 || casaSeenFresh > 0) &&
      categoriesEffective > 0;

    const payload = {
      ok: gatePassed,
      action: "release_gate",
      fail_closed: true,
      gate_passed: gatePassed,
      window_hours: METRICS_WINDOW_HOURS,
      window_started_at: since,
      metrics: {
        imported: {
          listings_total: listingsTotal,
          casa_total: casaTotal,
          casa_imported_in_window: casaImportedFresh,
          casa_seen_in_window: casaSeenFresh,
        },
        casa_pipeline: {
          provider_succeeded_in_window: casaQueueSucceeded,
          processor_succeeded_in_window: casaProcessingSucceeded,
          processor_dead_in_window: casaProcessingDead,
        },
        categories: {
          contendibili,
          contendibili_3plus: hot3,
          privati,
          ribassi,
          cambi_agenzia: cambiAgenzia,
          offmarket_promossi: offmarketPromoted,
          effective_total: categoriesEffective,
        },
        classified_in_window: classifiedFresh,
      },
      cron_activation_allowed: gatePassed,
      checked_at: new Date().toISOString(),
    };
    return json(gatePassed ? 200 : 409, payload);
  } catch (e) {
    console.error(
      `[civiko-orchestrator-dispatch] release_gate failure=${e instanceof Error ? e.message.split(":")[0] : "metrics_error"}`,
    );
    return json(502, {
      ok: false,
      action: "release_gate",
      fail_closed: true,
      gate_passed: false,
      cron_activation_allowed: false,
      error: "metrics_unavailable",
    });
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST")
    return json(405, { ok: false, error: "method_not_allowed" });
  if (!DISPATCH_SECRET) {
    console.error("[civiko-orchestrator-dispatch] misconfigured");
    return json(500, { ok: false, error: "misconfigured" });
  }

  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || !timingSafeEqual(bearer, DISPATCH_SECRET))
    return json(401, { ok: false, error: "unauthorized" });

  const ctype = req.headers.get("Content-Type") ?? "";
  if (!ctype.toLowerCase().includes("application/json"))
    return json(415, { ok: false, error: "unsupported_media_type" });

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES)
    return json(413, { ok: false, error: "payload_too_large" });
  let parsed: unknown;
  try {
    parsed = rawBody.trim() ? JSON.parse(rawBody) : {};
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }
  if (!isObject(parsed))
    return json(400, { ok: false, error: "invalid_payload" });

  const action = parsed.action;
  if (
    typeof action !== "string" ||
    !(ACTIONS as readonly string[]).includes(action)
  ) {
    return json(400, {
      ok: false,
      error: "action_not_allowed",
      allowed: ACTIONS,
    });
  }

  if (action === "healthcheck") {
    return json(200, {
      ok: Boolean(DISPATCH_SECRET && JOB_SECRET && SUPABASE_URL && SERVICE_KEY),
      action: "healthcheck",
      config: {
        dispatch_secret: Boolean(DISPATCH_SECRET),
        job_secret: Boolean(JOB_SECRET),
        supabase_url: Boolean(SUPABASE_URL),
        service_role: Boolean(SERVICE_KEY),
      },
      schedule_contract: {
        timezone: "Europe/Rome",
        times: ["05:10", "05:45", "07:10"],
        enabled: false,
      },
      checked_at: new Date().toISOString(),
    });
  }

  if (!JOB_SECRET || !SUPABASE_URL) {
    console.error("[civiko-orchestrator-dispatch] misconfigured");
    return json(500, { ok: false, error: "misconfigured" });
  }

  if (action === "release_gate") return await releaseGate();
  if (action in PIPELINES)
    return await runPipeline(action as keyof typeof PIPELINES);

  const result = await runTarget(action as AtomicAction);
  return json(result.ok ? 200 : 502, { ok: result.ok, action, ...result });
});
