// Cron wrapper: triggers /civiko-radar-veneto/agent-radar with full intent for PD comuni.
// Invoked by pg_cron nightly at 03:00 UTC (05:00 Rome).
// Design:
//  - Risponde subito a pg_net per evitare timeout 5s e poter loggare la fine via REST.
//  - Esegue l'ingestion in background con EdgeRuntime.waitUntil.
//  - Audita su public.cron_executions_log usando le colonne reali
//    (triggered_at, completed_at, status, http_status, response_excerpt, error_message, duration_ms).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
const JOB_NAME = "central-core-radar-padova-nightly-full";

const COMUNI = [
  "Padova",
  "Rubano",
  "Albignasego",
  "Cadoneghe",
  "Selvazzano Dentro",
  "Ponte San Nicolò",
  "Abano Terme",
];

async function logExecution(row: {
  triggered_at: string;
  completed_at: string;
  status: "success" | "error" | "partial";
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
  } catch (e) {
    console.warn("[cron-radar-padova-nightly] logExecution failed:", e instanceof Error ? e.message : String(e));
  }
}

async function runOneComune(comune: string, triggeredAt: string): Promise<{
  comune: string;
  ok: boolean;
  http_status: number | null;
  duration_ms: number;
  excerpt: string;
  error?: string;
}> {
  const t0 = Date.now();
  const target = `${SUPABASE_URL}/functions/v1/civiko-radar-veneto/agent-radar`;
  const body = {
    scope: "global",
    intent: "full",
    province: ["PD"],
    comuni: [comune],
    triggered_by: "cron-nightly",
    admin_global: true,
    ignore_workspace_filters: true,
    ignore_agency_filters: true,
    ignore_operating_area_filters: true,
    ignore_zone_filters: true,
    min_agencies: 1,
    limit: 200,
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 240_000); // 4 min per comune
    const res = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-job-secret": JOB_SECRET,
        "x-internal-secret": JOB_SECRET,
        "x-source-app": "central-core-cron",
        Authorization: `Bearer ${JOB_SECRET}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    const dur = Date.now() - t0;
    const excerpt = text.slice(0, 600);
    await logExecution({
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: res.ok ? "success" : "error",
      http_status: res.status,
      response_excerpt: `[${comune}] ${excerpt}`,
      error_message: res.ok ? null : `HTTP ${res.status}`,
      duration_ms: dur,
    });
    return { comune, ok: res.ok, http_status: res.status, duration_ms: dur, excerpt };
  } catch (err) {
    const dur = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    await logExecution({
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: "error",
      http_status: null,
      response_excerpt: null,
      error_message: `[${comune}] ${msg}`,
      duration_ms: dur,
    });
    return { comune, ok: false, http_status: null, duration_ms: dur, excerpt: "", error: msg };
  }
}

async function runAll(triggeredAt: string) {
  const results: Awaited<ReturnType<typeof runOneComune>>[] = [];
  // Sequenziale per stare nei cap budget (Firecrawl/Apify) e non saturare i portali.
  for (const c of COMUNI) {
    const r = await runOneComune(c, triggeredAt);
    results.push(r);
  }
  const okCount = results.filter((r) => r.ok).length;
  const totalDur = results.reduce((s, r) => s + r.duration_ms, 0);
  await logExecution({
    triggered_at: triggeredAt,
    completed_at: new Date().toISOString(),
    status: okCount === COMUNI.length ? "success" : okCount === 0 ? "error" : "partial",
    http_status: 200,
    response_excerpt: `SUMMARY ok=${okCount}/${COMUNI.length} ` +
      results.map((r) => `${r.comune}:${r.ok ? "ok" : "fail"}`).join(","),
    error_message: null,
    duration_ms: totalDur,
  });
}

Deno.serve(async (req) => {
  const triggeredAt = new Date().toISOString();
  if (!JOB_SECRET) {
    return new Response(
      JSON.stringify({ ok: false, error: "CENTRAL_CORE_JOB_SECRET missing" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Idempotency: se è già in esecuzione un run negli ultimi 10 min, evita doppio start.
  try {
    const recent = await fetch(
      `${SUPABASE_URL}/rest/v1/cron_executions_log?job_name=eq.${JOB_NAME}&completed_at=is.null&triggered_at=gte.${new Date(Date.now() - 10 * 60_000).toISOString()}&select=id&limit=1`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    if (recent.ok) {
      const arr = await recent.json().catch(() => []);
      if (Array.isArray(arr) && arr.length > 0) {
        return new Response(
          JSON.stringify({ ok: true, skipped: "in_flight_run_recent" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }
  } catch { /* best effort */ }

  // Audit: riga "start" senza completed_at (idempotency check sopra)
  await logExecution({
    triggered_at: triggeredAt,
    completed_at: new Date().toISOString(),
    status: "success",
    http_status: 202,
    response_excerpt: `started comuni=${COMUNI.length}`,
    error_message: null,
    duration_ms: 0,
  });

  // Manual mode (debug): aspetta la fine se ?wait=1
  const url = new URL(req.url);
  const wait = url.searchParams.get("wait") === "1";
  if (wait) {
    await runAll(triggeredAt);
    return new Response(JSON.stringify({ ok: true, mode: "sync", triggered_at: triggeredAt }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Background: rispondi subito per evitare pg_net 5s timeout
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") {
    rt.waitUntil(runAll(triggeredAt));
  } else {
    // Fallback: fire-and-forget
    runAll(triggeredAt).catch((e) => console.error("[cron-radar-padova-nightly] bg error:", e));
  }

  return new Response(
    JSON.stringify({ ok: true, mode: "async", triggered_at: triggeredAt, comuni: COMUNI }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  );
});
