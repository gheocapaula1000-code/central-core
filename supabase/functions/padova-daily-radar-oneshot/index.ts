import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
const TARGET = `${SUPABASE_URL}/functions/v1/civiko-radar-veneto/jobs/padova-daily-radar`;
const RUN_TIMEOUT_MS = 260_000;

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!SUPABASE_URL || !JOB_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "server_config_missing" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);

  const res = await fetch(TARGET, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-job-secret": JOB_SECRET,
    },
    body: JSON.stringify({ triggered_by: "temporary_server_side_oneshot" }),
    signal: controller.signal,
  });
  clearTimeout(timeout);

  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
  });
});
