// ═══════════════════════════════════════════════════════════════
// Early Off-Market Signals Discovery Runner — DRY-RUN-FIRST.
// Pipeline:
//   1) Registry sources (filtrate per comuni/categorie)
//   2) Opzionale Perplexity discovery → URL extra (verificati a valle)
//   3) Per ogni source: fcMap + (fallback fcScrape su base_url)
//   4) Top N pagine: fcScrape + classifyEarlySignal
//   5) Costruisce CandidateEarlySignal[]
//   6) saveCandidates? (solo se body.saveCandidates=true) → DB
// Mai import in territorial_signals/radar_signals da qui.
// ═══════════════════════════════════════════════════════════════

import { fcMap, fcScrape, firecrawlAvailable } from "../firecrawl/firecrawlClient.ts";
import {
  selectEarlySources, EARLY_SIGNALS_REGISTRY,
  type EarlySignalSource, type EarlyCategory,
} from "./earlySignalsRegistry.ts";
import { classifyEarlySignal, type EarlySignalType } from "./earlySignalClassifier.ts";
import { perplexityAvailable, runPerplexityDiscovery, type DiscoveryHit } from "./perplexityDiscovery.ts";
import { matchPadovaMicrozona } from "./padovaMicrozoneMatcher.ts";
import { runPadovaMicrozonaDiscovery } from "./padovaMicrozonaPerplexity.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export interface DiscoveryBody {
  dryRun?: boolean;
  import?: boolean;
  saveCandidates?: boolean;
  comuni?: string[];
  categories?: EarlyCategory[];
  maxSources?: number;
  maxPagesPerSource?: number;
  maxDepth?: number;
  useFirecrawl?: boolean;
  useApify?: boolean;
  usePerplexityDiscovery?: boolean;
  downloadPdf?: boolean;
  // self-chain / time budget (tollerante ad extra fields)
  source_keys?: string[];
  chain_depth?: number;
  scrape_budget_remaining?: number;
  timeBudgetMs?: number;
}


export interface CandidateEarlySignal {
  comune: string;
  provincia: string;
  signal_type: EarlySignalType | "needs_review";
  title: string;
  summary: string;
  why_it_matters: string;
  possible_agent_action: string;
  timing: "early" | "active" | "monitoring";
  source_url: string;
  source_name: string;
  confidence_score: number;
  quality: "alta" | "media" | "bassa";
  data_basis: string;
  privacy_safe: boolean;
  needs_review: boolean;
  import_recommendation: "importable" | "needs_review" | "reject";
  reject_reason?: string;
  fingerprint: string;
}

export interface PerplexityErrorSampleEntry {
  query: string;
  status: number | null;
  message: string;
}

export interface DiscoveryReport {
  ok: boolean;
  run_id: string;
  perplexity_error_sample: PerplexityErrorSampleEntry[];
  dryRun: boolean;
  imported: false;
  saved_candidates: number;
  firecrawl_available: boolean;
  perplexity_available: boolean;
  sources_checked: number;
  sources_from_registry: number;
  sources_from_perplexity: number;
  pages_seen: number;
  pages_classified: number;
  candidate_signals_found: number;
  importable_candidates: number;
  needs_review_candidates: number;
  privacy_rejected: number;
  rejected_candidates: number;
  candidates_by_type: Record<string, number>;
  candidates_by_comune: Record<string, number>;
  top_20_candidate_signals: CandidateEarlySignal[];
  sample_importable: CandidateEarlySignal[];
  sample_needs_review: CandidateEarlySignal[];
  estimated_value_for_radar: "alto" | "medio" | "basso";
  cost_estimate: { firecrawl_credits: number; apify_runs: number; perplexity_queries: number };
  warnings: string[];
  errors: string[];
  deferred_source_keys: string[];
  elapsed_ms: number;
  time_budget_ms: number;
  scrape_budget_remaining: number;
}


function fingerprint(url: string, type: string): string {
  return `${type}::${url.replace(/[#?].*$/, "").toLowerCase()}`;
}

function reco(conf: number, privacy: boolean): "importable" | "needs_review" | "reject" {
  if (!privacy) return "reject";
  if (conf >= 0.7) return "importable";
  if (conf >= 0.4) return "needs_review";
  return "reject";
}

function urlSafe(u: string, src: EarlySignalSource): boolean {
  try {
    const url = new URL(u);
    const baseHost = new URL(src.base_url).hostname;
    if (url.hostname !== baseHost) return false;
    const path = url.pathname.toLowerCase();
    if (src.excluded_paths.some((x) => path.includes(x))) return false;
    return true;
  } catch { return false; }
}

function urlPriority(u: string, src: EarlySignalSource): number {
  try {
    const path = new URL(u).pathname.toLowerCase();
    return src.allowed_paths.some((p) => path.includes(p.toLowerCase())) ? 1 : 0;
  } catch { return 0; }
}

export async function runEarlyOffmarketDiscovery(body: DiscoveryBody): Promise<DiscoveryReport> {
  const dryRun = body.dryRun !== false;
  const useFC = body.useFirecrawl !== false;
  const usePplx = body.usePerplexityDiscovery !== false;
  const maxSources = Math.min(body.maxSources ?? 20, 30);
  const maxPagesPerSource = Math.min(body.maxPagesPerSource ?? 3, 5);
  const saveCandidates = body.saveCandidates === true;
  const run_id = `eos-${Date.now().toString(36)}`;
  const startedAt = Date.now();
  const timeBudget = Math.max(15_000, Math.min(body.timeBudgetMs ?? 90_000, 120_000));
  const chainDepth = typeof body.chain_depth === "number" ? body.chain_depth : 0;
  const defaultScrapeBudget = maxSources * maxPagesPerSource + 10;
  let scrapeBudget = typeof body.scrape_budget_remaining === "number"
    ? body.scrape_budget_remaining
    : defaultScrapeBudget;

  const warnings: string[] = [];
  const errors: string[] = [];
  const candidates: CandidateEarlySignal[] = [];
  const deferredSourceKeys: string[] = [];
  let pages_seen = 0, pages_classified = 0, privacy_rejected = 0;
  let perplexityQueries = 0;
  let sources_from_perplexity = 0;
  const pplxErrorDetails: PerplexityErrorSampleEntry[] = [];
  const mzErrorDetails: PerplexityErrorSampleEntry[] = [];
  const buildPerplexityErrorSample = (): PerplexityErrorSampleEntry[] =>
    [...pplxErrorDetails, ...mzErrorDetails]
      .slice(0, 3)
      .map((e) => ({
        query: (e.query ?? "").slice(0, 160),
        status: e.status ?? null,
        message: (e.message ?? "").slice(0, 150),
      }));

  const fcAvail = firecrawlAvailable();
  const pplxAvail = perplexityAvailable();

  let sources = selectEarlySources({
    comuni: body.comuni, categories: body.categories, maxSources,
  });
  if (body.source_keys && body.source_keys.length > 0) {
    const keep = new Set(body.source_keys);
    sources = sources.filter((s) => keep.has(s.source_key));
  }


  // ── Perplexity discovery (fonti aggiuntive, solo URL) — SOLO alla prima invocazione ──
  let pplxHits: DiscoveryHit[] = [];
  if (chainDepth === 0 && usePplx && pplxAvail) {
    const r = await runPerplexityDiscovery({ comuni: body.comuni, maxQueries: 6 });
    perplexityQueries = 6;
    pplxHits = r.hits;
    sources_from_perplexity = pplxHits.length;
    if (r.errorDetails && r.errorDetails.length > 0) {
      for (const d of r.errorDetails) pplxErrorDetails.push(d);
    }
    if (r.errors.length > 0) warnings.push(`perplexity: ${r.errors.length} query con errori`);
  } else if (chainDepth === 0 && usePplx && !pplxAvail) {
    warnings.push("PERPLEXITY_API_KEY mancante: discovery disattivata");
  }


  if (!useFC || !fcAvail) {
    return {
      ok: false, run_id,
      perplexity_error_sample: buildPerplexityErrorSample(),
      dryRun, imported: false, saved_candidates: 0,
      firecrawl_available: fcAvail, perplexity_available: pplxAvail,
      sources_checked: 0, sources_from_registry: sources.length, sources_from_perplexity,
      pages_seen: 0, pages_classified: 0, candidate_signals_found: 0,
      importable_candidates: 0, needs_review_candidates: 0, privacy_rejected: 0, rejected_candidates: 0,
      candidates_by_type: {}, candidates_by_comune: {},
      top_20_candidate_signals: [], sample_importable: [], sample_needs_review: [],
      estimated_value_for_radar: "basso",
      cost_estimate: { firecrawl_credits: 0, apify_runs: 0, perplexity_queries: perplexityQueries },
      warnings, errors: [...errors, "firecrawl unavailable or disabled"],
      deferred_source_keys: [],
      elapsed_ms: Date.now() - startedAt,
      time_budget_ms: timeBudget,
      scrape_budget_remaining: scrapeBudget,
    };

  }

  // ── Pipeline registry sources ──
  let fcCredits = 0;
  for (const src of sources) {
    try {
      // 1) Map
      const m = await fcMap(src.base_url, { limit: 30, search: "alienazione patrimonio variante rigenerazione" });
      fcCredits += 1;
      let urls = (m.links || []).filter((u) => urlSafe(u, src));
      urls.sort((a, b) => urlPriority(b, src) - urlPriority(a, src));
      if (urls.length === 0) urls = [src.base_url]; // fallback

      const top = urls.slice(0, maxPagesPerSource);
      for (const u of top) {
        const s = await fcScrape(u, { timeoutMs: 22_000 });
        fcCredits += 1;
        if (!s.ok || !s.markdown) {
          if (s.error) warnings.push(`${src.source_key} scrape ${u}: ${s.error}`);
          continue;
        }
        pages_seen += 1;
        const cls = classifyEarlySignal({ title: s.title ?? null, text: s.markdown, source_url: u }, src.comune);
        pages_classified += 1;
        if (!cls.privacy_safe) {
          privacy_rejected += 1;
          continue;
        }
        if (cls.signal_type === "irrelevant") continue;

        const cand: CandidateEarlySignal = {
          comune: src.comune, provincia: src.provincia,
          signal_type: cls.signal_type as EarlySignalType,
          title: (s.title || src.source_name).slice(0, 240),
          summary: cls.summary,
          why_it_matters: cls.why_it_matters,
          possible_agent_action: cls.possible_agent_action,
          timing: cls.timing,
          source_url: u, source_name: src.source_name,
          confidence_score: cls.confidence_score,
          quality: cls.quality,
          data_basis: `firecrawl:${src.source_key}; keywords:${cls.matched_keywords.slice(0,4).join("|")}`,
          privacy_safe: true,
          needs_review: cls.needs_review,
          import_recommendation: reco(cls.confidence_score, true),
          fingerprint: fingerprint(u, String(cls.signal_type)),
        };
        candidates.push(cand);
      }
    } catch (e) {
      errors.push(`${src.source_key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Pipeline Perplexity hits (verifica con scrape leggero) ──
  for (const hit of pplxHits.slice(0, 8)) {
    try {
      const s = await fcScrape(hit.source_url, { timeoutMs: 20_000 });
      fcCredits += 1;
      if (!s.ok || !s.markdown) continue;
      pages_seen += 1;
      const cls = classifyEarlySignal({ title: s.title ?? null, text: s.markdown, source_url: hit.source_url }, hit.comune);
      pages_classified += 1;
      if (!cls.privacy_safe) { privacy_rejected += 1; continue; }
      if (cls.signal_type === "irrelevant") continue;
      candidates.push({
        comune: hit.comune, provincia: hit.provincia,
        signal_type: cls.signal_type as EarlySignalType,
        title: (s.title || hit.title).slice(0, 240),
        summary: cls.summary,
        why_it_matters: cls.why_it_matters,
        possible_agent_action: cls.possible_agent_action,
        timing: cls.timing,
        source_url: hit.source_url,
        source_name: `perplexity_discovery:${hit.comune}`,
        confidence_score: Math.min(0.85, cls.confidence_score),
        quality: cls.quality, data_basis: `perplexity_discovery+firecrawl_verify`,
        privacy_safe: true, needs_review: cls.needs_review || cls.confidence_score < 0.7,
        import_recommendation: reco(cls.confidence_score, true),
        fingerprint: fingerprint(hit.source_url, String(cls.signal_type)),
      });
    } catch (e) {
      warnings.push(`perplexity-hit ${hit.source_url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Fase 2: Perplexity microzona-per-microzona (solo Padova, top-5) ──
  // 5 chiamate in sequenza con 500ms di pausa. Confidence base 0.4.
  // Dedup per title contro early_offmarket_signal_candidates a valle (vedi save block).
  const isPadovaTargeted =
    !body.comuni || body.comuni.length === 0 ||
    body.comuni.some((c) => c.toLowerCase().trim() === "padova");
  let microzonaQueries = 0;
  if (usePplx && pplxAvail && isPadovaTargeted) {
    try {
      const mz = await runPadovaMicrozonaDiscovery();
      microzonaQueries = mz.queries_run;
      if (mz.errorDetails && mz.errorDetails.length > 0) {
        for (const d of mz.errorDetails) mzErrorDetails.push(d);
      }
      if (mz.errors.length > 0) warnings.push(`perplexity_microzona: ${mz.errors.length} errori`);
      for (const h of mz.hits) {
        const cand: CandidateEarlySignal & { __microzona?: string; __location_detail?: string } = {
          comune: "Padova", provincia: "PD",
          signal_type: h.signal_type,
          title: h.title,
          summary: h.snippet || `Segnale ${h.signal_type} per microzona ${h.microzona_label}`,
          why_it_matters: `Microzona prioritaria ${h.microzona_label}: monitoraggio diretto su vendite private/successioni.`,
          possible_agent_action: `Verificare manualmente la fonte e contattare l'area ${h.microzona_label}.`,
          timing: "monitoring",
          source_url: h.source_url,
          source_name: `perplexity_microzona:${h.microzona_label}`,
          confidence_score: h.confidence,
          quality: "bassa",
          data_basis: `perplexity_microzona:${h.microzona_slug}`,
          privacy_safe: true,
          needs_review: true,
          import_recommendation: reco(h.confidence, true),
          fingerprint: fingerprint(h.source_url, `microzona:${h.microzona_slug}`),
        };
        cand.__microzona = h.microzona_slug;
        cand.__location_detail = h.microzona_label;
        candidates.push(cand);
      }
    } catch (e) {
      warnings.push(`perplexity_microzona exception: ${e instanceof Error ? e.message : String(e)}`);
    }
  }


  // dedup by fingerprint, keep highest confidence
  const map = new Map<string, CandidateEarlySignal>();
  for (const c of candidates) {
    const prev = map.get(c.fingerprint);
    if (!prev || c.confidence_score > prev.confidence_score) map.set(c.fingerprint, c);
  }
  const deduped = [...map.values()];

  // aggregations
  const by_type: Record<string, number> = {};
  const by_comune: Record<string, number> = {};
  let importable = 0, needs_review = 0, rejected = 0;
  for (const c of deduped) {
    by_type[c.signal_type] = (by_type[c.signal_type] ?? 0) + 1;
    by_comune[c.comune] = (by_comune[c.comune] ?? 0) + 1;
    if (c.import_recommendation === "importable") importable += 1;
    else if (c.import_recommendation === "needs_review") needs_review += 1;
    else rejected += 1;
  }
  deduped.sort((a, b) => b.confidence_score - a.confidence_score);

  // ── Optional persist (solo se richiesto esplicitamente) ──
  let saved_candidates = 0;
  if (saveCandidates && deduped.length > 0) {
    try {
      const url = Deno.env.get("SUPABASE_URL");
      const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!url || !svc) {
        warnings.push("save skipped: SUPABASE_SERVICE_ROLE_KEY missing");
      } else {
        const sb = createClient(url, svc, { auth: { persistSession: false } });

        // Dedup per title contro la tabella: niente duplicati di title già presenti.
        const incomingTitles = Array.from(new Set(deduped.map((c) => c.title).filter(Boolean)));
        const existingTitles = new Set<string>();
        if (incomingTitles.length > 0) {
          try {
            const { data: existing } = await sb
              .from("early_offmarket_signal_candidates")
              .select("title")
              .in("title", incomingTitles);
            for (const r of (existing ?? []) as Array<{ title: string }>) {
              if (r.title) existingTitles.add(r.title);
            }
          } catch { /* fallback: niente dedup per title se la query fallisce */ }
        }

        const rows = deduped
          .filter((c) => !existingTitles.has(c.title))
          .map((c) => {
            const ext = c as { __microzona?: string; __location_detail?: string };
            const isPadova = (c.comune || "").trim().toLowerCase() === "padova";
            const microzona = ext.__microzona ?? (isPadova
              ? matchPadovaMicrozona(c.title, c.summary, (c as { location_detail?: string }).location_detail)
              : null);
            const locDetail = ext.__location_detail
              ?? (c as { location_detail?: string }).location_detail
              ?? null;
            return {
              run_id, comune: c.comune, provincia: c.provincia,
              signal_type: c.signal_type, title: c.title, summary: c.summary,
              why_it_matters: c.why_it_matters, possible_agent_action: c.possible_agent_action,
              timing: c.timing, source_url: c.source_url, source_name: c.source_name,
              confidence_score: c.confidence_score, quality: c.quality, data_basis: c.data_basis,
              privacy_safe: c.privacy_safe, needs_review: c.needs_review,
              import_recommendation: c.import_recommendation, reject_reason: c.reject_reason ?? null,
              location_detail: locDetail,
              payload: { matched_keywords: [], dryRun, microzona },
              fingerprint: c.fingerprint,
            };
          });

        if (rows.length === 0) {
          saved_candidates = 0;
        } else {
          const { error, count } = await sb
            .from("early_offmarket_signal_candidates")
            .upsert(rows, { onConflict: "fingerprint", count: "exact", ignoreDuplicates: false });
          if (error) warnings.push(`save error: ${error.message}`);
          else saved_candidates = count ?? rows.length;
        }
      }
    } catch (e) {
      warnings.push(`save exception: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const value =
    importable >= 10 ? "alto" :
    importable + needs_review >= 6 ? "medio" : "basso";

  return {
    ok: true, run_id,
    perplexity_error_sample: buildPerplexityErrorSample(),
    dryRun, imported: false, saved_candidates,
    firecrawl_available: fcAvail, perplexity_available: pplxAvail,
    sources_checked: sources.length + (pplxHits.length > 0 ? 1 : 0),
    sources_from_registry: sources.length,
    sources_from_perplexity,
    pages_seen, pages_classified,
    candidate_signals_found: deduped.length,
    importable_candidates: importable,
    needs_review_candidates: needs_review,
    privacy_rejected,
    rejected_candidates: rejected,
    candidates_by_type: by_type,
    candidates_by_comune: by_comune,
    top_20_candidate_signals: deduped.slice(0, 20),
    sample_importable: deduped.filter((c) => c.import_recommendation === "importable").slice(0, 5),
    sample_needs_review: deduped.filter((c) => c.import_recommendation === "needs_review").slice(0, 5),
    estimated_value_for_radar: value,
    cost_estimate: { firecrawl_credits: fcCredits, apify_runs: 0, perplexity_queries: perplexityQueries + microzonaQueries },
    warnings, errors,
  };
}

export function listEarlyRegistryMeta() {
  return EARLY_SIGNALS_REGISTRY.map((s) => ({
    source_key: s.source_key, comune: s.comune, provincia: s.provincia,
    categories: s.categories, priority: s.priority, enabled: s.enabled,
  }));
}
