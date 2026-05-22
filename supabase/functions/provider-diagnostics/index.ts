// provider-diagnostics — admin-only health + test runner for external AI/scraping providers.
// Never returns API keys. Logs every probe/test to provider_diagnostics_events.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const FUNCTION = "provider-diagnostics";

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function ownerEmails(): string[] {
  const raw = Deno.env.get("CORE_ADMIN_BOOTSTRAP_EMAILS") ?? "";
  return raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function maskKey(v: string | undefined): string {
  if (!v) return "missing";
  if (v.length < 8) return "set";
  return `${v.slice(0, 4)}…${v.slice(-3)}`;
}

function log(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) {
  // Structured JSON log line
  console.log(JSON.stringify({ ts: new Date().toISOString(), fn: FUNCTION, level, msg, ...extra }));
}

interface TimedResult {
  ok: boolean;
  status?: number;
  latency_ms: number;
  message: string;
  meta?: Record<string, unknown>;
}

async function timed(fn: () => Promise<{ ok: boolean; status?: number; message: string; meta?: Record<string, unknown> }>): Promise<TimedResult> {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { ...r, latency_ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - t0, message: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Provider probes (cheap, read-only) ───────────────────────
async function probeOpenAI(): Promise<TimedResult> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return { ok: false, latency_ms: 0, message: "OPENAI_API_KEY not configured" };
  return timed(async () => {
    const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
    return { ok: r.ok, status: r.status, message: r.ok ? "auth ok" : `HTTP ${r.status}` };
  });
}
async function probeAnthropic(): Promise<TimedResult> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return { ok: false, latency_ms: 0, message: "ANTHROPIC_API_KEY not configured" };
  return timed(async () => {
    const r = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    // 200 ok; 401 auth fail
    return { ok: r.ok, status: r.status, message: r.ok ? "auth ok" : r.status === 401 ? "auth failed" : `HTTP ${r.status}` };
  });
}
async function probePerplexity(): Promise<TimedResult> {
  const key = Deno.env.get("PERPLEXITY_API_KEY");
  if (!key) return { ok: false, latency_ms: 0, message: "PERPLEXITY_API_KEY not configured" };
  return timed(async () => {
    // NOTE: Perplexity "sonar" requires max_tokens >= 16. Smaller values return HTTP 400.
    const model = Deno.env.get("PERPLEXITY_MODEL") ?? "sonar";
    const r = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 16,
      }),
    });
    if (r.ok) {
      // Drain body to free the connection but ignore content.
      await r.text().catch(() => "");
      return { ok: true, status: r.status, message: "auth ok", meta: { model } };
    }
    const body = await r.text().catch(() => "");
    log("warn", "perplexity probe non-2xx", { status: r.status, body: body.slice(0, 500), model, key: maskKey(key) });
    return {
      ok: false,
      status: r.status,
      message: r.status === 401 ? "auth failed" : `HTTP ${r.status}: ${body.slice(0, 200)}`,
      meta: { model, error_body: body.slice(0, 500) },
    };
  });
}
async function probeFirecrawl(): Promise<TimedResult> {
  const key = Deno.env.get("FIRECRAWL_API_KEY");
  if (!key) return { ok: false, latency_ms: 0, message: "FIRECRAWL_API_KEY not configured" };
  return timed(async () => {
    const r = await fetch("https://api.firecrawl.dev/v2/team/credit-usage", {
      headers: { Authorization: `Bearer ${key}` },
    });
    let meta: Record<string, unknown> | undefined;
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      const d = (data as { data?: Record<string, unknown> })?.data ?? data;
      meta = {
        credits_remaining: (d as { remaining_credits?: number })?.remaining_credits ?? (d as { credits?: number })?.credits,
        plan_credits: (d as { plan_credits?: number })?.plan_credits,
      };
    }
    const ok = r.ok || r.status === 404;
    return { ok, status: r.status, message: r.status === 401 ? "auth failed" : ok ? "auth ok" : `HTTP ${r.status}`, meta };
  });
}
async function probeApify(): Promise<TimedResult> {
  const key = Deno.env.get("APIFY_API_TOKEN");
  if (!key) return { ok: false, latency_ms: 0, message: "APIFY_API_TOKEN not configured" };
  return timed(async () => {
    const r = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(key)}`);
    let meta: Record<string, unknown> | undefined;
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      const d = (data as { data?: Record<string, unknown> })?.data ?? {};
      meta = {
        plan: (d as { plan?: { id?: string } })?.plan?.id,
        username: (d as { username?: string })?.username,
      };
    }
    return { ok: r.ok, status: r.status, message: r.ok ? "token valid" : `HTTP ${r.status}` };
  });
}

// ─── Active tests (small but real API calls) ──────────────────
async function testOpenAI(): Promise<TimedResult> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return { ok: false, latency_ms: 0, message: "OPENAI_API_KEY not configured" };
  return timed(async () => {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5,
      }),
    });
    const remaining = r.headers.get("x-ratelimit-remaining-requests");
    const reset = r.headers.get("x-ratelimit-reset-requests");
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, status: r.status, message: `HTTP ${r.status}: ${t.slice(0, 160)}`, meta: { remaining, reset } };
    }
    const data = await r.json();
    const out = data?.choices?.[0]?.message?.content ?? "";
    return {
      ok: true,
      status: r.status,
      message: `completion ok (${(out as string).slice(0, 40)})`,
      meta: { remaining, reset, model: data?.model },
    };
  });
}

async function testPerplexity(): Promise<TimedResult> {
  const key = Deno.env.get("PERPLEXITY_API_KEY");
  if (!key) return { ok: false, latency_ms: 0, message: "PERPLEXITY_API_KEY not configured" };
  return timed(async () => {
    const r = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "user", content: "What is the capital of Italy? Reply in one word." }],
        max_tokens: 20,
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, status: r.status, message: `HTTP ${r.status}: ${t.slice(0, 160)}` };
    }
    const data = await r.json();
    const out = data?.choices?.[0]?.message?.content ?? "";
    const citations = Array.isArray(data?.citations) ? data.citations.length : 0;
    return { ok: true, status: r.status, message: `search ok (${(out as string).slice(0, 60)})`, meta: { citations } };
  });
}

async function testFirecrawl(): Promise<TimedResult> {
  const key = Deno.env.get("FIRECRAWL_API_KEY");
  if (!key) return { ok: false, latency_ms: 0, message: "FIRECRAWL_API_KEY not configured" };
  return timed(async () => {
    const r = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", formats: ["markdown"], onlyMainContent: true }),
    });
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, status: r.status, message: `HTTP ${r.status}: ${t.slice(0, 160)}` };
    }
    const data = await r.json();
    const root = data?.data ?? data;
    const md: string = root?.markdown ?? "";
    return { ok: md.length > 0, status: r.status, message: `scrape ok (${md.length} chars)`, meta: { title: root?.metadata?.title ?? null } };
  });
}

async function testApify(): Promise<TimedResult> {
  const key = Deno.env.get("APIFY_API_TOKEN");
  if (!key) return { ok: false, latency_ms: 0, message: "APIFY_API_TOKEN not configured" };
  // Tiny actor: apify/hello-world (free, ~5s). Use run-sync so we don't poll.
  return timed(async () => {
    const r = await fetch(`https://api.apify.com/v2/acts/apify~hello-world/run-sync?token=${encodeURIComponent(key)}&timeout=30`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, status: r.status, message: `HTTP ${r.status}: ${t.slice(0, 160)}` };
    }
    return { ok: true, status: r.status, message: "actor run completed" };
  });
}

// ─── Persistence ──────────────────────────────────────────────
async function logEvent(
  admin: ReturnType<typeof createClient>,
  provider: string,
  event_type: "probe" | "test",
  action: string | null,
  r: TimedResult,
) {
  try {
    await admin.from("provider_diagnostics_events").insert({
      provider,
      event_type,
      action,
      ok: r.ok,
      http_status: r.status ?? null,
      latency_ms: r.latency_ms,
      message: r.message,
      meta: r.meta ?? {},
    });
  } catch (e) {
    log("warn", "log insert failed", { provider, err: String(e) });
  }
}

async function lastEvents(admin: ReturnType<typeof createClient>, provider: string) {
  const [{ data: lastOk }, { data: lastErr }] = await Promise.all([
    admin.from("provider_diagnostics_events").select("created_at,latency_ms,message,action,event_type").eq("provider", provider).eq("ok", true).order("created_at", { ascending: false }).limit(1),
    admin.from("provider_diagnostics_events").select("created_at,http_status,message,action,event_type").eq("provider", provider).eq("ok", false).order("created_at", { ascending: false }).limit(1),
  ]);
  return {
    last_success: lastOk?.[0] ?? null,
    last_error: lastErr?.[0] ?? null,
  };
}

const PROBES: Record<string, () => Promise<TimedResult>> = {
  openai: probeOpenAI,
  anthropic: probeAnthropic,
  perplexity: probePerplexity,
  firecrawl: probeFirecrawl,
  apify: probeApify,
};

const TESTS: Record<string, () => Promise<TimedResult>> = {
  openai: testOpenAI,
  perplexity: testPerplexity,
  firecrawl: testFirecrawl,
  apify: testApify,
};

const ENV_NAMES: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
  apify: "APIFY_API_TOKEN",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    // Admin gate
    const auth = req.headers.get("Authorization");
    if (!auth) return jsonRes({ error: "Unauthorized" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );
    const token = auth.replace("Bearer ", "").trim();
    const { data: userData, error: uErr } = await admin.auth.getUser(token);
    if (uErr || !userData.user) return jsonRes({ error: "Unauthorized" }, 401);

    const email = (userData.user.email ?? "").toLowerCase();
    const isOwner = ownerEmails().includes(email);
    let isAdmin = isOwner;
    if (!isAdmin) {
      const { data: role } = await admin
        .from("user_roles")
        .select("role")
        .eq("user_id", userData.user.id)
        .eq("role", "admin")
        .maybeSingle();
      isAdmin = !!role;
    }
    if (!isAdmin) {
      log("warn", "not found (non-admin)", { email });
      return new Response("Not found", { status: 404, headers: CORS });
    }

    const url = new URL(req.url);
    const path = url.pathname.split("/").filter(Boolean).pop() ?? "";

    // POST /test → { provider }
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const provider = String((body as { provider?: string }).provider ?? "").toLowerCase();
      if (!TESTS[provider]) return jsonRes({ error: `unknown provider: ${provider}` }, 400);
      log("info", "test start", { provider, by: email });
      const r = await TESTS[provider]();
      await logEvent(admin, provider, "test", `test-${provider}`, r);
      log(r.ok ? "info" : "error", "test done", { provider, ok: r.ok, status: r.status, latency_ms: r.latency_ms });
      return jsonRes({ ok: true, provider, result: r });
    }

    // GET → run all probes in parallel and return aggregated status
    const providers = Object.keys(PROBES);
    const results = await Promise.all(providers.map((p) => PROBES[p]().then((r) => ({ p, r }))));
    await Promise.all(results.map(({ p, r }) => logEvent(admin, p, "probe", "health", r)));

    const enriched = await Promise.all(
      results.map(async ({ p, r }) => {
        const history = await lastEvents(admin, p);
        const envName = ENV_NAMES[p];
        const envVal = Deno.env.get(envName);
        return {
          provider: p,
          env_var: envName,
          configured: !!envVal,
          key_preview: maskKey(envVal),
          reachable: r.ok || (r.status !== undefined && r.status > 0),
          auth_valid: r.ok,
          http_status: r.status ?? null,
          latency_ms: r.latency_ms,
          message: r.message,
          quota: r.meta ?? {},
          ...history,
        };
      }),
    );

    log("info", "health snapshot", { ok_count: enriched.filter((e) => e.auth_valid).length, total: enriched.length });

    return jsonRes({
      ok: true,
      checked_at: new Date().toISOString(),
      providers: enriched,
    });
  } catch (e) {
    log("error", "unhandled", { err: e instanceof Error ? e.message : String(e) });
    return jsonRes({ error: "internal error" }, 500);
  }
});
