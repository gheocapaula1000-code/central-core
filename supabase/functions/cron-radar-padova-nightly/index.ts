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

function safeEqual(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

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

// Contratto di esito del wrapper.
// /agent-radar è read-only: le scritture su radar_signals appartengono ad altri
// job. `radarSignalsWritten` resta quindi pura telemetria (0 o null ammessi) e
// solo un fallimento downstream reale produce 502.
export function evaluateRunOutcome(
  summaryOk: boolean,
  radarSignalsWritten: number | null,
): { ok: boolean; error: string | null; radar_signals_written: number | null } {
  if (!summaryOk) {
    return { ok: false, error: "radar_downstream_failure", radar_signals_written: radarSignalsWritten };
  }
  return { ok: true, error: null, radar_signals_written: radarSignalsWritten };
}

type Mode = "soft" | "full";


async function runOneComune(comune: string, triggeredAt: string, mode: Mode, jobName: string): Promise<{
  comune: string;
  ok: boolean;
  http_status: number | null;
  duration_ms: number;
  excerpt: string;
  error?: string;
  result_status: "success" | "partial_failure" | "provider_failed";
}> {
  const t0 = Date.now();
  const target = `${SUPABASE_URL}/functions/v1/civiko-radar-veneto/agent-radar`;
  const body = {
    scope: "global",
    intent: mode,
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

  // Un solo tentativo: l'orchestratore esterno gestisce il retry. Il wrapper
  // deve terminare prima del timeout azione (100 s) del dispatcher.
  const perComuneTimeout = mode === "full" ? 85_000 : 55_000;
  let res: Response | null = null;
  let text = "";
  let lastErr: unknown = null;
  let attempts = 0;
  let retryReason: string | null = null;

  for (attempts = 1; attempts <= 1; attempts++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), perComuneTimeout);
    try {
      res = await fetch(target, {
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
      text = await res.text().catch(() => "");
      const transient = res.status === 502 || res.status === 503 || res.status === 504;
      if (!transient) break;
      retryReason = `http_${res.status}`;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const abort = err instanceof Error && (err.name === "AbortError" || /aborted/i.test(msg));
      retryReason = abort ? "abort" : `err:${msg.slice(0, 40)}`;
      if (!abort) break;
    }
  }

  const dur = Date.now() - t0;

  if (!res) {
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "unknown_error");
    await logExecution(jobName, {
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: "failure",
      http_status: null,
      response_excerpt: `[${comune}] provider_failed attempts=${attempts} retry_reason=${retryReason ?? "none"}`,
      error_message: `[${comune}] ${msg}`,
      duration_ms: dur,
    });
    return { comune, ok: false, http_status: null, duration_ms: dur, excerpt: "", error: msg, result_status: "provider_failed" };
  }

  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw excerpt */ }
  const resultSummary = parsed?.result_summary ?? parsed?.data?.result_summary ?? parsed?.diagnostics?.result_summary ?? null;
  const warningsArr: string[] = Array.isArray(resultSummary?.warnings) ? resultSummary.warnings : [];
  const recomputeDeferred = warningsArr.includes("padova_contendibili_recompute_deferred_to_pg_cron");

  let reservoirFreshCount: number | null = null;
  try {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const rf = await fetch(
      `${SUPABASE_URL}/rest/v1/padova_collect_v2_items?created_at=gte.${since}&select=id`,
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          Prefer: "count=exact",
          Range: "0-0",
        },
      },
    );
    if (rf.ok) {
      const cr = rf.headers.get("content-range") ?? "";
      const m = cr.match(/\/(\d+)$/);
      reservoirFreshCount = m ? Number(m[1]) : null;
    }
  } catch { /* best effort */ }

  const inlineItems = Number(resultSummary?.raw_items_found ?? 0) > 0
    || (Number(resultSummary?.collect_items_created ?? 0) + Number(resultSummary?.collect_items_updated ?? 0)) > 0;
  const reservoirFresh = (reservoirFreshCount ?? 0) > 0;
  const noRealIngestion = !!resultSummary?.ingestion_requested && (
    resultSummary.ingestion_executed !== true ||
    (!inlineItems && !reservoirFresh)
  );

  let resultStatus: "success" | "partial_failure" | "provider_failed";
  if (!res.ok) resultStatus = "provider_failed";
  else if (noRealIngestion) resultStatus = "partial_failure";
  else resultStatus = "success";

  const excerpt = resultSummary
    ? `attempts=${attempts} retry_reason=${retryReason ?? "none"} result_status=${resultStatus} reservoir_fresh_24h=${reservoirFreshCount ?? "n/a"} recompute_deferred=${recomputeDeferred} result_summary=${JSON.stringify(resultSummary).slice(0, 1200)}`
    : `attempts=${attempts} retry_reason=${retryReason ?? "none"} result_status=${resultStatus} ${text.slice(0, 500)}`;

  await logExecution(jobName, {
    triggered_at: triggeredAt,
    completed_at: new Date().toISOString(),
    status: resultStatus === "success" ? "success" : "failure",
    http_status: res.status,
    response_excerpt: `[${comune}] ${excerpt}`,
    error_message: resultStatus === "success" ? null
      : resultStatus === "partial_failure" ? "ingestion_incomplete_or_no_new_collect_writes"
      : `HTTP ${res.status}`,
    duration_ms: dur,
  });

  return {
    comune,
    ok: resultStatus === "success",
    http_status: res.status,
    duration_ms: dur,
    excerpt,
    error: resultStatus === "success" ? undefined : resultStatus,
    result_status: resultStatus,
  };
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
  return { ok: okCount === COMUNI.length, ok_count: okCount, results };
}

Deno.serve(async (req) => {
  const triggeredAt = new Date().toISOString();
  const t0 = Date.now();
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } });
  }
  if (!JOB_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "misconfigured" }),
      { status: 500, headers: { "Content-Type": "application/json" } });
  }
  if (!safeEqual(req.headers.get("x-job-secret") ?? "", JOB_SECRET)) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } });
  }
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

    // Idempotency self-healing: blocca un secondo run solo se esiste una riga "started"
    // scritta DALLA FUNZIONE STESSA (response_excerpt like 'started mode=%') negli ultimi
    // 60 minuti. Oltre 60 min il run precedente è considerato morto e non blocca più.
    // Le righe pre-log scritte da log_cron_http_invocation (pg_cron) hanno lo stesso
    // job_name ma response_excerpt NULL e vengono escluse dal filtro.
    try {
      const cutoff = new Date(Date.now() - 60 * 60_000).toISOString();
      const recent = await fetch(
        `${SUPABASE_URL}/rest/v1/cron_executions_log?job_name=eq.${jobName}&triggered_at=gte.${cutoff}&response_excerpt=like.started%20mode%3D*&select=id,triggered_at&order=triggered_at.desc&limit=1`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
      );
      if (recent.ok) {
        const arr = await recent.json().catch(() => []);
        if (Array.isArray(arr) && arr.length > 0 && url.searchParams.get("force") !== "1") {
          const prevAt = arr[0]?.triggered_at ?? "unknown";
          await logExecution(jobName, {
            triggered_at: triggeredAt,
            completed_at: new Date().toISOString(),
            status: "success_no_rows",
            http_status: 200,
            response_excerpt: `skipped: in_flight_run_recent prev_started_at=${prevAt} window_min=60`,
            error_message: "skipped_in_flight_run_recent",
            duration_ms: Date.now() - t0,
          });
          return new Response(
            JSON.stringify({ ok: true, skipped: "in_flight_run_recent", job: jobName, prev_started_at: prevAt }),
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

    const summary = await runAll(triggeredAt, mode, jobName);

    // Telemetria: conta le scritture su radar_signals dall'inizio dell'invocazione.
    // NOTA CONTRATTUALE: /agent-radar è read-only e non scrive mai radar_signals
    // (le scritture provengono da job separati: activate-veneto, advanced-veneto,
    // firecrawl microzone, early-offmarket). Quindi 0/null è una misura
    // informativa e NON può far fallire il run.
    let rowsWritten: number | null = null;
    try {
      const countRes = await fetch(
        `${SUPABASE_URL}/rest/v1/radar_signals?detected_at=gte.${triggeredAt}&municipality=ilike.padova&select=id`,
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

    const outcome = evaluateRunOutcome(summary.ok, rowsWritten);

    if (!outcome.ok) {
      await logExecution(jobName, {
        triggered_at: triggeredAt,
        completed_at: new Date().toISOString(),
        status: "failure",
        http_status: 502,
        response_excerpt: `mode=${mode} radar_signals_written=${rowsWritten ?? "unavailable"} comuni=${COMUNI.length}`,
        error_message: outcome.error,
        duration_ms: Date.now() - t0,
      });
      return new Response(JSON.stringify({
        ok: false,
        error: outcome.error,
        radar_signals_written: rowsWritten,
        completed_count: summary.ok_count,
      }), { status: 502, headers: { "Content-Type": "application/json" } });
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
