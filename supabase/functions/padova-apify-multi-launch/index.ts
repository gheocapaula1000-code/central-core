// padova-apify-multi-launch
// Lancia in ASYNC fino a 3 actor Apify (idealista full, casa test, subito test).
// NON aspetta la fine: salva run_id + dataset_id in padova_apify_runs e ritorna.
// Auth: x-job-secret == CENTRAL_CORE_JOB_SECRET.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getApifyToken } from "../_shared/apify.ts";

const APIFY = "https://api.apify.com/v2";

interface LaunchBody {
  idealista?: { url_list?: string[]; from_db?: boolean; max_urls?: number; cost_cap_usd?: number };
  casa?: { search_url: string; cost_cap_usd?: number; max_items?: number };
  casa_full?: { search_location?: string; cost_cap_usd?: number; max_results?: number };
  subito?: { search_url: string; cost_cap_usd?: number; max_items?: number; only_private?: boolean };
  subito2?: { search_url?: string; cost_cap_usd?: number; max_items?: number };
}

interface Spec {
  portal: "idealista" | "casa" | "casa_full" | "subito" | "subito2";
  actor_id: string;
  input: Record<string, unknown>;
  cost_cap_usd: number;
}

async function startActor(actor: string, input: Record<string, unknown>, token: string) {
  const url = `${APIFY}/acts/${encodeURIComponent(actor)}/runs?token=${encodeURIComponent(token)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const txt = await r.text();
  if (!r.ok) {
    return { ok: false, error: `apify_${r.status}: ${txt.slice(0, 300)}` };
  }
  let j: Record<string, unknown> = {};
  try { j = JSON.parse(txt); } catch { /* ignore */ }
  const d = (j as { data?: { id?: string; defaultDatasetId?: string; status?: string } }).data ?? {};
  return { ok: true, run_id: d.id, dataset_id: d.defaultDatasetId, status: d.status };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!jobSecret || req.headers.get("x-job-secret") !== jobSecret) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

  const specs: Spec[] = [];

  let idealistaUrls: string[] = body.idealista?.url_list ?? [];
  let idealistaFromDbCount = 0;
  if (body.idealista && (!idealistaUrls.length) && body.idealista.from_db) {
    const cap = body.idealista.max_urls ?? 40;
    const { data: rows } = await sb
      .from("padova_collect_v2_items")
      .select("url")
      .ilike("url", "%idealista.it%")
      .ilike("url", "%/immobile/%")
      .order("url", { ascending: true })
      .limit(cap);
    idealistaUrls = (rows ?? []).map((r: { url: string }) => r.url).filter(Boolean);
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
    specs.push({
      portal: "casa_full",
      actor_id: "solidcode/casa-property-search-scraper",
      cost_cap_usd: body.casa_full.cost_cap_usd ?? 0.40,
      input: {
        searchLocation: body.casa_full.search_location ?? "Padova",
        propertyType: "all",
        maxResultsPerUrl: maxR,
        maxResults: maxR,
        language: "it",
      },
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

  if (specs.length === 0) {
    return new Response(JSON.stringify({ ok: false, error: "no_specs_provided" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const results = await Promise.all(specs.map(async (s) => {
    const r = await startActor(s.actor_id, s.input, token);
    if (!r.ok || !r.run_id) {
      await sb.from("padova_apify_runs").insert({
        portal: s.portal, actor_id: s.actor_id, run_id: "ERROR",
        status: "FAILED_TO_START", cost_cap_usd: s.cost_cap_usd, error: r.error ?? "unknown",
      });
      return { portal: s.portal, started: false, error: r.error };
    }
    await sb.from("padova_apify_runs").insert({
      portal: s.portal,
      actor_id: s.actor_id,
      run_id: r.run_id,
      dataset_id: r.dataset_id ?? null,
      status: r.status ?? "RUNNING",
      cost_cap_usd: s.cost_cap_usd,
    });
    return { portal: s.portal, started: true, run_id: r.run_id, dataset_id: r.dataset_id, status: r.status };
  }));

  return new Response(JSON.stringify({ ok: true, idealista_urls_from_db: idealistaFromDbCount, launched: results }, null, 2), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
