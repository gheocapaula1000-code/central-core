// Orchestrator: build Veneto intelligence from the Perplexity-derived registry.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { PERPLEXITY_VENETO_SOURCES, pxRegistryStats } from "../firecrawl/perplexitySources.ts";
import { runVenetoOpenDataImport } from "../openData/ckanImporter.ts";
import { runMicrozoneSentiment, runTurnoverSignals } from "../intelligence/sentimentTurnover.ts";
import { normalizePadovaCanonicalMicrozone, resolvePadovaCanonicalMicrozoneByPoint } from "../../_shared/padovaCanonicalMicrozones.ts";

export interface OrchestratorOpts {
  dryRun: boolean;
  runOpenData: boolean;
  runGeoEnvironment: boolean;
  runOmiNotes: boolean;
  runUrbanPlanning: boolean;
  runMicrozoneSentiment: boolean;
  runTurnoverSignals: boolean;
  runAreaScores: boolean;
  runApify: boolean;
  province: string[];
  comuni?: string[];
  import: boolean;
}

function supa() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
}

export async function buildVenetoIntelligenceFromResearch(opts: OrchestratorOpts) {
  const t0 = Date.now();
  const sb = supa();
  const report: any = {
    ok: false,
    started_at: new Date().toISOString(),
    registry_stats: pxRegistryStats(),
    sources_registered: 0,
    sources_needs_url_resolution: 0,
    open_data: null,
    sentiment: null,
    turnover: null,
    area_scores_refresh: null,
    duration_ms: 0,
    errors: [] as string[],
    warnings: [] as string[],
  };
  if (!sb) { report.errors.push("supabase missing"); return report; }

  // 1) Sync registry into data_sources
  const upserts = PERPLEXITY_VENETO_SOURCES.map((s) => ({
    source_name: s.source_name,
    source_type: s.source_type,
    base_url: s.base_url,
    coverage_area: s.coverage_area,
    province: s.province,
    comuni: s.comuni ?? [],
    allowed_paths: s.allowed_paths ?? [],
    excluded_paths: s.excluded_paths ?? [],
    expected_entities: s.expected_entities,
    format_expected: s.format_expected,
    ingestion_method: s.ingestion_method,
    ingestion_status: s.ingestion_method === "needs_url_resolution" ? "needs_url_resolution" : "ready",
    quality_default: s.quality_default,
    reliability_score: s.reliability_score,
    freshness_score: s.freshness_score,
    allowed_use: s.allowed_use,
    notes: s.notes ?? null,
    priority: s.priority * 20,
  }));
  if (!opts.dryRun) {
    const { error } = await sb.from("data_sources").upsert(upserts, { onConflict: "source_name" });
    if (error) report.errors.push(`registry upsert: ${error.message}`);
    else report.sources_registered = upserts.length;
  }
  report.sources_needs_url_resolution = upserts.filter((u) => u.ingestion_status === "needs_url_resolution").length;

  // 2) CKAN open data
  if (opts.runOpenData) {
    report.open_data = await runVenetoOpenDataImport({
      keywords: ["urbanistica","piano interventi","quartieri","rumore","mobilità","parcheggi","edifici","strade","ambiente","aria","verde","scuole","alienazioni","patrimonio"],
      province: opts.province, dryRun: opts.dryRun, import: opts.import,
    });
  }

  // 3) Sentiment microzone
  if (opts.runMicrozoneSentiment) {
    report.sentiment = await runMicrozoneSentiment({
      province: opts.province, comuni: opts.comuni, dryRun: opts.dryRun, import: opts.import,
    });
  }
  // 4) Turnover
  if (opts.runTurnoverSignals) {
    report.turnover = await runTurnoverSignals({
      province: opts.province, comuni: opts.comuni, dryRun: opts.dryRun, import: opts.import,
    });
  }

  // 5) Geo/ARPAV/OMI/Urban: scaffolding stubs that record runs in ingestion_runs
  const stubs: Array<{ name: string; enabled: boolean; reason: string }> = [
    { name: "import-veneto-geo-environment", enabled: opts.runGeoEnvironment, reason: "ARPAV/Geoportale: layer WMS/WFS, requires per-layer URL resolution." },
    { name: "import-omi-territorial-notes", enabled: opts.runOmiNotes, reason: "OMI Note Territoriali: PDF parser pipeline, requires OMI publications endpoint resolution." },
    { name: "import-urban-planning", enabled: opts.runUrbanPlanning, reason: "PI/PAT/PUA: per-comune Firecrawl pages registered; deep extraction handled by territorial signal extractor." },
  ];
  report.subjobs = stubs.filter((s) => s.enabled).map((s) => ({ name: s.name, status: "registered_only", note: s.reason }));

  // 6) Area scores quick refresh: bump area_opportunity_scores for comuni with new sentiment/turnover data
  if (opts.runAreaScores && !opts.dryRun && opts.import) {
    try {
      const { data: ms } = await sb.from("microzone_sentiment").select("comune,provincia,area_label,lat,lng,sentiment_score_total,confidence_score").range(0, 999);
      const { data: tv } = await sb.from("turnover_signals").select("comune,provincia,turnover_potential_score,confidence_score").range(0, 999);
      const tvMap = new Map<string, any>();
      for (const r of (tv ?? [])) tvMap.set(`${r.provincia}:${String(r.comune).toLowerCase()}`, r);
      const inserts: any[] = [];
      for (const r of (ms ?? [])) {
        const k = `${r.provincia}:${String(r.comune).toLowerCase()}`;
        const tov = tvMap.get(k);
        const sScore = Number(r.sentiment_score_total) || 0;
        const tScore = tov ? Number(tov.turnover_potential_score) || 0 : 0;
        const composite = Math.round((sScore * 0.55 + tScore * 0.45));
        const resolvedMicrozone = normalizePadovaCanonicalMicrozone(r.area_label) ??
          (String(r.comune ?? "").toLowerCase() === "padova"
            ? (await resolvePadovaCanonicalMicrozoneByPoint(sb, r.lat, r.lng))?.slug ?? null
            : null);
        inserts.push({
          region: "veneto", province: r.provincia, municipality: r.comune,
          microzone: resolvedMicrozone, score: composite,
          temperature: composite >= 75 ? "molto_calda" : composite >= 55 ? "calda" : composite >= 30 ? "tiepida" : "fredda",
          components: { sentiment: sScore, turnover: tScore },
          data_basis: "microzone_sentiment+turnover_signals",
          quality: "parziale",
          computed_at: new Date().toISOString(),
        });
      }
      if (inserts.length) {
        for (let i = 0; i < inserts.length; i += 200) {
          const chunk = inserts.slice(i, i + 200);
          const { error } = await sb.from("area_opportunity_scores").insert(chunk);
          if (error) { report.errors.push(`aos insert: ${error.message}`); break; }
        }
        report.area_scores_refresh = inserts.length;
      }
    } catch (e) {
      report.errors.push(`aos: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  report.duration_ms = Date.now() - t0;
  await sb.from("ingestion_runs").insert({
    job_name: "build-veneto-intelligence-from-research",
    source_name: "perplexity_registry",
    status: report.errors.length ? "completed_with_errors" : "completed",
    duration_ms: report.duration_ms,
    rows_in: 0,
    rows_out: (report.sentiment?.rows_written ?? 0) + (report.turnover?.rows_written ?? 0) + (report.open_data?.documents_saved ?? 0),
    warnings: report.warnings,
    errors: report.errors,
    report,
    completed_at: new Date().toISOString(),
  });
  report.ok = true;
  return report;
}
