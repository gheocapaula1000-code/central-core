// padova-apify-multi-launch
// Lancia in ASYNC fino a 3 actor Apify (idealista, casa, subito).
// NON aspetta la fine: salva run_id + dataset_id in padova_apify_runs e ritorna.
// Auth: x-job-secret / x-internal-secret / Bearer job secret.
// Empty body (cron) uses the default Padova plan. Stale RUNNING locks expire.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getApifyToken, startApifyRun } from "../_shared/apify.ts";
import { isJobSecretAuthorized, jobAuthFailure } from "../_shared/jobAuth.ts";
import {
  LOCK_LOOKBACK_MS,
  classifyMultiLaunchOutcome,
  decideInflightLock,
  defaultMultiLaunchBody,
  isEmptyLaunchBody,
  redactLaunchError,
} from "../_shared/padovaPortalLaunch.ts";

// APIFY base URL non più necessario: il fetch avviene dentro startApifyRun.

interface LaunchBody {
  idealista?: { url_list?: string[]; from_db?: boolean; max_urls?: number; cost_cap_usd?: number };
  casa?: { search_url: string; cost_cap_usd?: number; max_items?: number };
  casa_full?: { search_location?: string; start_urls?: string[]; cost_cap_usd?: number; max_results?: number };
  subito?: { search_url: string; cost_cap_usd?: number; max_items?: number; only_private?: boolean };
  subito2?: { search_url?: string; cost_cap_usd?: number; max_items?: number };
  subito_full?: { search_url?: string; cost_cap_usd?: number; max_items?: number };
}

interface Spec {
  portal: "idealista" | "casa" | "casa_full" | "subito" | "subito2" | "subito_full";
  actor_id: string;
  input: Record<string, unknown>;
  cost_cap_usd: number;
}

// startActor rimossa: usare startApifyRun da _shared/apify.ts (guardia budget + insert unificati).


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!jobSecret || !isJobSecretAuthorized(req.headers, jobSecret)) {
    const auth = jobAuthFailure(Boolean(jobSecret));
    return new Response(JSON.stringify({ ok: false, error: auth.error }),
      { status: auth.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const token = getApifyToken();
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: "APIFY_API_TOKEN_missing" }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  let body: LaunchBody = {};
  try { body = await req.json(); } catch { /* allow empty */ }
  if (isEmptyLaunchBody(body)) {
    body = defaultMultiLaunchBody() as LaunchBody;
  }

  const specs: Spec[] = [];

  let idealistaUrls: string[] = body.idealista?.url_list ?? [];
  let idealistaFromDbCount = 0;
  if (body.idealista && (!idealistaUrls.length) && body.idealista.from_db) {
    const cap = body.idealista.max_urls ?? 40;
    // Paginate explicitly with .range() to bypass Supabase's 1000-row default.
    const collected: string[] = [];
    const pageSize = 1000;
    for (let from = 0; from < cap && collected.length < cap; from += pageSize) {
      const to = Math.min(from + pageSize - 1, cap - 1);
      const { data: rows } = await sb
        .from("padova_collect_v2_items")
        .select("url")
        .ilike("url", "%idealista.it%")
        .ilike("url", "%/immobile/%")
        .order("url", { ascending: true })
        .range(from, to);
      const page = (rows ?? []).map((r: { url: string }) => r.url).filter(Boolean);
      collected.push(...page);
      if (page.length < pageSize) break;
    }
    idealistaUrls = collected;
    idealistaFromDbCount = idealistaUrls.length;
  }

  if (idealistaUrls.length) {
    specs.push({
      portal: "idealista",
      actor_id: "dz_omar/idealista-scraper-api",
      cost_cap_usd: body.idealista?.cost_cap_usd ?? 0.20,
      input: {
        Property_urls: idealistaUrls.map((u) => ({ url: u })),
        desiredResults: idealistaUrls.length,
      },
    });
  }

  if (body.casa?.search_url) {
    specs.push({
      portal: "casa",
      actor_id: "skebby/casa-it-scraper",
      cost_cap_usd: body.casa.cost_cap_usd ?? 0.05,
      input: {
        searchUrl: body.casa.search_url,
        maxItems: body.casa.max_items ?? 5,
        maxPages: 1,
        proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"], apifyProxyCountry: "IT" },
      },
    });
  }

  if (body.casa_full) {
    const maxR = body.casa_full.max_results ?? 1000;
    const startUrls = body.casa_full.start_urls ?? [];
    const input: Record<string, unknown> = {
      propertyType: "all",
      maxResultsPerUrl: maxR,
      maxResults: 0,
      ignoreUrlFailures: true,
      language: "it",
    };
    if (startUrls.length > 0) {
      input.startUrls = startUrls.map((u) => ({ url: u }));
    } else {
      input.searchLocation = body.casa_full.search_location ?? "Padova";
      input.maxResults = maxR;
    }
    specs.push({
      portal: "casa_full",
      actor_id: "solidcode/casa-property-search-scraper",
      cost_cap_usd: body.casa_full.cost_cap_usd ?? 0.40,
      input,
    });
  }

  if (body.subito?.search_url) {
    specs.push({
      portal: "subito",
      actor_id: "emastra/subito-it-immobili",
      cost_cap_usd: body.subito.cost_cap_usd ?? 0.05,
      input: {
        startUrls: [{ url: body.subito.search_url }],
        maxItems: body.subito.max_items ?? 5,
        onlyPrivate: body.subito.only_private ?? true,
      },
    });
  }

  if (body.subito2) {
    specs.push({
      portal: "subito2",
      actor_id: "azzouzana/subito-scraper-pro-by-search-url",
      cost_cap_usd: body.subito2.cost_cap_usd ?? 0.05,
      input: {
        searchUrl: body.subito2.search_url ?? "https://www.subito.it/annunci-veneto/vendita/immobili/padova/",
        maxItems: body.subito2.max_items ?? 5,
      },
    });
  }

  if (body.subito_full) {
    specs.push({
      portal: "subito_full",
      actor_id: "azzouzana/subito-scraper-pro-by-search-url",
      cost_cap_usd: body.subito_full.cost_cap_usd ?? 1.50,
      input: {
        // URL già filtrato lato Subito (?is=t = solo annunci di privati), percorso regionale
        // Veneto con filtro città Padova (l'unico path verificato funzionante 2026-06-20).
        searchUrl: body.subito_full.search_url ?? "https://www.subito.it/annunci-veneto/vendita/immobili/padova/?is=t",
        maxItems: body.subito_full.max_items ?? 1200,
      },
    });
  }





  if (specs.length === 0) {
    return new Response(JSON.stringify({ ok: false, error: "no_specs_provided" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const lookbackIso = new Date(Date.now() - LOCK_LOOKBACK_MS).toISOString();
  const results = await Promise.all(specs.map(async (s) => {
    const { data: inflight, error: inflightErr } = await sb
      .from("padova_apify_runs")
      .select("run_id, dataset_id, started_at, status")
      .eq("portal", s.portal)
      .in("status", ["RUNNING", "READY"])
      .gte("started_at", lookbackIso)
      .order("started_at", { ascending: false })
      .limit(1);
    if (inflightErr) {
      return { portal: s.portal, started: false, skipped: true, reason: "APIFY_DEDUP_CHECK_FAILED" };
    }
    const lock = decideInflightLock(inflight?.[0] ?? null, Date.now());
    if (lock.action === "reuse") {
      return {
        portal: s.portal,
        started: true,
        skipped: true,
        reason: "already_running",
        run_id: lock.run_id,
        dataset_id: lock.dataset_id || undefined,
        status: "RUNNING",
      };
    }
    if (lock.action === "expire") {
      await sb.from("padova_apify_runs").update({
        status: "STALE_LOCK",
        error: "stale_running_lock_expired",
        finished_at: new Date().toISOString(),
      }).eq("run_id", lock.run_id).in("status", ["RUNNING", "READY"]);
    }

    const res = await startApifyRun(s.actor_id, s.input, {
      portal: s.portal,
      estUsd: s.cost_cap_usd,
      costCapUsd: s.cost_cap_usd,
    });
    if (!res.started) {
      const reason = redactLaunchError(res.reason);
      console.warn(`[apify] lancio saltato: ${reason} portal=${s.portal}`);
      try {
        await sb.from("padova_apify_runs").insert({
          portal: s.portal,
          actor_id: s.actor_id,
          run_id: `failed-local-${Date.now()}-${s.portal}`,
          dataset_id: null,
          status: "FAILED",
          error: reason,
          cost_cap_usd: s.cost_cap_usd,
          finished_at: new Date().toISOString(),
        });
      } catch { /* best effort */ }
      return { portal: s.portal, started: false, skipped: true, reason };
    }
    return { portal: s.portal, started: true, run_id: res.run_id, dataset_id: res.dataset_id, status: "RUNNING" };
  }));

  const outcome = classifyMultiLaunchOutcome(results);
  return new Response(JSON.stringify({
    ok: outcome.ok,
    idealista_urls_from_db: idealistaFromDbCount,
    started_count: outcome.started_count,
    reused_count: outcome.reused_count,
    errors_count: outcome.errors_count,
    launched: results,
  }, null, 2), {
    status: outcome.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
