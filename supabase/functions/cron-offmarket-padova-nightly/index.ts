// Cron wrapper: invokes the three off-market Padova jobs on civiko-radar-veneto.
// Invoked by pg_cron at 03:30 / 03:45 / 04:00 UTC using ?job=<slug>.
// Design mirrors cron-radar-padova-nightly:
//  - Sync fetch (no waitUntil), so completion is guaranteed and audited.
//  - Logs real outcome to public.cron_executions_log (never trusts net.http_post 1-row).
//  - Uses x-job-secret / x-internal-secret / Authorization with CENTRAL_CORE_JOB_SECRET,
//    identical to the existing radar cron.
//  - Does NOT modify any runner internals nor the endpoints themselves.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";

type JobSlug =
  | "offmarket-padova"
  | "discover-early-offmarket-signals"
  | "build-offmarket-opportunity-scores"
  | "build-padova-early-warning";

const JOB_NAMES: Record<JobSlug, string> = {
  "offmarket-padova": "central-core-offmarket-padova-nightly",
  "discover-early-offmarket-signals": "central-core-early-offmarket-nightly",
  "build-offmarket-opportunity-scores": "central-core-offmarket-scores-nightly",
  "build-padova-early-warning": "central-core-padova-early-warning-nightly",
};

// Bodies chosen so the writes actually happen (not dry-run).
// - offmarket-padova: endpoint (index.ts:1465-1480) already forces dryRun:false; body ignored.
// - discover-early-offmarket-signals: default saveCandidates in runner is false; MUST pass true.
// - build-offmarket-opportunity-scores: engine upserts unconditionally; pass no-op body.
function buildBody(slug: JobSlug): Record<string, unknown> {
  const COMUNI_PD = [
    "Padova","Vigonza","Selvazzano Dentro","Rubano","Albignasego",
    "Cadoneghe","Limena","Noventa Padovana","Abano Terme","Montegrotto Terme",
  ];
  switch (slug) {
    case "offmarket-padova":
      return { triggered_by: "cron-nightly" };
    case "discover-early-offmarket-signals":
      return {
        comuni: COMUNI_PD,
        province: ["PD"],
        dryRun: false,
        saveCandidates: true,
        usePerplexityDiscovery: true,
        useFirecrawl: true,
        maxSources: 20,
        maxPagesPerSource: 5,
        triggered_by: "cron-nightly",
      };
    case "build-offmarket-opportunity-scores":
      return {
        comuni: COMUNI_PD,
        province: ["PD"],
        dryRun: false,
        triggered_by: "cron-nightly",
      };
    case "build-padova-early-warning":
      return {
        comuni: COMUNI_PD,
        province: ["PD"],
        dryRun: false,
        triggered_by: "cron-nightly",
      };
  }
}

async function logExecution(jobName: string, row: {
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
      body: JSON.stringify({ job_name: jobName, ...row }),
    });
  } catch (e) {
    console.warn(`[${jobName}] logExecution failed:`, e instanceof Error ? e.message : String(e));
  }
}

async function runJob(slug: JobSlug, triggeredAt: string) {
  const jobName = JOB_NAMES[slug];
  const target = `${SUPABASE_URL}/functions/v1/civiko-radar-veneto/jobs/${slug}`;
  const body = buildBody(slug);
  const t0 = Date.now();

  await logExecution(jobName, {
    triggered_at: triggeredAt,
    completed_at: new Date().toISOString(),
    status: "started",
    http_status: 202,
    response_excerpt: `started slug=${slug}`,
    error_message: null,
    duration_ms: 0,
  });

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 300_000); // 5 min per job
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
    let parseError: string | null = null;
    if (!text.trim()) parseError = "empty_body";
    else {
      try {
        parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          parseError = "invalid_payload";
        }
      } catch {
        parseError = "invalid_json";
      }
    }
    // Fail-closed: ok:false o errors[] annidati non possono passare per successo.
    const nestedErrors = Array.isArray(parsed?.errors) && parsed.errors.length > 0;
    const okFlag = !parseError && parsed?.ok !== false && !nestedErrors;
    const excerpt = (text || "").slice(0, 1600);
    const status: "success" | "failure" = res.ok && okFlag ? "success" : "failure";
    await logExecution(jobName, {
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status,
      http_status: res.status,
      response_excerpt: excerpt,
      error_message: status === "success"
        ? null
        : (parseError ?? parsed?.error?.message ?? (nestedErrors ? "nested_errors" : `HTTP ${res.status}`)),
      duration_ms: dur,
    });
    return {
      ok: status === "success",
      http_status: res.status,
      duration_ms: dur,
      error: status === "success"
        ? undefined
        : (parseError ?? (nestedErrors ? "nested_errors" : `http_${res.status}`)),
    };

  } catch (err) {
    const dur = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    await logExecution(jobName, {
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: "failure",
      http_status: null,
      response_excerpt: null,
      error_message: msg,
      duration_ms: dur,
    });
    return { ok: false, http_status: null as number | null, duration_ms: dur, error: msg };
  }
}

Deno.serve(async (req) => {
  const triggeredAt = new Date().toISOString();
  if (!JOB_SECRET) {
    return new Response(
      JSON.stringify({ ok: false, error: "CENTRAL_CORE_JOB_SECRET missing" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
  const url = new URL(req.url);
  const slug = url.searchParams.get("job") as JobSlug | null;
  if (!slug || !(slug in JOB_NAMES)) {
    return new Response(
      JSON.stringify({ ok: false, error: "missing_or_invalid_job", allowed: Object.keys(JOB_NAMES) }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const r = await runJob(slug, triggeredAt);
  return new Response(
    JSON.stringify({ ok: r.ok, job: JOB_NAMES[slug], slug, triggered_at: triggeredAt, ...r }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
