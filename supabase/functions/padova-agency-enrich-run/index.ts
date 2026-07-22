// Run controllato di agency enrichment su listing Padova senza agency reale.
// Auth: x-job-secret == CENTRAL_CORE_JOB_SECRET.
// Body: { portals?: string[], limit_per_portal?: number, dry_run?: boolean, force_refresh?: boolean, recompute?: boolean }
// Default: limit_per_portal=40, portals=["casa","immobiliare","idealista","subito"], dry_run=false, recompute=true.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { enrichListingAgency, type Portal } from "../_shared/agencyEnrichment.ts";

const ALL_PORTALS: Portal[] = ["casa", "immobiliare", "idealista", "subito"];

function sb() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const debugId = crypto.randomUUID();
  try {
    const sec = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
    const got = req.headers.get("x-job-secret") ?? "";
    if (!sec || got !== sec) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized", debug_id: debugId }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const body = await req.json().catch(() => ({})) as {
      portals?: string[]; limit_per_portal?: number; dry_run?: boolean;
      force_refresh?: boolean; recompute?: boolean; only_missing?: boolean;
    };
    const portals: Portal[] = (body.portals && body.portals.length
      ? body.portals.filter((p): p is Portal => (ALL_PORTALS as string[]).includes(p))
      : ALL_PORTALS);
    const limit = Math.max(1, Math.min(200, body.limit_per_portal ?? 40));
    const dryRun = !!body.dry_run;
    const forceRefresh = !!body.force_refresh;
    const recompute = body.recompute !== false;
    const onlyMissing = body.only_missing !== false;

    const c = sb();
    const perPortal: Record<string, {
      analyzed: number; visited: number; agency_found: number; high_conf: number;
      blocked_antibot: number; budget_skip: number; from_cache: number;
      coverage_pct_after: number; errors: Record<string, number>;
      examples: { url: string; agency: string | null; method: string; confidence: string }[];
    }> = {};

    for (const portal of portals) {
      const q = c.from("padova_collect_v2_items")
        .select("id, url, agency, last_seen_at")
        .eq("portal", portal)
        .not("url", "is", null)
        .order("last_seen_at", { ascending: false, nullsFirst: false })
        .limit(limit);
      if (onlyMissing) {
        q.or("agency.is.null,agency.eq.,agency.ilike.portal:%");
      }
      const { data: rows, error } = await q;
      if (error) {
        perPortal[portal] = { analyzed: 0, visited: 0, agency_found: 0, high_conf: 0, blocked_antibot: 0, budget_skip: 0, from_cache: 0, coverage_pct_after: 0, errors: { query_error: 1 }, examples: [] };
        continue;
      }
      const stats = perPortal[portal] = { analyzed: rows?.length ?? 0, visited: 0, agency_found: 0, high_conf: 0, blocked_antibot: 0, budget_skip: 0, from_cache: 0, coverage_pct_after: 0, errors: {} as Record<string, number>, examples: [] as { url: string; agency: string | null; method: string; confidence: string }[] };
      if (!rows || rows.length === 0) continue;

      for (const r of rows) {
        const url = r.url as string;
        const id = r.id as number;
        try {
          const ext = await enrichListingAgency(url, portal, { forceRefresh });
          if (ext.from_cache) stats.from_cache++; else stats.visited++;
          if (ext.budget_skip) {
            stats.budget_skip++;
            stats.errors[ext.budget_skip] = (stats.errors[ext.budget_skip] ?? 0) + 1;
            continue;
          }
          if (ext.error === "blocked_by_antibot") stats.blocked_antibot++;
          if (ext.raw_agency_name && ext.normalized_agency_name) {
            stats.agency_found++;
            if (ext.confidence === "high") stats.high_conf++;
            if (stats.examples.length < 5) {
              stats.examples.push({ url, agency: ext.raw_agency_name, method: ext.extraction_method, confidence: ext.confidence });
            }
            // Promuovi nell'item solo se confidence high/medium e non dry_run
            if (!dryRun && (ext.confidence === "high" || ext.confidence === "medium")) {
              await c.from("padova_collect_v2_items")
                .update({ agency: ext.raw_agency_name })
                .eq("id", id);
            }
          } else if (ext.error) {
            stats.errors[ext.error] = (stats.errors[ext.error] ?? 0) + 1;
          }
        } catch (e) {
          const msg = String((e as Error).message ?? e).slice(0, 80);
          stats.errors[`exception:${msg}`] = (stats.errors[`exception:${msg}`] ?? 0) + 1;
        }
      }

      // coverage post-run (real agency in items)
      const { count: total } = await c.from("padova_collect_v2_items").select("id", { count: "exact", head: true }).eq("portal", portal);
      const { count: withAg } = await c.from("padova_collect_v2_items").select("id", { count: "exact", head: true })
        .eq("portal", portal).not("agency", "is", null).neq("agency", "").not("agency", "ilike", "portal:%");
      stats.coverage_pct_after = total && total > 0 ? Math.round(((withAg ?? 0) / total) * 1000) / 10 : 0;
    }

    // Recompute diagnostics: before/after counters + safe no-arg call
    const { count: contendibiliBefore } = await c.from("padova_contendibili").select("id", { count: "exact", head: true });
    const { count: multiBefore } = await c.from("padova_multi_portale").select("id", { count: "exact", head: true });

    let recomputeRequested = !!recompute && !dryRun;
    let recomputeExecuted = false;
    let recomputeError: string | null = null;
    let recomputeResult: unknown = null;
    if (recomputeRequested) {
      const { data: rc, error: rcErr } = await c.rpc("recompute_padova_contendibili");
      if (rcErr) {
        recomputeError = rcErr.message;
        recomputeResult = { error: rcErr.message };
      } else {
        recomputeExecuted = true;
        recomputeResult = rc;
      }
    }

    const { count: contendibiliAfter } = await c.from("padova_contendibili").select("id", { count: "exact", head: true });
    const { count: multiAfter } = await c.from("padova_multi_portale").select("id", { count: "exact", head: true });


    // Run status: partial_failure se abbiamo tentato visite ma 0 agenzie trovate
    const totals = Object.values(perPortal).reduce(
      (a, b) => ({
        visited: a.visited + b.visited,
        agency_found: a.agency_found + b.agency_found,
        blocked: a.blocked + b.blocked_antibot,
        budget_skip: a.budget_skip + b.budget_skip,
      }),
      { visited: 0, agency_found: 0, blocked: 0, budget_skip: 0 },
    );
    let runStatus = "success";
    if (totals.budget_skip > 0 && totals.visited === 0) runStatus = "skipped_budget";
    else if (totals.visited > 0 && totals.agency_found === 0) runStatus = "partial_failure";

    return new Response(JSON.stringify({
      ok: true,
      debug_id: debugId,
      run_status: runStatus,
      params: { portals, limit_per_portal: limit, dry_run: dryRun, force_refresh: forceRefresh, recompute, only_missing: onlyMissing },
      per_portal: perPortal,
      totals,
      recompute_requested: recomputeRequested,
      recompute_executed: recomputeExecuted,
      recompute_error: recomputeError,
      contendibili_before: contendibiliBefore ?? null,
      contendibili_after: contendibiliAfter ?? null,
      multi_portale_before: multiBefore ?? null,
      multi_portale_after: multiAfter ?? null,
      recompute_result: recomputeResult,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message ?? e), debug_id: debugId }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
