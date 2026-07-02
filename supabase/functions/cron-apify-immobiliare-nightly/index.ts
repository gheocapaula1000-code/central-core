// Cron wrapper: invoca padova-apify-immobiliare-collect passando x-job-secret
// dall'env. Chiamato ogni notte alle 03:10 UTC (tra il nightly-full casa.it
// alle 03:00 e il recompute contendibili alle 03:15) e usabile anche come
// entrypoint manuale (accetta override via body).
//
// Body opzionale:
//   { max_urls_from_db?: number, max_items?: number, wait_seconds?: number, dry_run?: boolean, start_urls?: string[] }
//
// Auth: nessuna (verify_jwt=false, no x-job-secret richiesto sul wrapper).
// Il segreto è iniettato server-side verso la funzione target.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
const JOB_NAME = "central-core-apify-immobiliare-nightly";
const TARGET = `${SUPABASE_URL}/functions/v1/padova-apify-immobiliare-collect`;

async function logExecution(row: {
  triggered_at: string;
  completed_at: string;
  status: "started" | "success" | "failure";
  http_status: number | null;
  response_excerpt?: string | null;
  error_message?: string | null;
  duration_ms: number;
}) {
  if (!SERVICE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/cron_executions_log`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ job_name: JOB_NAME, ...row }),
    });
  } catch (_) { /* best effort */ }
}

Deno.serve(async (req) => {
  const triggeredAt = new Date().toISOString();
  if (!JOB_SECRET) {
    return new Response(
      JSON.stringify({ ok: false, error: "CENTRAL_CORE_JOB_SECRET missing" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  let overrides: Record<string, unknown> = {};
  try { overrides = await req.json(); } catch { /* body vuoto ok */ }

  const DEFAULT_SEARCH_URLS = [
    "https://www.immobiliare.it/vendita-case/padova/",
  ];

  const body = {
    mode: "mixed",
    desired_results: 100,          // hint azzouzana per Pass A
    max_items: 200,                // cap Pass B (detail-by-URL sui NEW)
    search_urls: DEFAULT_SEARCH_URLS,
    refresh_urls: [] as string[],
    wait_seconds: 300,
    dry_run: false,
    async_start: true,
    ...overrides,
  };


  await logExecution({
    triggered_at: triggeredAt,
    completed_at: new Date().toISOString(),
    status: "started",
    http_status: 202,
    response_excerpt: `started ${JSON.stringify(body).slice(0, 300)}`,
    duration_ms: 0,
  });

  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 330_000);
    const res = await fetch(TARGET, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-job-secret": JOB_SECRET,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    const dur = Date.now() - t0;
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
    await logExecution({
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: res.ok ? "success" : "failure",
      http_status: res.status,
      response_excerpt: text.slice(0, 1500),
      error_message: res.ok ? null : `HTTP ${res.status}`,
      duration_ms: dur,
    });
    return new Response(
      JSON.stringify({ ok: res.ok, http_status: res.status, duration_ms: dur, result: parsed ?? text }, null, 2),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const dur = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    await logExecution({
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: "failure",
      http_status: null,
      error_message: msg,
      duration_ms: dur,
    });
    return new Response(
      JSON.stringify({ ok: false, error: msg, duration_ms: dur }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
