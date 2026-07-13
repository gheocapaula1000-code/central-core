// Cron wrapper: triggers /civiko-radar-veneto/agent-radar with full intent for PD comuni.
// Invoked by pg_cron nightly at 03:00 UTC (05:00 Rome).
// Design:
//  - Esegue l'ingestion in modo sincrono: niente EdgeRuntime.waitUntil.
//  - La function risponde più lentamente, ma il completamento viene garantito
//    e tracciato su public.cron_executions_log.
//  - Audita su public.cron_executions_log usando le colonne reali
//    (triggered_at, completed_at, status, http_status, response_excerpt, error_message, duration_ms).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
const JOB_NAME_FULL = "central-core-radar-padova-nightly-full";
const JOB_NAME_SOFT = "central-core-radar-padova-soft";

// Scope vendibile: SOLO Padova Comune (22 zone OMI ufficiali).
// I comuni limitrofi (Rubano, Albignasego, Cadoneghe, Selvazzano, Ponte San
// Nicolò, Abano Terme) NON sono più target del radar Central Core.
const COMUNI = ["Padova"];

async function logExecution(jobName: string, row: {
  triggered_at: string;
  completed_at: string;
  status: "started" | "success" | "failure" | "error" | "success_no_rows";
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
      body: JSON.stringify({ job_name: jobName, ...row }),
    });
  } catch (e) {
    console.warn(`[${jobName}] logExecution failed:`, e instanceof Error ? e.message : String(e));
  }
}

type Mode = "soft" | "full";

async function runOneComune(comune: string, triggeredAt: string, mode: Mode, jobName: string): Promise<{
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
    intent: mode, // "soft" | "full"
    province: ["PD"],
    comuni: [comune],
    triggered_by: `cron-${mode}`,
    admin_global: true,
    ignore_workspace_filters: true,
    ignore_agency_filters: true,
    ignore_operating_area_filters: true,
    ignore_zone_filters: true,
    min_agencies: 1,
    limit: mode === "full" ? 200 : 80,
  };
  try {
    const ctrl = new AbortController();
    // full: 4 min per comune; soft: 2 min
    const perComuneTimeout = mode === "full" ? 240_000 : 120_000;
    const timer = setTimeout(() => ctrl.abort(), perComuneTimeout);
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
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw excerpt */ }
    const resultSummary = parsed?.result_summary ?? parsed?.data?.result_summary ?? parsed?.diagnostics?.result_summary ?? null;
    const warningsArr: string[] = Array.isArray(resultSummary?.warnings) ? resultSummary.warnings : [];
    const recomputeDeferred = warningsArr.includes("padova_contendibili_recompute_deferred_to_pg_cron");
    const noRealIngestion = !!resultSummary?.ingestion_requested && (
      resultSummary.ingestion_executed !== true ||
      Number(resultSummary.raw_items_found ?? 0) === 0 ||
      (Number(resultSummary.collect_items_created ?? 0) + Number(resultSummary.collect_items_updated ?? 0)) === 0 ||
      (resultSummary.contendibili_recomputed !== true && !recomputeDeferred)
    );
    const excerpt = resultSummary
      ? `result_summary=${JSON.stringify(resultSummary).slice(0, 1600)}`
      : text.slice(0, 600);
    await logExecution(jobName, {
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: res.ok ? (noRealIngestion ? "failure" : "success") : "failure",
      http_status: res.status,
      response_excerpt: `[${comune}] ${excerpt}`,
      error_message: res.ok ? (noRealIngestion ? "ingestion_incomplete_or_no_new_collect_writes" : null) : `HTTP ${res.status}`,
      duration_ms: dur,
    });
    return { comune, ok: res.ok && !noRealIngestion, http_status: res.status, duration_ms: dur, excerpt, error: noRealIngestion ? "ingestion_incomplete_or_no_new_collect_writes" : undefined };
  } catch (err) {
    const dur = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    await logExecution(jobName, {
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: "failure",
      http_status: null,
      response_excerpt: null,
      error_message: `[${comune}] ${msg}`,
      duration_ms: dur,
    });
    return { comune, ok: false, http_status: null, duration_ms: dur, excerpt: "", error: msg };
  }
}

async function runAll(triggeredAt: string, mode: Mode, jobName: string) {
  const results: Awaited<ReturnType<typeof runOneComune>>[] = [];
  // Sequenziale per stare nei cap budget (Firecrawl/Apify) e non saturare i portali.
  for (const c of COMUNI) {
    const r = await runOneComune(c, triggeredAt, mode, jobName);
    results.push(r);
  }
  const okCount = results.filter((r) => r.ok).length;
  const totalDur = results.reduce((s, r) => s + r.duration_ms, 0);
  await logExecution(jobName, {
    triggered_at: triggeredAt,
    completed_at: new Date().toISOString(),
    status: okCount === COMUNI.length ? "success" : "failure",
    http_status: 200,
    response_excerpt: `SUMMARY mode=${mode} ok=${okCount}/${COMUNI.length} ` +
      results.map((r) => `${r.comune}:${r.ok ? "ok" : "fail"}`).join(","),
    error_message: null,
    duration_ms: totalDur,
  });
}

Deno.serve(async (req) => {
  const triggeredAt = new Date().toISOString();
  const t0 = Date.now();
  const url = new URL(req.url);
  const mode: Mode = (url.searchParams.get("mode") === "soft" ? "soft" : "full");
  const jobName = mode === "soft" ? JOB_NAME_SOFT : JOB_NAME_FULL;

  try {
    if (!JOB_SECRET) {
      await logExecution(jobName, {
        triggered_at: triggeredAt,
        completed_at: new Date().toISOString(),
        status: "error",
        http_status: 500,
        response_excerpt: null,
        error_message: "CENTRAL_CORE_JOB_SECRET missing",
        duration_ms: Date.now() - t0,
      });
      return new Response(
        JSON.stringify({ ok: false, error: "CENTRAL_CORE_JOB_SECRET missing" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    // Idempotency: se è già in esecuzione un run negli ultimi 10 min, evita doppio start.
    try {
      const recent = await fetch(
        `${SUPABASE_URL}/rest/v1/cron_executions_log?job_name=eq.${jobName}&triggered_at=gte.${new Date(Date.now() - 10 * 60_000).toISOString()}&select=id&limit=1`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
      );
      if (recent.ok) {
        const arr = await recent.json().catch(() => []);
        if (Array.isArray(arr) && arr.length > 0 && url.searchParams.get("force") !== "1") {
          return new Response(
            JSON.stringify({ ok: true, skipped: "in_flight_run_recent", job: jobName }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
      }
    } catch { /* best effort */ }

    // Audit: riga "start"
    await logExecution(jobName, {
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: "started",
      http_status: 202,
      response_excerpt: `started mode=${mode} comuni=${COMUNI.length}`,
      error_message: null,
      duration_ms: 0,
    });

    await runAll(triggeredAt, mode, jobName);

    // Verifica se il run ha effettivamente prodotto scritture su radar_signals
    // dall'inizio dell'invocazione. Best-effort: non fallisce il run se la
    // query non risponde.
    let rowsWritten: number | null = null;
    try {
      const countRes = await fetch(
        `${SUPABASE_URL}/rest/v1/radar_signals?created_at=gte.${triggeredAt}&select=id`,
        {
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            Prefer: "count=exact",
            Range: "0-0",
          },
        },
      );
      if (countRes.ok) {
        const cr = countRes.headers.get("content-range") ?? "";
        const m = cr.match(/\/(\d+)$/);
        rowsWritten = m ? Number(m[1]) : null;
      }
    } catch { /* best effort */ }

    if (rowsWritten === 0) {
      await logExecution(jobName, {
        triggered_at: triggeredAt,
        completed_at: new Date().toISOString(),
        status: "success_no_rows",
        http_status: 200,
        response_excerpt: `mode=${mode} radar_signals_written=0 comuni=${COMUNI.length}`,
        error_message: null,
        duration_ms: Date.now() - t0,
      });
    }

    return new Response(
      JSON.stringify({
        ok: true,
        mode: "sync",
        run_mode: mode,
        job: jobName,
        triggered_at: triggeredAt,
        comuni: COMUNI,
        radar_signals_written: rowsWritten,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : "";
    const full = `${message}${stack ? `\n${stack}` : ""}`.slice(0, 2000);
    try {
      await logExecution(jobName, {
        triggered_at: triggeredAt,
        completed_at: new Date().toISOString(),
        status: "error",
        http_status: 500,
        response_excerpt: null,
        error_message: full,
        duration_ms: Date.now() - t0,
      });
    } catch { /* logging best effort */ }
    return new Response(
      JSON.stringify({ ok: false, error: message, job: jobName, mode }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
