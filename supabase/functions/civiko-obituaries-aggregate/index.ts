// ═══════════════════════════════════════════════════════════════
// civiko-obituaries-aggregate
//
// Legge obituaries_sources attive (region=veneto) → per ogni fonte fa fetch
// via Firecrawl del listing markdown → aggrega in bucket per CAP PD via
// _shared/obituariesAggregator (stateless, PII-free) → passa ogni bucket
// per assertAggregateBucket() → upsert in obituaries_aggregate_padova.
//
// Bucket con count < 3 vengono SCARTATI in aggregator (nessuna scrittura).
// Bucket con count 3-4 vengono scritti con visible_to_pwa=false (heatmap
// interna sì, esposizione pubblica no).
//
// Auth: internal-secret only.
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  aggregateObituariesMarkdown,
  mergeAggregations,
  type AggregatorBucket,
} from "../_shared/obituariesAggregator.ts";
import { assertAggregateBucket } from "../_shared/aggregateBucketGuard.ts";
import { isJobSecretAuthorized, constantTimeEqual } from "../_shared/http.ts";
import { writeSourceRegistryStatus } from "../_shared/sourceRegistryStatus.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret, x-job-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface SourceRow {
  id: number;
  name: string;
  base_url: string;
  search_url_template: string | null;
  source_type: string;
  reliability_score: number | null;
}

interface RunReport {
  ok: boolean;
  dry_run: boolean;
  sources_processed: number;
  sources_failed: number;
  buckets_generated: number;
  buckets_written: number;
  buckets_rejected_guard: number;
  buckets_below_k: number;
  entries_scanned_total: number;
  per_source: Array<{
    source_code: string;
    ok: boolean;
    entries_scanned: number;
    unique_caps: number;
    buckets: number;
    error?: string;
  }>;
  merged_buckets: Array<{ area_code: string; bucket_count: number; source_code: string; visible_to_pwa: boolean }>;
  window_days: number;
  window_start: string;
  window_end: string;
}

const WINDOW_DAYS = 90;
const K_ANONYMITY = 3;
const PUBLIC_VISIBILITY_MIN = 5; // count 3-4 → visible_to_pwa=false; ≥5 → true

// Costruisce URL Firecrawl-friendly per la lista Padova di ogni fonte.
function buildListingUrl(src: SourceRow): string {
  const tpl = src.search_url_template ?? src.base_url;
  // Finestra rolling: data_da = oggi - WINDOW_DAYS (YYYY-MM-DD)
  const dataDa = new Date(Date.now() - WINDOW_DAYS * 86_400_000)
    .toISOString().slice(0, 10);
  return tpl
    .replace("{region}", "veneto")
    .replace("{municipality}", "padova")
    .replace("{data_da}", dataDa);
}

// Deriva un source_code stabile dal name (snake_case).
function sourceCode(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

async function fetchListingMarkdown(url: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
      onlyMainContent: true,
      waitFor: 2000,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`firecrawl ${res.status}`);
  const md = data?.markdown ?? data?.data?.markdown ?? "";
  if (typeof md !== "string") throw new Error("no_markdown");
  return md;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Auth: x-job-secret (pg_cron / GitHub Actions) or x-internal-secret (legacy).
  const expected = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const jobOk = isJobSecretAuthorized(req, expected);
  const incomingInternal = req.headers.get("x-internal-secret") ?? "";
  const legacy = Boolean(expected && incomingInternal && constantTimeEqual(incomingInternal, expected));
  if (!jobOk && !legacy) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const body = await req.json().catch(() => ({}));
  const dryRun: boolean = body?.dry_run === true;

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const fcKey = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
  const supa = createClient(url, key, { auth: { persistSession: false } });

  if (!fcKey) {
    await writeSourceRegistryStatus(supa, "F19", {
      ok: false,
      records: 0,
      error: "firecrawl_key_missing",
    });
    return new Response(JSON.stringify({ ok: false, records_processed: 0, error: "firecrawl_key_missing" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Carica sorgenti attive Veneto. In dry_run consideriamo anche quelle inattive
  // per poter validare parser+guard senza dover attivare in DB.
  const q = supa.from("obituaries_sources").select("id,name,base_url,search_url_template,source_type,reliability_score,is_active").eq("region", "veneto");
  const { data: sources, error: srcErr } = dryRun ? await q : await q.eq("is_active", true);
  if (srcErr) {
    await writeSourceRegistryStatus(supa, "F19", {
      ok: false,
      records: 0,
      error: srcErr.message.slice(0, 500),
    });
    return new Response(JSON.stringify({ ok: false, records_processed: 0, error: srcErr.message }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!sources || sources.length === 0) {
    await writeSourceRegistryStatus(supa, "F19", {
      ok: true,
      records: 0,
    });
    return new Response(JSON.stringify({ ok: true, records_processed: 0, message: "no_active_sources" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const now = new Date();
  const windowEnd = now.toISOString().slice(0, 10);
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 86_400_000)
    .toISOString().slice(0, 10);

  const report: RunReport = {
    ok: true,
    dry_run: dryRun,
    sources_processed: 0,
    sources_failed: 0,
    buckets_generated: 0,
    buckets_written: 0,
    buckets_rejected_guard: 0,
    buckets_below_k: 0,
    entries_scanned_total: 0,
    per_source: [],
    merged_buckets: [],
    window_days: WINDOW_DAYS,
    window_start: windowStart,
    window_end: windowEnd,
  };

  const perSourceBuckets: AggregatorBucket[][] = [];

  const MAX_PAGES = 5;

  for (const s of sources as SourceRow[]) {
    const code = sourceCode(s.name);
    const baseUrl = buildListingUrl(s);
    // Se il template è una ricerca (contiene "?"), tentiamo fino a MAX_PAGES pagine.
    const isPaginated = baseUrl.includes("?");
    const urls = isPaginated
      ? Array.from({ length: MAX_PAGES }, (_, i) => `${baseUrl}&page=${i + 1}`)
      : [baseUrl];

    try {
      let combinedMd = "";
      for (const u of urls) {
        try {
          const md = await fetchListingMarkdown(u, fcKey);
          if (md && md.length > 100) combinedMd += "\n\n" + md;
        } catch {
          // singola pagina fallita → continuiamo con le altre
        }
      }
      const agg = aggregateObituariesMarkdown({
        markdown: combinedMd,
        source_code: code,
        window_days: WINDOW_DAYS,
      });
      // NOTA: `combinedMd` esce di scope qui, non viene loggato, salvato o passato oltre.
      report.entries_scanned_total += agg.stats.entries_scanned;
      report.per_source.push({
        source_code: code,
        ok: true,
        entries_scanned: agg.stats.entries_scanned,
        unique_caps: agg.stats.unique_caps,
        buckets: agg.buckets.length,
      });
      perSourceBuckets.push(agg.buckets);
      report.sources_processed++;
    } catch (e) {
      report.sources_failed++;
      report.per_source.push({
        source_code: code,
        ok: false,
        entries_scanned: 0,
        unique_caps: 0,
        buckets: 0,
        error: String((e as Error).message ?? e).slice(0, 120),
      });
    }
  }

  // Merge cross-source per CAP
  const merged = mergeAggregations(perSourceBuckets);
  report.buckets_generated = merged.length;

  const nowIso = now.toISOString();
  for (const b of merged) {
    // Enforce k-anonymity: aggregator già scarta <3 solo lato "no entries",
    // qui garantiamo su count MERGED cross-source.
    if (b.bucket_count < K_ANONYMITY) {
      report.buckets_below_k++;
      continue;
    }
    // Design PII-safe: visible_to_pwa è SEMPRE false (constraint DB).
    // La visibilità PWA è governata a livello di API/agency-authorization, non di bucket.
    const visible_to_pwa = false;
    const row = {
      area_type: b.area_type,
      area_code: b.area_code,
      window_start: windowStart,
      window_end: windowEnd,
      window_days: WINDOW_DAYS,
      bucket_count: b.bucket_count,
      source_url: null as string | null, // listing generico non persistito per privacy massima
      source_code: b.source_code,
      confidence: b.bucket_count >= 10 ? "high" : b.bucket_count >= 5 ? "medium" : "low",
      last_observed_at: nowIso,
      computed_at: nowIso,
      visible_to_pwa,
      imported_at: nowIso,
    };
    // Guard finale
    const g = assertAggregateBucket(row);
    if (!g.allowed) {
      report.buckets_rejected_guard++;
      continue;
    }
    report.merged_buckets.push({
      area_code: b.area_code,
      bucket_count: b.bucket_count,
      source_code: b.source_code,
      visible_to_pwa,
    });
    if (!dryRun) {
      const { error: upErr } = await supa
        .from("obituaries_aggregate_padova")
        .upsert(row, { onConflict: "area_type,area_code,window_start,window_end" });
      if (upErr) {
        (report as unknown as { upsert_errors?: string[] }).upsert_errors =
          [...((report as unknown as { upsert_errors?: string[] }).upsert_errors ?? []), upErr.message.slice(0, 200)];
      } else {
        report.buckets_written++;
      }
    }
  }

  await writeSourceRegistryStatus(supa, "F19", {
    ok: report.sources_failed === 0 || report.buckets_written > 0,
    records: report.buckets_written,
    error: report.sources_failed > 0 && report.buckets_written === 0
      ? "obituaries_sources_failed"
      : null,
  });

  return new Response(JSON.stringify({ ...report, records_processed: report.buckets_written }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
