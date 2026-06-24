// Cron wrapper: triggers /civiko-radar-veneto/agent-radar with full intent for PD comuni.
// Invoked by pg_cron nightly at 03:00 UTC. Reads CENTRAL_CORE_JOB_SECRET from env so the
// secret never has to be stored in the database.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";

const BODY = {
  scope: "global",
  intent: "full",
  province: ["PD"],
  comuni: [
    "Padova",
    "Rubano",
    "Albignasego",
    "Cadoneghe",
    "Selvazzano Dentro",
    "Ponte San Nicolò",
    "Abano Terme",
  ],
  triggered_by: "cron-nightly",
  admin_global: true,
  ignore_workspace_filters: true,
  ignore_agency_filters: true,
  ignore_operating_area_filters: true,
  ignore_zone_filters: true,
  min_agencies: 1,
  limit: 200,
};

Deno.serve(async (_req) => {
  const startedAt = new Date().toISOString();
  if (!JOB_SECRET) {
    return new Response(
      JSON.stringify({ ok: false, error: "CENTRAL_CORE_JOB_SECRET missing" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const target = `${SUPABASE_URL}/functions/v1/civiko-radar-veneto/agent-radar`;
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-job-secret": JOB_SECRET,
        "x-internal-secret": JOB_SECRET,
        "x-source-app": "central-core-cron",
      },
      body: JSON.stringify(BODY),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep raw */ }

    // Audit row
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/cron_executions_log`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          job_name: "central-core-radar-padova-nightly-full",
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          status: res.ok ? "success" : "error",
          http_status: res.status,
        }),
      });
    } catch { /* best effort */ }

    return new Response(
      JSON.stringify({ ok: res.ok, status: res.status, started_at: startedAt, response: parsed }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
