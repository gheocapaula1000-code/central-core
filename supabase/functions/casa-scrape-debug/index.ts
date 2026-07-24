// One-shot debug: single Firecrawl /v2/scrape on casa.it Padova list-page.
// Protected by CENTRAL_CORE_JOB_SECRET via x-job-secret header.
import { parseCasaListPage } from "../_shared/casaParser.ts";

const UA_POOL = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
];

Deno.serve(async (req) => {
  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if ((req.headers.get("x-job-secret") ?? "") !== jobSecret || !jobSecret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }
  const key = Deno.env.get("FIRECRAWL_API_KEY");
  if (!key) return new Response(JSON.stringify({ error: "no_firecrawl_key" }), { status: 500 });

  const url = "https://www.casa.it/vendita/residenziale/padova";
  const t0 = Date.now();
  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
      onlyMainContent: false,
      waitFor: 3000,
      headers: {
        "User-Agent": UA_POOL[0],
        "Accept-Language": "it-IT,it;q=0.9,en;q=0.7",
      },
    }),
  });
  const elapsed_ms = Date.now() - t0;
  const status = res.status;
  const body = await res.text();
  let md = "";
  try {
    const j = JSON.parse(body);
    md = j?.data?.markdown ?? j?.markdown ?? "";
  } catch { /* ignore */ }

  if (!md) {
    return new Response(JSON.stringify({
      status, elapsed_ms, md_len: 0,
      body_head: body.slice(0, 800),
    }), { headers: { "Content-Type": "application/json" } });
  }

  const immobiliLinks = md.match(/casa\.it\/immobili\/\d+/g) ?? [];
  const parsed = parseCasaListPage(md, url);
  const first = parsed[0] ?? null;

  return new Response(JSON.stringify({
    status, elapsed_ms,
    md_len: md.length,
    md_head: md.slice(0, 3000),
    immobili_links_total: immobiliLinks.length,
    immobili_links_unique: new Set(immobiliLinks).size,
    parsed_count: parsed.length,
    first_item: first,
    sample_titles: parsed.slice(0, 5).map((p) => ({
      id: p.listing_id, title: p.title, price_eur: p.price_eur,
      surface_sqm: p.surface_sqm, zone: p.zone,
      agency_name: p.agency_name, is_privato: p.is_privato,
    })),
  }, null, 2), { headers: { "Content-Type": "application/json" } });
});
