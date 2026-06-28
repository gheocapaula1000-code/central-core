// test-casa-parse-batch
// Parsa pagine markdown già raccolte in `test_casa_raw_pages` (no nuove
// chiamate esterne) ed effettua upsert su `test_casa_parsed_listings`.
//
// Input: { job_id: uuid, from_page?: number, to_page?: number, chunk?: number }
//   - from_page/to_page: range inclusivo (default: tutte le pagine del job)
//   - chunk: numero pagine processate in questa invocazione (default 25, max 120)
//
// Output:
//   {
//     ok, job_id, pages_processed, listings_upserted,
//     range: { from, to }, next_from_page | null, done,
//     stats: { with_price, with_surface, with_agency, privato }
//   }
//
// Auth: x-job-secret = CENTRAL_CORE_JOB_SECRET.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { parseCasaListPage } from "../_shared/casaParser.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "x-core-function": "test-casa-parse-batch",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const expected = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const provided = req.headers.get("x-job-secret") ?? "";
  if (!expected || provided !== expected) {
    return json(
      { ok: false, error: { code: "unauthorized", message: "x-job-secret required" } },
      401,
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* empty body ok */
  }

  const jobId = String(body.job_id ?? "");
  if (!jobId) {
    return json(
      { ok: false, error: { code: "bad_input", message: "job_id required" } },
      400,
    );
  }
  const chunk = Math.min(Math.max(Number(body.chunk ?? 25), 1), 120);
  const fromPage = body.from_page != null ? Number(body.from_page) : 0;
  const toPageReq = body.to_page != null ? Number(body.to_page) : undefined;

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const effectiveTo =
    toPageReq != null ? Math.min(toPageReq, fromPage + chunk - 1) : fromPage + chunk - 1;

  const { data: pages, error: readErr } = await sb
    .from("test_casa_raw_pages")
    .select("page_index,url,markdown")
    .eq("job_id", jobId)
    .gte("page_index", fromPage)
    .lte("page_index", effectiveTo)
    .order("page_index", { ascending: true });

  if (readErr) {
    return json(
      { ok: false, error: { code: "db_read", message: readErr.message } },
      500,
    );
  }

  const rows: Array<Record<string, unknown>> = [];
  let lastSeenPage = fromPage - 1;

  for (const p of pages ?? []) {
    lastSeenPage = Number(p.page_index);
    const parsed = parseCasaListPage(String(p.markdown ?? ""), String(p.url ?? ""));
    for (const it of parsed) {
      rows.push({
        job_id: jobId,
        page_index: lastSeenPage,
        listing_id: it.listing_id,
        source_url: it.source_url,
        title: it.title,
        zone: it.zone,
        price_eur: it.price_eur,
        surface_sqm: it.surface_sqm,
        rooms: it.rooms,
        bathrooms: it.bathrooms,
        floor: it.floor,
        energy_class: it.energy_class,
        description: it.description,
        agency_name: it.agency_name,
        agency_slug: it.agency_slug,
        agency_url: it.agency_url,
        is_privato: it.is_privato,
        badge: it.badge,
        tier: it.tier,
        raw_block: it.raw_block,
        parser_version: "v1",
      });
    }
  }

  // Dedup cross-page per listing_id (Postgres ON CONFLICT non tollera
  // 2+ righe con stessa chiave nello stesso upsert). Tieni la riga con
  // più campi popolati e l'occorrenza precedente come page_index.
  const scoreRow = (r: Record<string, unknown>) =>
    (r.price_eur ? 2 : 0) +
    (r.surface_sqm ? 1 : 0) +
    (r.agency_slug ? 2 : 0) +
    (r.description ? 1 : 0);
  const dedup = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const key = String(r.listing_id);
    const cur = dedup.get(key);
    if (!cur || scoreRow(r) > scoreRow(cur)) dedup.set(key, r);
  }
  const dedupRows = Array.from(dedup.values());

  // Upsert a chunk per evitare payload enormi
  let upserted = 0;
  const stats = { with_price: 0, with_surface: 0, with_agency: 0, privato: 0 };
  for (const r of dedupRows) {
    if (r.price_eur) stats.with_price++;
    if (r.surface_sqm) stats.with_surface++;
    if (r.agency_slug) stats.with_agency++;
    if (r.is_privato) stats.privato++;
  }

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error: upErr, count } = await sb
      .from("test_casa_parsed_listings")
      .upsert(slice, { onConflict: "job_id,listing_id", count: "exact" });
    if (upErr) {
      return json(
        {
          ok: false,
          error: { code: "db_upsert", message: upErr.message },
          partial_upserted: upserted,
        },
        500,
      );
    }
    upserted += count ?? slice.length;
  }

  // Check if more pages exist
  const { data: nextProbe } = await sb
    .from("test_casa_raw_pages")
    .select("page_index")
    .eq("job_id", jobId)
    .gt("page_index", lastSeenPage)
    .order("page_index", { ascending: true })
    .limit(1);
  const nextFrom = nextProbe && nextProbe.length > 0 ? Number(nextProbe[0].page_index) : null;

  return json({
    ok: true,
    job_id: jobId,
    pages_processed: pages?.length ?? 0,
    listings_upserted: upserted,
    range: { from: fromPage, to: lastSeenPage },
    next_from_page: nextFrom,
    done: nextFrom == null,
    stats,
  });
});
