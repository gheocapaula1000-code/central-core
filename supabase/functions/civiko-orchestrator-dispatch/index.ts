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
const DEFAULT_TIMEOUT_MS = 150_000;
const GATE_TIMEOUT_MS = 15_000;

type SimpleAction =
  | "apify_immobiliare"
  | "apify_idealista"
  | "apify_subito"
  | "portal_casa"
  | "collect_pending"
  | "offmarket_discover"
  | "offmarket_scores"
  | "early_warning"
  | "radar_full"
  | "signals_classify";

type PipelineAction = "pipeline_0510" | "pipeline_0545" | "pipeline_0710";

type Action = "healthcheck" | "release_gate" | SimpleAction | PipelineAction;

interface Target {
  // Solo nome funzione + query hardcoded: nessun URL o path arbitrario dal client.
  fn: string;
  query?: string;
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

// Pipeline sequenziali e fail-closed. Solo azioni dell'allowlist.
const PIPELINES: Record<PipelineAction, { at: string; steps: SimpleAction[] }> = {
  // 05:10 Europe/Rome — raccolta portali (Casa.it multipagina + Apify).
  pipeline_0510: {
    at: "05:10",
    steps: ["portal_casa", "apify_immobiliare", "apify_idealista", "apify_subito"],
  },
  // 05:45 Europe/Rome — raccolta risultati e radar.
  pipeline_0545: {
    at: "05:45",
    steps: ["collect_pending", "radar_full"],
  },
  // 07:10 Europe/Rome — segnali off-market e classificazione.
  pipeline_0710: {
    at: "07:10",
    steps: ["offmarket_discover", "offmarket_scores", "early_warning", "signals_classify"],
  },
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

function scheduleContract() {
  return {
    timezone: SCHEDULE_TIMEZONE,
    enabled: CRON_ENABLED,
    pipelines: (Object.keys(PIPELINES) as PipelineAction[]).map((k) => ({
      action: k,
      at: PIPELINES[k].at,
      steps: PIPELINES[k].steps,
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

interface StepResult {
  action: SimpleAction;
  target: string;
  ok: boolean;
  status: number;
  reason: string | null;
  result: Record<string, unknown>;
}

async function runAction(action: SimpleAction): Promise<StepResult> {
  const target = ALLOWED[action];
  const url = `${SUPABASE_URL}/functions/v1/${target.fn}${target.query ? `?${target.query}` : ""}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    // Nessun retry interno: gestito dall'orchestratore.
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
    const obj = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    const reason = obj && typeof obj.reason === "string"
      ? obj.reason
      : obj && typeof obj.error === "string"
      ? obj.error
      : null;

    console.log(
      `[civiko-orchestrator-dispatch] action=${action} target=${target.fn} status=${res.status}`,
    );

    return {
      action,
      target: target.fn,
      ok: res.ok && (obj?.ok !== false),
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

interface GateCheck {
  metric: string;
  count: number | null;
  min_required: number;
  passed: boolean;
}

async function releaseGate() {
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const specs: Array<{ metric: string; q: string; min: number }> = [
    {
      metric: "collect_items_24h",
      q: `padova_collect_v2_items?select=id&created_at=gte.${since}`,
      min: 10,
    },
    {
      metric: "casa_items_24h",
      q: `padova_collect_v2_items?select=id&created_at=gte.${since}&portal=eq.casa.it`,
      min: 1,
    },
    {
      metric: "listings_seen_24h",
      q: `padova_listings?select=id&last_seen_at=gte.${since}`,
      min: 10,
    },
    {
      metric: "signals_classified_24h",
      q: `civiko_signals_classified?select=signal_id&created_at=gte.${since}`,
      min: 1,
    },
  ];

  const checks: GateCheck[] = [];
  for (const s of specs) {
    const count = await realCount(s.q);
    checks.push({
      metric: s.metric,
      count,
      min_required: s.min,
      // Fail-closed: count null (non verificabile) => non passa.
      passed: typeof count === "number" && count >= s.min,
    });
  }

  const allPassed = checks.length > 0 && checks.every((c) => c.passed);
  const cron_activation_allowed = Boolean(SERVICE_KEY) && allPassed;

  return {
    ok: true,
    action: "release_gate",
    cron_activation_allowed,
    evidence_sufficient: cron_activation_allowed,
    window_hours: 24,
    since,
    checks,
    schedule: scheduleContract(),
    checked_at: new Date().toISOString(),
  };
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
    return json(200, await releaseGate());
  }

  if (action in PIPELINES) {
    const pipeline = PIPELINES[action as PipelineAction];
    const steps: StepResult[] = [];
    let failedAt: string | null = null;
    // Sequenziale e fail-closed: si ferma al primo step non ok.
    for (const step of pipeline.steps) {
      const r = await runAction(step);
      steps.push(r);
      if (!r.ok) {
        failedAt = step;
        break;
      }
    }
    return json(200, {
      ok: failedAt === null,
      action,
      at: pipeline.at,
      timezone: SCHEDULE_TIMEZONE,
      enabled: CRON_ENABLED,
      failed_at: failedAt,
      executed: steps.length,
      planned: pipeline.steps.length,
      steps,
    });
  }

  const r = await runAction(action as SimpleAction);
  return json(200, {
    ok: r.ok,
    action,
    target: r.target,
    status: r.status,
    reason: r.reason,
    result: r.result,
  });
});
