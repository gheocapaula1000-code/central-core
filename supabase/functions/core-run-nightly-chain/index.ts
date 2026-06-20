// core-run-nightly-chain
// Lancia in sequenza i 6 cron Core. Richiede auth admin
// (header x-job-secret = CENTRAL_CORE_JOB_SECRET, oppure Bearer JWT con
// ruolo admin in user_roles, oppure email in CORE_ADMIN_BOOTSTRAP_EMAILS).
//
// Aspetta il completamento reale di ogni step prima del successivo.
// Per i job che lanciano actor Apify asincroni, fa polling su
// padova_apify_runs / private_leads_run_status finché lo stato risulta
// completato o scaduto.

import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";

function svc() {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function authorize(req: Request): Promise<{ ok: boolean; reason?: string }> {
  const headerSecret = req.headers.get("x-job-secret") ?? "";
  if (JOB_SECRET && headerSecret && constantTimeEqual(headerSecret, JOB_SECRET)) {
    return { ok: true };
  }
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return { ok: false, reason: "missing_auth" };
  const token = auth.slice(7);
  const sb = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: claims, error } = await sb.auth.getClaims(token);
  if (error || !claims?.claims) return { ok: false, reason: "invalid_token" };
  const uid = claims.claims.sub as string;
  const email = ((claims.claims.email as string) ?? "").toLowerCase();

  const bootstrap = (Deno.env.get("CORE_ADMIN_BOOTSTRAP_EMAILS") ?? "")
    .split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (email && bootstrap.includes(email)) return { ok: true };

  const s = svc();
  const { data: roles } = await s.from("user_roles").select("role").eq("user_id", uid);
  if ((roles ?? []).some((r: any) => r.role === "admin")) return { ok: true };
  return { ok: false, reason: "not_admin" };
}

async function invoke(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "apikey": SERVICE_KEY,
      ...(JOB_SECRET ? { "x-job-secret": JOB_SECRET } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  let j: any = null;
  try { j = await r.json(); } catch { j = await r.text().catch(() => null); }
  return { status: r.status, json: j };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Poll Apify runs finché tutti i run_id passati risultano completi.
// Considera "completi" gli stati: SUCCEEDED, FAILED, ABORTED, TIMED-OUT.
async function waitApifyRuns(runIds: string[], maxMs = 25 * 60_000): Promise<any[]> {
  if (runIds.length === 0) return [];
  const sb = svc();
  const start = Date.now();
  const TERMINAL = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT", "TIMED_OUT"]);
  while (Date.now() - start < maxMs) {
    const { data } = await sb
      .from("padova_apify_runs")
      .select("run_id, status, items_count, ended_at")
      .in("run_id", runIds);
    const seen = new Map<string, any>();
    for (const r of data ?? []) seen.set(r.run_id, r);
    const allDone = runIds.every((id) => {
      const r = seen.get(id);
      return r && TERMINAL.has(String(r.status ?? "").toUpperCase());
    });
    if (allDone) return Array.from(seen.values());
    await sleep(15_000);
  }
  const { data } = await sb
    .from("padova_apify_runs")
    .select("run_id, status, items_count, ended_at")
    .in("run_id", runIds);
  return data ?? [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }),
      { status: 405, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const auth = await authorize(req);
  if (!auth.ok) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized", reason: auth.reason }),
      { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const startedAt = new Date().toISOString();
  const steps: any[] = [];
  const sb = svc();

  // Step 1 — nightly-data-refresh-master (via civiko-scheduler)
  {
    const t0 = Date.now();
    const r = await invoke("civiko-scheduler/run-scheduled", { due_only: true });
    steps.push({
      step: 1, job: "nightly-data-refresh-master",
      descrizione: "Aggiornamento notturno dati master",
      http_status: r.status, ok: r.status >= 200 && r.status < 300,
      durata_ms: Date.now() - t0,
      risultato: r.json?.data?.summary ?? r.json?.summary ?? null,
    });
  }

  // Step 2 — padova-daily-radar
  {
    const t0 = Date.now();
    const r = await invoke("civiko-radar-veneto/jobs/padova-daily-radar", { triggered_by: "core-run-nightly-chain" });
    steps.push({
      step: 2, job: "padova-daily-radar",
      descrizione: "Radar giornaliero Padova",
      http_status: r.status, ok: r.status >= 200 && r.status < 300,
      durata_ms: Date.now() - t0,
      risultato: r.json?.data ?? r.json ?? null,
    });
  }

  // Step 3 — padova-contendibili-recompute (SQL diretta)
  {
    const t0 = Date.now();
    let result: any = null; let ok = false; let error: string | null = null;
    try {
      const { data, error: e } = await sb.rpc("recompute_padova_contendibili");
      if (e) { error = e.message; } else { result = data; ok = true; }
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    await sb.from("cron_executions_log").insert({
      job_name: "padova-contendibili-recompute",
      status: ok ? "success" : "failure",
      triggered_at: new Date(t0).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      response_excerpt: ok ? JSON.stringify(result).slice(0, 4000) : null,
      error_message: error,
    });
    steps.push({
      step: 3, job: "padova-contendibili-recompute",
      descrizione: "Ricalcolo immobili contendibili Padova",
      ok, durata_ms: Date.now() - t0, risultato: result, errore: error,
    });
  }

  // Step 4 — civiko-private-leads-nightly (lancia Apify, poi aspetta i run)
  {
    const t0 = Date.now();
    const r = await invoke("civiko-private-leads-nightly", { trigger: "core-run-nightly-chain" });
    const runIds: string[] = (r.json?.launched ?? r.json?.data?.launched ?? [])
      .map((x: any) => x?.run_id ?? x?.id ?? x?.apify_run_id)
      .filter((x: any) => typeof x === "string");
    let apifyFinal: any[] = [];
    if (runIds.length > 0) apifyFinal = await waitApifyRuns(runIds);
    steps.push({
      step: 4, job: "civiko-private-leads-nightly",
      descrizione: "Estrazione notturna lead privati",
      http_status: r.status, ok: r.status >= 200 && r.status < 300,
      durata_ms: Date.now() - t0,
      risultato: {
        sampling: r.json?.sampling ?? null,
        run_ids: runIds,
        apify_finali: apifyFinal.map((x) => ({ run_id: x.run_id, status: x.status, items: x.items_count })),
        items_totali: apifyFinal.reduce((s, x) => s + (x.items_count ?? 0), 0),
      },
    });
  }

  // Step 5 — civiko-private-leads-classify
  {
    const t0 = Date.now();
    const r = await invoke("civiko-private-leads-classify", { trigger: "core-run-nightly-chain" });
    steps.push({
      step: 5, job: "civiko-private-leads-classify",
      descrizione: "Classificazione lead privati",
      http_status: r.status, ok: r.status >= 200 && r.status < 300,
      durata_ms: Date.now() - t0,
      risultato: r.json?.data ?? r.json ?? null,
    });
  }

  // Step 6 — civiko-private-leads-price-snapshot
  {
    const t0 = Date.now();
    const r = await invoke("civiko-private-leads-price-snapshot", { trigger: "core-run-nightly-chain" });
    steps.push({
      step: 6, job: "civiko-private-leads-price-snapshot",
      descrizione: "Fotografia prezzi lead privati",
      http_status: r.status, ok: r.status >= 200 && r.status < 300,
      durata_ms: Date.now() - t0,
      risultato: r.json?.data ?? r.json ?? null,
    });
  }

  const finishedAt = new Date().toISOString();
  const allOk = steps.every((s) => s.ok);

  return new Response(JSON.stringify({
    ok: allOk,
    avviato_il: startedAt,
    completato_il: finishedAt,
    steps,
  }), { headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
});
