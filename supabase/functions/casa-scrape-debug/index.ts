// Casa.it collection debug. Default: inspect the LAST Apify casa run
// (no new crawl, no Firecrawl credits). Matches PROMPT_FIX_PARSER_CASA.md:
// do not recrawl until the collected structure is understood.
//
// Modes:
//   default     — last padova_apify_runs casa row + dataset sample (Apify)
//   ?cache=1    — re-parse the latest cached Firecrawl markdown (no network)
//   ?live=1     — explicit Firecrawl scrape (opt-in recrawl only)
import { parseCasaListPage } from "../_shared/casaParser.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireDiagnosticSecret, makeDebugId } from "../_shared/http.ts";
import { getApifyToken } from "../_shared/apify.ts";
import {
  ACTOR_CASA,
  CASA_PORTAL,
  redactApifyText,
  summarizeCasaDatasetItems,
} from "../_shared/casaCollect.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36";
const URL_TARGET = "https://www.casa.it/vendita/residenziale/padova";
const APIFY_BASE = "https://api.apify.com/v2";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-diagnostic-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function summarizeMarkdown(md: string, url: string) {
  const immobili = md.match(/casa\.it\/immobili\/\d+/g) ?? [];
  const parsed = parseCasaListPage(md, url);
  return {
    md_len: md.length,
    md_head: md.slice(0, 3000),
    immobili_links_total: immobili.length,
    immobili_links_unique: new Set(immobili).size,
    parsed_count: parsed.length,
    first_item: parsed[0] ?? null,
    sample_titles: parsed.slice(0, 5).map((p) => ({
      id: p.listing_id, title: p.title, price_eur: p.price_eur,
      surface_sqm: p.surface_sqm, zone: p.zone,
      agency_name: p.agency_name, agency_slug: p.agency_slug, is_privato: p.is_privato,
    })),
    agency_stats: {
      with_agency: parsed.filter((p) => !!p.agency_slug).length,
      private: parsed.filter((p) => p.is_privato).length,
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  // Checkpoint 1A: guardia fail-closed prima di client service-role, Firecrawl e scritture.
  const authFail = requireDiagnosticSecret(req, makeDebugId());
  if (authFail) return authFail;

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const u = new URL(req.url);
  const useCache = u.searchParams.get("cache") === "1";
  const useLive = u.searchParams.get("live") === "1";

  if (useCache) {
    const { data, error } = await supa
      .from("_casa_scrape_debug_cache")
      .select("id,url,md,created_at")
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      return new Response(JSON.stringify({ error: "no_cache", details: error?.message }), { status: 404 });
    }
    return new Response(JSON.stringify({
      mode: "cache", cache_id: data.id, cached_at: data.created_at,
      ...summarizeMarkdown(data.md, data.url),
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  if (useLive) {
    const key = Deno.env.get("FIRECRAWL_API_KEY");
    if (!key) return new Response(JSON.stringify({ error: "no_firecrawl_key" }), { status: 500 });

    const t0 = Date.now();
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: URL_TARGET,
        formats: ["markdown"],
        onlyMainContent: false,
        waitFor: 3000,
        proxy: "auto",
        headers: { "User-Agent": UA, "Accept-Language": "it-IT,it;q=0.9,en;q=0.7" },
      }),
    });
    const elapsed_ms = Date.now() - t0;
    const body = await res.text();
    let md = "";
    try {
      const j = JSON.parse(body);
      md = j?.data?.markdown ?? j?.markdown ?? "";
    } catch { /* ignore */ }

    if (!md) {
      return new Response(JSON.stringify({
        mode: "live", status: res.status, elapsed_ms, md_len: 0, body_head: redactApifyText(body).slice(0, 800),
      }), { headers: { "Content-Type": "application/json" } });
    }

    await supa.from("_casa_scrape_debug_cache").insert({ url: URL_TARGET, md });

    return new Response(JSON.stringify({
      mode: "live", status: res.status, elapsed_ms,
      ...summarizeMarkdown(md, URL_TARGET),
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  const { data: run, error: runErr } = await supa
    .from("padova_apify_runs")
    .select("run_id,dataset_id,status,started_at,finished_at,items_count,imported,error,actor_id,portal")
    .eq("portal", CASA_PORTAL)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (runErr) {
    return new Response(JSON.stringify({
      mode: "apify_last_run", error: "run_lookup_failed", details: runErr.message,
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  if (!run) {
    return new Response(JSON.stringify({
      mode: "apify_last_run",
      error: "no_casa_apify_run",
      note: "Nessun run Casa.it in padova_apify_runs. Il nightly 02:30 UTC deve lanciare benthepythondev~casa-it-scraper con locations=['Padova'].",
    }, null, 2), { status: 404, headers: { "Content-Type": "application/json" } });
  }

  const token = getApifyToken();
  if (!token) {
    return new Response(JSON.stringify({
      mode: "apify_last_run",
      run,
      error: "APIFY_API_TOKEN_missing",
    }, null, 2), { status: 503, headers: { "Content-Type": "application/json" } });
  }

  let sample: unknown[] = [];
  let dataset_error: string | null = null;
  if (run.dataset_id) {
    try {
      const dr = await fetch(
        `${APIFY_BASE}/datasets/${encodeURIComponent(run.dataset_id)}/items?clean=1&limit=8`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!dr.ok) {
        dataset_error = `apify_dataset_${dr.status}`;
      } else {
        const items = await dr.json();
        if (Array.isArray(items)) sample = items;
      }
    } catch (e) {
      dataset_error = String((e as Error)?.message ?? e).slice(0, 160);
    }
  }

  const summary = summarizeCasaDatasetItems(sample);
  return new Response(JSON.stringify({
    mode: "apify_last_run",
    actor_id: ACTOR_CASA,
    run,
    dataset_error,
    dataset_summary: summary,
    sample_head: sample.slice(0, 2),
    note: "Default is last Apify run (no recrawl). Use ?cache=1 for cached markdown, ?live=1 for an explicit Firecrawl scrape.",
  }, null, 2), { headers: { "Content-Type": "application/json" } });
});
