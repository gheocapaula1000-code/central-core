// connector-status — admin-only synthetic status of external connectors
// Lightweight: configuration check + cheap liveness probe where safe.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { constantTimeEqual } from "../_shared/http.ts";
import { AUTOMATED_TRIGGERS, SOURCE_PLAN, classifySourceRow } from "../_shared/sourceScheduler.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-job-secret, x-diagnostic-secret",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function machineAuthorized(req: Request): boolean {
  const job = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const diag = Deno.env.get("DIAGNOSTIC_SECRET") ?? "";
  const incomingJob = req.headers.get("x-job-secret") ?? "";
  const incomingDiag = req.headers.get("x-diagnostic-secret") ?? "";
  let ok = false;
  if (job && incomingJob) ok = constantTimeEqual(incomingJob, job) || ok;
  if (diag && incomingDiag) ok = constantTimeEqual(incomingDiag, diag) || ok;
  return ok;
}

function getOwnerEmails(): string[] {
  const raw = Deno.env.get("CORE_ADMIN_BOOTSTRAP_EMAILS") ?? "";
  return raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

type Status = "ready" | "warning" | "error";
interface Connector {
  name: string;
  configured: boolean;
  status: Status;
  message: string;
  last_test: string;
  probe?: "config" | "live";
}

async function probe(name: string, envVar: string, live?: () => Promise<{ ok: boolean; msg: string }>): Promise<Connector> {
  const last_test = new Date().toISOString();
  const configured = !!Deno.env.get(envVar);
  if (!configured) return { name, configured: false, status: "error", message: "Non configurato", last_test, probe: "config" };
  if (!live) return { name, configured: true, status: "ready", message: "Configurato", last_test, probe: "config" };
  try {
    const r = await live();
    return { name, configured: true, status: r.ok ? "ready" : "warning", message: r.msg, last_test, probe: "live" };
  } catch (e) {
    return { name, configured: true, status: "warning", message: `Probe fallita: ${(e as Error).message}`, last_test, probe: "live" };
  }
}

async function liveOpenAI(): Promise<{ ok: boolean; msg: string }> {
  const key = Deno.env.get("OPENAI_API_KEY")!;
  const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
  return { ok: r.ok, msg: r.ok ? "API raggiungibile" : `HTTP ${r.status}` };
}
async function liveAnthropic(): Promise<{ ok: boolean; msg: string }> {
  const key = Deno.env.get("ANTHROPIC_API_KEY")!;
  // Lightweight: missing-version returns 400 if key valid; auth error returns 401
  const r = await fetch("https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  return { ok: r.ok || r.status === 400, msg: r.status === 401 ? "Auth fallita" : `HTTP ${r.status}` };
}
async function liveFirecrawl(): Promise<{ ok: boolean; msg: string }> {
  const key = Deno.env.get("FIRECRAWL_API_KEY")!;
  const r = await fetch("https://api.firecrawl.dev/v2/team/credit-usage", {
    headers: { Authorization: `Bearer ${key}` },
  });
  return { ok: r.ok || r.status === 404, msg: r.status === 401 ? "Auth fallita" : `HTTP ${r.status}` };
}
async function liveApify(): Promise<{ ok: boolean; msg: string }> {
  const key = Deno.env.get("APIFY_API_TOKEN")!;
  const r = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(key)}`);
  return { ok: r.ok, msg: r.ok ? "Token valido" : `HTTP ${r.status}` };
}
async function livePerplexity(): Promise<{ ok: boolean; msg: string }> {
  const key = Deno.env.get("PERPLEXITY_API_KEY")!;
  const r = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "sonar", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
  });
  return { ok: r.ok || r.status === 400, msg: r.status === 401 ? "Auth fallita" : `HTTP ${r.status}` };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    // Machine callers (cron / Actions / health) use x-job-secret or
    // x-diagnostic-secret. Interactive admins keep Bearer JWT.
    // Unauthenticated requests still 401 — this is not a public probe.
    if (!machineAuthorized(req)) {
      const auth = req.headers.get("Authorization");
      if (!auth) return json({ error: "Unauthorized" }, 401);

      const token = auth.replace("Bearer ", "").trim();
      const { data: userData, error: uErr } = await supabase.auth.getUser(token);
      if (uErr || !userData.user) return json({ error: "Unauthorized" }, 401);

      const email = (userData.user.email ?? "").toLowerCase();
      const isOwner = getOwnerEmails().includes(email);
      let isAdmin = isOwner;
      if (!isAdmin) {
        const { data: role } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", userData.user.id)
          .eq("role", "admin")
          .maybeSingle();
        isAdmin = !!role;
      }
      if (!isAdmin) return json({ error: "Forbidden" }, 403);
    }

    const url = new URL(req.url);
    const skipLive = url.searchParams.get("live") === "false";

    const connectors = await Promise.all([
      probe("Firecrawl", "FIRECRAWL_API_KEY", skipLive ? undefined : liveFirecrawl),
      probe("Apify", "APIFY_API_TOKEN", skipLive ? undefined : liveApify),
      probe("Perplexity", "PERPLEXITY_API_KEY", skipLive ? undefined : livePerplexity),
      probe("Lovable", "LOVABLE_API_KEY"), // gateway managed: solo config check
      probe("OpenAI", "OPENAI_API_KEY", skipLive ? undefined : liveOpenAI),
      probe("Anthropic", "ANTHROPIC_API_KEY", skipLive ? undefined : liveAnthropic),
      probe("Google Maps", "GOOGLE_MAPS_API_KEY"), // pay-per-call: solo config
      probe("Mapbox", "MAPBOX_API_KEY"), // pay-per-call: solo config
      probe("Stripe", "STRIPE_SECRET_KEY"), // evita test live per non emettere eventi
    ]);

    const summary = {
      ready: connectors.filter((c) => c.status === "ready").length,
      warning: connectors.filter((c) => c.status === "warning").length,
      error: connectors.filter((c) => c.status === "error").length,
    };

    // Source registry health (read-only). Failures degrade to empty list.
    let sources: Array<Record<string, unknown>> = [];
    const sources_summary: Record<string, number> = {
      total: 0, live: 0, partial: 0, planned: 0, disabled: 0, manual_import: 0,
    };
    const automation_summary: Record<string, number> = {
      automated: 0, semi_automated: 0, manual_fallback: 0, premium_on_demand: 0, disabled: 0,
    };
    let stale_sources = 0;
    let failed_sources = 0;
    try {
      const { data } = await supabase
        .from("civiko_source_registry")
        .select(
          "source_code, source_name, access_type, compliance_level, implementation_status, " +
          "activation_mode, automation_status, scheduler_frequency, scheduler_job_name, " +
          "ingestion_endpoint, cross_check_enabled, automation_todo, " +
          "next_run_at, last_run_at, last_success_at, last_error, " +
          "stale_after_days, record_count, automation_notes, updated_at",
        )
        .order("source_code", { ascending: true });
      if (Array.isArray(data)) {
        const now = Date.now();
        sources = data.map((s) => {
          const lastSuccess = s.last_success_at ? Date.parse(String(s.last_success_at)) : null;
          const stale_days = s.stale_after_days ?? null;
          const ageDays = lastSuccess ? Math.floor((now - lastSuccess) / 86_400_000) : null;
          const is_stale = stale_days != null && ageDays != null && ageDays > Number(stale_days);
          if (is_stale) stale_sources++;
          const last_error = typeof s.last_error === "string" && s.last_error.trim() ? s.last_error : null;
          if (last_error) failed_sources++;
          const plan = SOURCE_PLAN[String(s.source_code)] ?? null;
          const health = classifySourceRow({
            last_run_at: s.last_run_at,
            last_success_at: s.last_success_at,
            last_error,
            stale_after_days: stale_days ?? plan?.stale_after_days ?? null,
          });
          const trigger = AUTOMATED_TRIGGERS[String(s.source_code)] ?? null;
          return { ...s, last_error, age_days: ageDays, is_stale, health, trigger };
        });
        for (const s of sources) {
          sources_summary.total++;
          const st = String(s.implementation_status ?? "");
          if (st in sources_summary) sources_summary[st]++;
          const auto = String(s.automation_status ?? "");
          if (auto in automation_summary) automation_summary[auto]++;
        }
      }
    } catch (e) {
      console.warn("connector-status: source registry read failed", (e as Error).message);
    }


    return json({
      ok: true,
      checked_at: new Date().toISOString(),
      summary,
      connectors,
      sources_summary,
      automation_summary,
      stale_sources,
      failed_sources,
      sources,
    });
  } catch (e) {
    console.error("connector-status unhandled:", e);
    return json({ error: "Errore temporaneo" }, 500);
  }
});
