// Cron wrapper: invoca padova-apify-idealista-collect passando x-job-secret
// dall'env. Chiamato ogni notte alle 03:12 UTC (tra immobiliare 03:10 e
// recompute contendibili 03:15). Default: mode="mixed" (discovery+refresh).
//
// Body opzionale (override):
//   { mode?, desired_results?, max_urls_from_db?, max_items?, wait_seconds?, dry_run?, discovery_urls?, refresh_urls?, refresh_stale_days? }

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
const JOB_NAME = "central-core-apify-idealista-nightly";
const TARGET = `${SUPABASE_URL}/functions/v1/padova-apify-idealista-collect`;

function safeEqual(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

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
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } });
  }
  if (!JOB_SECRET) {
    return new Response(
      JSON.stringify({ ok: false, error: "CENTRAL_CORE_JOB_SECRET missing" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!safeEqual(req.headers.get("x-job-secret") ?? "", JOB_SECRET)) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } });
  }

  let overrides: Record<string, unknown> = {};
  try { overrides = await req.json(); } catch { /* body vuoto ok */ }

  const body = {
    mode: "mixed",
    desired_results: 200,
    max_urls_from_db: 200,
    max_items: 400,
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
    const timer = setTimeout(() => ctrl.abort(), 35_000);
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
    const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
    const errors = Array.isArray(obj?.errors) ? obj.errors as unknown[] : [];
    const hasRun = typeof obj?.run_id === "string" && obj.run_id.length > 0;
    const skipped = obj?.skipped === true ||
      (typeof obj?.skipped === "string" && obj.skipped.trim() !== "");
    const semanticOk = res.ok && obj?.ok !== false && !obj?.error &&
      !skipped && hasRun && errors.length === 0;
    await logExecution({
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: semanticOk ? "success" : "failure",
      http_status: res.status,
      response_excerpt: text.slice(0, 1500),
      error_message: semanticOk ? null : (res.ok ? "downstream_semantic_failure" : `HTTP ${res.status}`),
      duration_ms: dur,
    });
    return new Response(
      JSON.stringify({ ok: semanticOk, http_status: res.status, duration_ms: dur,
        started_count: hasRun ? 1 : 0, errors_count: errors.length, result: parsed ?? null }, null, 2),
      { status: semanticOk ? 200 : (res.ok ? 502 : res.status), headers: { "Content-Type": "application/json" } },
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
