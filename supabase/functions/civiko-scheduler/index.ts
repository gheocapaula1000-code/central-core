// civiko-scheduler — secure runner for scheduled Civiko data sources.
//
// Routes:
//   POST /civiko-scheduler/run-scheduled
//     Body: { source_code?: string, due_only?: boolean, dry_run?: boolean }
//
// Auth: either
//   - header `x-job-secret: <CENTRAL_CORE_JOB_SECRET>`, OR
//   - Bearer JWT belonging to an admin user / bootstrap email.
//
// Returns the same envelope used elsewhere in the project:
//   { ok, data: { ran_at, dry_run, results, summary }, debug_id }
//
// Hard guarantees:
//   - F14 / F15 are NEVER scheduled (FORBIDDEN_SCHEDULER_CODES).
//   - manual_fallback sources are reported as skipped, never faked.
//   - dry_run never mutates the registry.
//   - One failing source never stops the others.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { runScheduledSources, FORBIDDEN_SCHEDULER_CODES } from "../_shared/sourceJobs.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });

function svc() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

function getOwnerEmails(): string[] {
  const raw = Deno.env.get("CORE_ADMIN_BOOTSTRAP_EMAILS") ?? "";
  return raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

async function authorize(req: Request): Promise<Response | null> {
  // Path 1: shared job secret (constant-time-ish compare).
  const expected = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const provided = req.headers.get("x-job-secret") ?? "";
  if (expected && provided && provided.length === expected.length && provided === expected) {
    return null;
  }

  // Path 2: admin JWT.
  const auth = req.headers.get("Authorization");
  if (!auth) return json({ ok: false, error: { code: "UNAUTHORIZED", message: "Missing job-secret or token" } }, 401);
  const supabase = svc();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error } = await supabase.auth.getUser(token);
  if (error || !userData.user) return json({ ok: false, error: { code: "UNAUTHORIZED", message: "Invalid token" } }, 401);
  const email = (userData.user.email ?? "").toLowerCase();
  if (getOwnerEmails().includes(email)) return null;
  const { data: role } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userData.user.id)
    .eq("role", "admin")
    .maybeSingle();
  if (!role) return json({ ok: false, error: { code: "FORBIDDEN", message: "Admin only" } }, 403);
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const debug_id = crypto.randomUUID();

  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/civiko-scheduler/, "").replace(/\/+$/, "") || "/run-scheduled";
    const isRunSource = path === "/run-source";
    if (req.method !== "POST" || (path !== "/run-scheduled" && !isRunSource)) {
      return json({ ok: false, error: { code: "NOT_FOUND", message: `Unknown route ${req.method} ${path}` }, debug_id }, 404);
    }

    const guard = await authorize(req);
    if (guard) return guard;

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* empty body ok */ }
    const source_code = typeof body.source_code === "string" ? body.source_code : undefined;
    const due_only = Boolean(body.due_only);
    const dry_run = Boolean(body.dry_run);

    if (source_code && FORBIDDEN_SCHEDULER_CODES.has(source_code)) {
      return json({
        ok: false,
        error: { code: "FORBIDDEN_SOURCE", message: `${source_code} is premium_on_demand and cannot be scheduled` },
        debug_id,
      }, 400);
    }

    const baseUrl = `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1`;
    const supabase = svc();

    // F11 needs lat/lng. Resolve via agency_operating_areas (Padova only is
    // automated today). Returns null → runner skips with MISSING_COORDS.
    const resolveCoords = async (code: string): Promise<{ lat: number; lng: number } | null> => {
      if (code !== "F11") return null;
      try {
        const { data } = await supabase
          .from("agency_operating_areas")
          .select("comuni")
          .contains("comuni", ["Padova"])
          .limit(1)
          .maybeSingle();
        if (data) return { lat: 45.4064, lng: 11.8768 }; // Padova centroid
      } catch { /* ignore */ }
      return null;
    };

    if (isRunSource && !source_code) {
      return json({ ok: false, error: { code: "BAD_REQUEST", message: "source_code required for /run-source" }, debug_id }, 400);
    }

    const result = await runScheduledSources(
      {
        supabase,
        baseUrl,
        jobSecret: Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "",
        secrets: {
          AI_CORE_SECRET_CIVIKO: Deno.env.get("AI_CORE_SECRET_CIVIKO") ?? "",
          SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
        },
        resolveCoords,
        attachEvidenceWriter: true,
      },
      isRunSource
        ? { source_code, due_only: false, dry_run: false }
        : { source_code, due_only, dry_run },
    );

    // /run-source: return immediately without triggering off-market pipelines
    if (isRunSource) {
      console.log("[civiko-scheduler] run-source", source_code, JSON.stringify(result.results).slice(0, 800));
      return json({ ok: true, data: result, debug_id });
    }

    // Risposta immediata 202 — tutto il lavoro gira in background
    const backgroundWork = async () => {
      const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
      const callRadar = async (route: string, body: Record<string, unknown>) => {
        const started = Date.now();
        const url = `${baseUrl}/civiko-radar-veneto${route}`;
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-job-secret": jobSecret,
              "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(180_000),
          });
          let parsed: unknown = null;
          const text = await res.text();
          try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 500); }
          const summary = (parsed && typeof parsed === "object" && "data" in (parsed as Record<string, unknown>))
            ? (parsed as Record<string, unknown>).data
            : parsed;
          console.log("[civiko-scheduler] pipeline:", route, JSON.stringify(summary).slice(0, 800));
          return { job: route, ok: res.ok, status: res.status, summary, duration_ms: Date.now() - started };
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          console.log("[civiko-scheduler] pipeline ERROR:", route, err);
          return { job: route, ok: false, error: err, duration_ms: Date.now() - started };
        }
      };

      if (dry_run) return;

      // Phase 1: ingest in parallel
      await Promise.allSettled([
        callRadar("/jobs/discover-early-offmarket-signals", {
          comuni: ["Padova"], saveCandidates: true, usePerplexityDiscovery: true,
          useFirecrawl: true, maxSources: 20, dryRun: false,
        }),
        callRadar("/jobs/offmarket-padova", {
          comuni: ["Padova"], saveCandidates: true, dryRun: false,
        }),
        callRadar("/jobs/padova-successioni", {
          triggered_by: "civiko-scheduler",
        }),
      ]);

      // Phase 2: scoring (sequential)
      await callRadar("/jobs/build-offmarket-opportunity-scores", {
        comuni: ["Padova"], triggered_by: "civiko-scheduler",
        dryRun: false, import: true, commit: true,
      });

      // Phase 3a: Zone radar — elabora 3 zone per volta (no timeout)
      await callRadar("/jobs/padova-zone-radar", {
        mode: "next",
        max_zones: 3,
        dryRun: false,
      });

      // Phase 3b: Finalize zone radar
      await callRadar("/jobs/padova-zone-radar-finalize", {});

      // Phase 3c: parallel enrichment
      await Promise.allSettled([
        callRadar("/jobs/firecrawl-microzone-opportunity-signals", { import: true }),
        callRadar("/jobs/refresh-padova-legal-life-events", {}),
        callRadar("/jobs/enrich-microzone-sentiment-from-territorial-signals", { dryRun: false }),
      ]);

      console.log("[civiko-scheduler] all phases completed");
    };

    // @ts-ignore — Deno-specific API
    EdgeRuntime.waitUntil(backgroundWork());

    return new Response(
      JSON.stringify({ ok: true, data: { ran_at: new Date().toISOString(), mode: "background_202", debug_id }, debug_id }),
      { status: 202, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } },
    );

  } catch (e) {
    console.error("civiko-scheduler error", (e as Error).message);
    return json({ ok: false, error: { code: "INTERNAL_ERROR", message: "Errore temporaneo" }, debug_id }, 500);
  }
});
