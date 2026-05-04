// ═══════════════════════════════════════════════════════════════
// microzoneOpportunityRunner.ts
// Endpoint: POST /jobs/firecrawl-microzone-opportunity-signals
// Genera segnali aggregati di pressione successoria + estate
// turnover zones, mai targeting personale.
// ═══════════════════════════════════════════════════════════════
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { fcScrape, fcMap, firecrawlAvailable } from "./firecrawlClient.ts";
import { filterSources } from "./sourceRegistry.ts";
import { classifySensitiveSource } from "./privacyGuard.ts";
import { extractInheritancePressure, turnoverTemperature, type PressureCandidate } from "./inheritancePressureExtractor.ts";
import { sha1Hex } from "./dedupe.ts";
import { isVenetoProvince } from "./complianceGuards.ts";

export interface MicrozoneRequest {
  dryRun?: boolean;
  mode?: "deep" | "targeted";
  province?: string[];
  comuni?: string[];
  maxPagesPerSource?: number;
  maxDepth?: number;
  sourceTypes?: string[];
  import?: boolean;
}

export interface MicrozoneReport {
  ok: boolean;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  firecrawl_available: boolean;
  sources_crawled: number;
  pages_seen: number;
  documents_saved: number;
  aggregate_indicators_found: number;
  personal_data_sources_rejected: number;
  inheritance_pressure_candidates: number;
  estate_turnover_zones_candidates: number;
  imported_inheritance_signals: number;
  imported_estate_turnover_zones: number;
  rejected: number;
  privacy_rejected_examples: Array<{ url: string; reason: string }>;
  warnings: string[];
  errors: string[];
  top_microzone: Array<{ comune: string; provincia: string; score: number; reason: string }>;
  top_actions: Array<{ comune: string; agentAction: string; script: string }>;
  next_actions: string[];
}

function svc(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function runMicrozoneOpportunitySignals(req: MicrozoneRequest): Promise<MicrozoneReport> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const warnings: string[] = [];
  const errors: string[] = [];
  const rejectedExamples: Array<{ url: string; reason: string }> = [];
  const dryRun = req.dryRun !== false;
  const doImport = req.import === true && !dryRun;

  const report: MicrozoneReport = {
    ok: true, started_at: startedAt, ended_at: startedAt, duration_ms: 0,
    firecrawl_available: firecrawlAvailable(),
    sources_crawled: 0, pages_seen: 0, documents_saved: 0,
    aggregate_indicators_found: 0,
    personal_data_sources_rejected: 0,
    inheritance_pressure_candidates: 0, estate_turnover_zones_candidates: 0,
    imported_inheritance_signals: 0, imported_estate_turnover_zones: 0,
    rejected: 0, privacy_rejected_examples: rejectedExamples,
    warnings, errors,
    top_microzone: [], top_actions: [], next_actions: [],
  };

  const supa = svc();
  if (!supa) {
    errors.push("SUPABASE_SERVICE_ROLE_KEY mancante.");
    report.ok = false;
    finalize(report, t0); return report;
  }

  // ── 1) Estrai segnali aggregati da DB ufficiali (ISTAT/OMI/aste/SHC/AOS)
  const ipReport = await extractInheritancePressure(supa, {
    province: req.province, comuni: req.comuni,
  });
  report.aggregate_indicators_found = ipReport.aggregate_indicators_found;
  report.inheritance_pressure_candidates = ipReport.candidates.length;
  warnings.push(...ipReport.warnings);

  // Estate turnover zones = mappatura derivata dai pressure candidates
  const estateCandidates = ipReport.candidates.map((c) => ({
    fingerprint: `etz|${c.provincia}|${c.comune.toLowerCase()}`,
    comune: c.comune,
    provincia: c.provincia,
    microzona: null as string | null,
    area_label: c.area_label,
    score: c.score,
    temperature: turnoverTemperature(c.score),
    reason: c.reason,
    agentAction: c.agentAction,
    script: c.script,
    positive_factors: c.signal_basis,
    missing_factors: missingFactorsOf(c),
    source_urls: c.source_urls,
    data_basis: c.data_basis,
    quality: c.quality,
    confidence_score: c.confidence_score,
  }));
  report.estate_turnover_zones_candidates = estateCandidates.length;

  // ── 2) Firecrawl (opzionale) — solo per arricchimento e audit privacy
  if (req.mode === "deep" && report.firecrawl_available) {
    const sources = filterSources({
      province: req.province, comuni: req.comuni,
      sourceTypes: req.sourceTypes ?? ["municipal_notices","open_data","urban_planning"],
    }).slice(0, 6);
    const maxPages = Math.max(1, Math.min(60, req.maxPagesPerSource ?? 20));
    for (const s of sources) {
      report.sources_crawled++;
      const mapped = await fcMap(s.base_url, { limit: maxPages * 2 });
      const urls = (mapped.ok ? mapped.links : [s.base_url]).slice(0, maxPages);
      for (const url of urls) {
        report.pages_seen++;
        const res = await fcScrape(url, { timeoutMs: 20_000, formats: ["markdown"] });
        if (!res.ok) { warnings.push(`scrape ${url}: ${res.error}`); continue; }
        const decision = classifySensitiveSource({ url, title: res.title ?? null, markdown: res.markdown ?? null });
        const hash = await sha1Hex(url);
        await supa.from("inheritance_safe_source_documents").upsert({
          source_url: url,
          source_name: s.source_name,
          classification: decision.classification,
          contains_personal_data: !decision.allowed,
          imported_as_aggregate: decision.allowed,
          rejected_reason: decision.rejected_reason ?? null,
          extracted_aggregate_indicators: decision.allowed
            ? { excerpt: decision.redacted_excerpt }
            : {},
          provincia: isVenetoProvince(s.province?.[0]) ? s.province[0] : null,
          comune: s.comuni?.[0] ?? null,
          hash,
          fetched_at: new Date().toISOString(),
        }, { onConflict: "hash" }).then(({ error }) => { if (error) warnings.push(`issd ${url}: ${error.message}`); });
        if (decision.allowed) report.documents_saved++;
        else {
          report.personal_data_sources_rejected++;
          report.rejected++;
          if (rejectedExamples.length < 8) rejectedExamples.push({ url, reason: decision.rejected_reason ?? decision.classification });
        }
      }
    }
  } else if (req.mode === "deep") {
    warnings.push("Firecrawl non disponibile: solo estrattori aggregati DB attivi.");
  }

  // ── 3) Import (solo se import=true)
  if (doImport && ipReport.candidates.length > 0) {
    const fps = ipReport.candidates.map((c) => c.fingerprint);
    const { data: existing } = await supa.from("inheritance_pressure_signals").select("fingerprint").in("fingerprint", fps);
    const exSet = new Set((existing ?? []).map((x) => (x as { fingerprint: string }).fingerprint));
    const rows = ipReport.candidates.filter((c) => !exSet.has(c.fingerprint)).map((c) => ({
      region: "veneto",
      provincia: c.provincia,
      comune: c.comune,
      area_label: c.area_label,
      area_type: c.area_type,
      lat: c.lat, lng: c.lng,
      score: c.score,
      confidence_score: c.confidence_score,
      signal_basis: c.signal_basis,
      indicators: c.indicators,
      quality: c.quality,
      source_urls: c.source_urls,
      source_names: c.source_names,
      data_basis: c.data_basis,
      fingerprint: c.fingerprint,
    }));
    if (rows.length > 0) {
      const { error, count } = await supa.from("inheritance_pressure_signals").insert(rows, { count: "exact" });
      if (error) errors.push(`ip insert: ${error.message}`);
      else report.imported_inheritance_signals = count ?? rows.length;
    }

    const efps = estateCandidates.map((c) => c.fingerprint);
    const { data: ex2 } = await supa.from("estate_turnover_zones").select("fingerprint").in("fingerprint", efps);
    const ex2Set = new Set((ex2 ?? []).map((x) => (x as { fingerprint: string }).fingerprint));
    const erows = estateCandidates.filter((c) => !ex2Set.has(c.fingerprint)).map((c) => ({
      region: "veneto",
      provincia: c.provincia,
      comune: c.comune,
      microzona: c.microzona,
      area_label: c.area_label,
      score: c.score,
      temperature: c.temperature,
      reason: c.reason,
      agent_action: c.agentAction,
      script: c.script,
      positive_factors: c.positive_factors,
      missing_factors: c.missing_factors,
      source_urls: c.source_urls,
      data_basis: c.data_basis,
      quality: c.quality,
      confidence_score: c.confidence_score,
      fingerprint: c.fingerprint,
    }));
    if (erows.length > 0) {
      const { error, count } = await supa.from("estate_turnover_zones").insert(erows, { count: "exact" });
      if (error) errors.push(`etz insert: ${error.message}`);
      else report.imported_estate_turnover_zones = count ?? erows.length;
    }

    // Aggiungi anche radar_signals aggregati per visibilità in Radar (no targeting)
    const radarRows = ipReport.candidates.slice(0, 50).map((c) => ({
      signal_type: "inheritance_pressure",
      title: `Pressione patrimoniale aggregata — ${c.comune}`,
      description: c.reason,
      municipality: c.comune,
      province: c.provincia,
      lat: c.lat, lng: c.lng,
      source: c.source_names.join(","),
      confidence: c.confidence_score >= 60 ? "high" : "medium",
      urgency: c.score >= 70 ? "alta" : c.score >= 50 ? "media" : "bassa",
      payload: { aggregate: true, indicators: c.indicators, agentAction: c.agentAction, script: c.script, sourceUrls: c.source_urls, forbiddenTargeting: true, dataBasis: c.data_basis, quality: c.quality, confidence_score: c.confidence_score },
      fingerprint: `rs_${c.fingerprint}`.slice(0, 80),
      is_active: true,
    }));
    const rfps = radarRows.map((r) => r.fingerprint);
    const { data: exR } = await supa.from("radar_signals").select("fingerprint").in("fingerprint", rfps);
    const exRset = new Set((exR ?? []).map((x) => (x as { fingerprint: string }).fingerprint));
    const radarFiltered = radarRows.filter((r) => !exRset.has(r.fingerprint));
    if (radarFiltered.length > 0) {
      const { error } = await supa.from("radar_signals").insert(radarFiltered);
      if (error) warnings.push(`radar insert: ${error.message}`);
    }
  } else if (!doImport) {
    warnings.push("dryRun/import=false: candidati non scritti.");
  }

  // ── 4) Top microzone & azioni
  const sorted = [...ipReport.candidates].sort((a, b) => b.score - a.score);
  report.top_microzone = sorted.slice(0, 10).map((c) => ({
    comune: c.comune, provincia: c.provincia, score: c.score, reason: c.reason,
  }));
  report.top_actions = sorted.slice(0, 10).map((c) => ({
    comune: c.comune, agentAction: c.agentAction, script: c.script,
  }));

  if (ipReport.candidates.length === 0) {
    report.next_actions.push("Popolare ISTAT (istat-sdmx-fetch) e OMI per aumentare gli indicatori aggregati.");
  }
  if (!doImport && ipReport.candidates.length > 0) {
    report.next_actions.push("Rilanciare con import=true per persistere segnali e turnover zones.");
  }

  finalize(report, t0);
  return report;
}

function missingFactorsOf(c: PressureCandidate): string[] {
  const have = new Set(c.signal_basis);
  const all = [
    "istat_indice_vecchiaia","istat_over65","istat_over85",
    "omi_valori_aggregati","auction_signals_aggregati",
    "succession_heatmap_cap_aggregato","area_opportunity_scores",
  ];
  return all.filter((k) => !have.has(k));
}

function finalize(report: MicrozoneReport, t0: number) {
  report.ended_at = new Date().toISOString();
  report.duration_ms = Date.now() - t0;
}
