// One-shot debug: single Firecrawl /v2/scrape on casa.it Padova list-page.
// - Default: scrapes and stores markdown in public._casa_scrape_debug_cache
// - ?cache=1: re-parses the LATEST cached markdown (no Firecrawl call)
import { parseCasaListPage } from "../_shared/casaParser.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36";
const URL_TARGET = "https://www.casa.it/vendita/residenziale/padova";

function summarize(md: string, url: string) {
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
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const u = new URL(req.url);
  const useCache = u.searchParams.get("cache") === "1";

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
      ...summarize(data.md, data.url),
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

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
      mode: "live", status: res.status, elapsed_ms, md_len: 0, body_head: body.slice(0, 800),
    }), { headers: { "Content-Type": "application/json" } });
  }

  await supa.from("_casa_scrape_debug_cache").insert({ url: URL_TARGET, md });

  return new Response(JSON.stringify({
    mode: "live", status: res.status, elapsed_ms,
    ...summarize(md, URL_TARGET),
  }, null, 2), { headers: { "Content-Type": "application/json" } });
});
