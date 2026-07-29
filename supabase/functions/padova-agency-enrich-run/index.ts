// Run controllato di agency enrichment su listing Padova senza agency reale.
// Auth: x-job-secret == CENTRAL_CORE_JOB_SECRET.
//
// Esecuzione bounded: deadline globale + timeout per URL + concorrenza limitata.
// Termina SEMPRE prima del limite Edge; gli URL non elaborati sono `deferred`
// e vengono ripresi al run successivo grazie all'ordinamento di fairness.
//
// Body:
//  { portals?: string[], limit_per_portal?: number, dry_run?: boolean,
//    force_refresh?: boolean, recompute?: boolean, only_missing?: boolean,
//    cache_only?: boolean, deadline_ms?: number, url_timeout_ms?: number,
//    concurrency?: number }

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  enrichListingAgency,
  fetchCacheMeta,
  rankCandidates,
  runBounded,
  DEFAULT_URL_TIMEOUT_MS,
  type Portal,
  type RankedCandidate,
} from "../_shared/agencyEnrichment.ts";

const ALL_PORTALS: Portal[] = ["casa", "immobiliare", "idealista", "subito"];

// Wrapper cron: 120s. Edge idle timeout: 150s. Deadline con margine ampio.
const DEFAULT_DEADLINE_MS = 75_000;
const DEFAULT_CONCURRENCY = 2;
const CANDIDATE_MULTIPLIER = 3;

function sb() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

interface PortalStats {
  analyzed: number;
  visited: number;
  from_cache: number;
  agency_found: number;
  high_conf: number;
  promoted: number;
  deferred: number;
  budget_skip: number;
  blocked_antibot: number;
  timed_out: number;
  update_errors: number;
  coverage_pct_after: number;
  errors: Record<string, number>;
  examples: { url: string; agency: string | null; method: string; confidence: string }[];
}

function emptyStats(): PortalStats {
  return {
    analyzed: 0, visited: 0, from_cache: 0, agency_found: 0, high_conf: 0,
    promoted: 0, deferred: 0, budget_skip: 0, blocked_antibot: 0, timed_out: 0,
    update_errors: 0, coverage_pct_after: 0, errors: {}, examples: [],
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const debugId = crypto.randomUUID();
  const startedAt = new Date();
  const t0 = Date.now();

  const finish = (payload: Record<string, unknown>, status = 200) => {
    const completedAt = new Date();
    return new Response(
      JSON.stringify({
        debug_id: debugId,
        started_at: startedAt.toISOString(),
        completed_at: completedAt.toISOString(),
        duration_ms: completedAt.getTime() - t0,
        ...payload,
      }),
      { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  };

  try {
    const sec = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
    const got = req.headers.get("x-job-secret") ?? "";
    if (!sec || got !== sec) {
      return finish({ ok: false, run_status: "failure", error: { code: "unauthorized", message: "Accesso non consentito." } }, 401);
    }

    const body = await req.json().catch(() => ({})) as {
      portals?: string[]; limit_per_portal?: number; dry_run?: boolean;
      force_refresh?: boolean; recompute?: boolean; only_missing?: boolean;
      cache_only?: boolean; deadline_ms?: number; url_timeout_ms?: number;
      concurrency?: number;
    };

    const portals: Portal[] = (body.portals && body.portals.length
      ? body.portals.filter((p): p is Portal => (ALL_PORTALS as string[]).includes(p))
      : ALL_PORTALS);
    const limit = Math.max(1, Math.min(200, body.limit_per_portal ?? 40));
    const dryRun = !!body.dry_run;
    const cacheOnly = !!body.cache_only;
    const forceRefresh = !cacheOnly && !!body.force_refresh;
    const recompute = body.recompute !== false;
    const onlyMissing = body.only_missing !== false;
    const urlTimeoutMs = Math.max(5_000, Math.min(30_000, body.url_timeout_ms ?? DEFAULT_URL_TIMEOUT_MS));
    const deadlineMs = Math.max(10_000, Math.min(110_000, body.deadline_ms ?? DEFAULT_DEADLINE_MS));
    const concurrency = Math.max(1, Math.min(3, body.concurrency ?? DEFAULT_CONCURRENCY));

    // Margine: non avviare un URL se il tempo residuo non basta a completarlo.
    const RESERVE_MS = 8_000;
    const deadlineAt = t0 + deadlineMs;
    const shouldStart = () => Date.now() + urlTimeoutMs + RESERVE_MS <= deadlineAt;

    const c = sb();
    const perPortal: Record<string, PortalStats> = {};
    let deadlineReached = false;
    let anyPromoted = false;

    for (const portal of portals) {
      const stats = perPortal[portal] = emptyStats();

      const q = c.from("padova_collect_v2_items")
        .select("id, url, agency, updated_at")
        .eq("portal", portal)
        .not("url", "is", null)
        .order("updated_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false })
        .limit(limit * CANDIDATE_MULTIPLIER);
      if (onlyMissing) q.or("agency.is.null,agency.eq.,agency.ilike.portal:%");

      const { data: rows, error } = await q;
      if (error) {
        stats.errors["query_error"] = 1;
        continue;
      }
      if (!rows || rows.length === 0) continue;

      const urls = (rows as { id: number; url: string }[]).map((r) => r.url).filter(Boolean);
      const cacheMeta = forceRefresh ? new Map() : await fetchCacheMeta(urls);
      const ranked: RankedCandidate[] = rankCandidates(rows as { id: number; url: string }[], cacheMeta)
        .slice(0, limit);
      stats.analyzed = ranked.length;

      const deferred = await runBounded<RankedCandidate>(
        ranked,
        async (cand) => {
          try {
            const ext = await enrichListingAgency(cand.url, portal, {
              forceRefresh, cacheOnly, timeoutMs: urlTimeoutMs,
            });
            if (ext.from_cache) stats.from_cache++;
            else if (!ext.budget_skip && !ext.cache_only_miss) stats.visited++;

            if (ext.budget_skip) {
              stats.budget_skip++;
              stats.errors[ext.budget_skip] = (stats.errors[ext.budget_skip] ?? 0) + 1;
              return;
            }
            if (ext.cache_only_miss) {
              stats.errors["cache_only_miss"] = (stats.errors["cache_only_miss"] ?? 0) + 1;
              return;
            }
            if (ext.error === "blocked_by_antibot") stats.blocked_antibot++;
            if (ext.error === "local_timeout") stats.timed_out++;

            if (ext.raw_agency_name && ext.normalized_agency_name) {
              stats.agency_found++;
              if (ext.confidence === "high") stats.high_conf++;
              if (stats.examples.length < 5) {
                stats.examples.push({ url: cand.url, agency: ext.raw_agency_name, method: ext.extraction_method, confidence: ext.confidence });
              }
              if (!dryRun && !cacheOnly && (ext.confidence === "high" || ext.confidence === "medium")) {
                const { error: upErr } = await c.from("padova_collect_v2_items")
                  .update({ agency: ext.raw_agency_name })
                  .eq("id", cand.id);
                if (upErr) {
                  stats.update_errors++;
                  stats.errors["update_error"] = (stats.errors["update_error"] ?? 0) + 1;
                } else {
                  stats.promoted++;
                  anyPromoted = true;
                }
              }
            } else if (ext.error) {
              stats.errors[ext.error] = (stats.errors[ext.error] ?? 0) + 1;
            }
          } catch (e) {
            const msg = String((e as Error).message ?? e).slice(0, 80);
            stats.errors[`exception:${msg}`] = (stats.errors[`exception:${msg}`] ?? 0) + 1;
          }
        },
        { concurrency, shouldStart },
      );

      stats.deferred = deferred.length;
      if (deferred.length > 0) deadlineReached = true;

      const { count: total } = await c.from("padova_collect_v2_items").select("id", { count: "exact", head: true }).eq("portal", portal);
      const { count: withAg } = await c.from("padova_collect_v2_items").select("id", { count: "exact", head: true })
        .eq("portal", portal).not("agency", "is", null).neq("agency", "").not("agency", "ilike", "portal:%");
      stats.coverage_pct_after = total && total > 0 ? Math.round(((withAg ?? 0) / total) * 1000) / 10 : 0;

      if (!shouldStart()) {
        deadlineReached = true;
        // Non iniziare un nuovo portale se il tempo residuo non basta.
        const remaining = portals.slice(portals.indexOf(portal) + 1);
        for (const p of remaining) {
          if (!perPortal[p]) perPortal[p] = emptyStats();
        }
        break;
      }
    }

    const totals = Object.values(perPortal).reduce(
      (a, b) => ({
        analyzed: a.analyzed + b.analyzed,
        visited: a.visited + b.visited,
        from_cache: a.from_cache + b.from_cache,
        agency_found: a.agency_found + b.agency_found,
        promoted: a.promoted + b.promoted,
        deferred: a.deferred + b.deferred,
        budget_skipped: a.budget_skipped + b.budget_skip,
        timed_out: a.timed_out + b.timed_out,
        update_errors: a.update_errors + b.update_errors,
      }),
      { analyzed: 0, visited: 0, from_cache: 0, agency_found: 0, promoted: 0, deferred: 0, budget_skipped: 0, timed_out: 0, update_errors: 0 },
    );

    // Recompute: una sola volta, solo se almeno un'agenzia e' stata promossa.
    const recomputeRequested = recompute && !dryRun && !cacheOnly && anyPromoted;
    let recomputeExecuted = false;
    let recomputeError: string | null = null;
    if (recomputeRequested) {
      const { error: rcErr } = await c.rpc("recompute_padova_contendibili");
      if (rcErr) recomputeError = rcErr.message;
      else recomputeExecuted = true;
    }

    let runStatus:
      | "success" | "partial_deadline" | "skipped_budget" | "partial_failure" | "failure" = "success";
    if (totals.budget_skipped > 0 && totals.visited === 0) runStatus = "skipped_budget";
    else if (totals.deferred > 0) runStatus = "partial_deadline";
    else if (recomputeError || totals.update_errors > 0 || (totals.visited > 0 && totals.agency_found === 0)) {
      runStatus = "partial_failure";
    }

    const ok = runStatus !== "failure" && !recomputeError;

    return finish({
      ok,
      run_status: runStatus,
      deadline_reached: deadlineReached,
      analyzed: totals.analyzed,
      visited: totals.visited,
      from_cache: totals.from_cache,
      promoted: totals.promoted,
      deferred: totals.deferred,
      budget_skipped: totals.budget_skipped,
      timed_out: totals.timed_out,
      params: {
        portals, limit_per_portal: limit, dry_run: dryRun, cache_only: cacheOnly,
        force_refresh: forceRefresh, recompute, only_missing: onlyMissing,
        deadline_ms: deadlineMs, url_timeout_ms: urlTimeoutMs, concurrency,
      },
      per_portal: perPortal,
      totals,
      recompute_requested: recomputeRequested,
      recompute_executed: recomputeExecuted,
      recompute_error: recomputeError,
    });
  } catch (e) {
    console.error("[padova-agency-enrich-run] failure", String((e as Error).message ?? e));
    return finish({
      ok: false,
      run_status: "failure",
      error: { code: "internal_error", message: "Esecuzione non completata." },
    }, 500);
  }
});
