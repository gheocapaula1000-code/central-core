// test-casa-ingest-batch
// Persistenza a batch del Firecrawl crawl casa.it su public.test_casa_raw_pages.
// Ogni invocazione scarica UNA pagina di paginazione Firecrawl (cursor o base) e
// la salva, poi ritorna il next_cursor. RAM tenuta bassa: 1 pagina alla volta.
//
// Input: { job_id: uuid, crawl_id: string, cursor?: string }
// Output: { ok, inserted, page_count, next_cursor, done }
//
// Auth: x-job-secret = CENTRAL_CORE_JOB_SECRET.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const FIRECRAWL_BASE = "https://api.firecrawl.dev";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "x-core-function": "test-casa-ingest-batch" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const expected = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const provided = req.headers.get("x-job-secret") ?? "";
  if (!expected || provided !== expected) {
    return json({ ok: false, error: { code: "unauthorized", message: "x-job-secret required" } }, 401);
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const jobId = String(body.job_id ?? "");
  const crawlId = String(body.crawl_id ?? "");
  const cursor: string | undefined = body.cursor ? String(body.cursor) : undefined;
  if (!jobId || !crawlId) return json({ ok: false, error: { code: "bad_input", message: "job_id and crawl_id required" } }, 400);

  const fcKey = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
  if (!fcKey) return json({ ok: false, error: { code: "missing_secret", message: "FIRECRAWL_API_KEY missing" } }, 500);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Resolve starting offset for page_index (append-only, idempotent on conflict).
  const { data: maxRow } = await sb
    .from("test_casa_raw_pages")
    .select("page_index")
    .eq("job_id", jobId)
    .order("page_index", { ascending: false })
    .limit(1);
  let nextIndex = (Array.isArray(maxRow) && maxRow[0]?.page_index != null) ? Number(maxRow[0].page_index) + 1 : 0;

  const url = cursor || `${FIRECRAWL_BASE}/v2/crawl/${encodeURIComponent(crawlId)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${fcKey}` } });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    return json({ ok: false, error: { code: "firecrawl_http", message: `Firecrawl ${r.status}: ${txt.slice(0, 200)}` } }, 502);
  }
  const j: any = await r.json().catch(() => ({}));
  const pages: any[] = Array.isArray(j?.data) ? j.data : [];

  // Insert in DB (chunked, ignore duplicates via upsert on PK)
  const rows = pages.map((p) => {
    const meta = p?.metadata ?? {};
    const srcUrl = String(meta?.sourceURL ?? meta?.url ?? "");
    const md = typeof p?.markdown === "string" ? p.markdown : "";
    return {
      job_id: jobId,
      crawl_id: crawlId,
      page_index: nextIndex++,
      url: srcUrl || null,
      markdown: md,
    };
  });

  let inserted = 0;
  const CHUNK = 10;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error, count } = await sb
      .from("test_casa_raw_pages")
      .upsert(slice, { onConflict: "job_id,page_index", count: "exact" });
    if (error) return json({ ok: false, error: { code: "db_insert", message: error.message } }, 500);
    inserted += (count ?? slice.length);
  }

  const nextCursor: string | null = (j?.next as string | undefined) ?? null;
  return json({
    ok: true,
    inserted,
    page_count: rows.length,
    next_cursor: nextCursor,
    done: !nextCursor,
    last_page_index: nextIndex - 1,
  });
});
