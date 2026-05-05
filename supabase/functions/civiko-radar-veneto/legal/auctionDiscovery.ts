// ═══════════════════════════════════════════════════════════════
// auctionDiscovery — dry run crawler per fonti aste/legali Veneto.
// Compliance-safe. Niente bypass. Niente import in dryRun.
// Supporta Firecrawl + fallback Apify (website-content-crawler).
// ═══════════════════════════════════════════════════════════════
import { fcMap, fcScrape, firecrawlAvailable } from "../firecrawl/firecrawlClient.ts";
import {
  AUCTION_SOURCE_REGISTRY,
  listEnabledSources,
  type AuctionSource,
  type AuctionSourceType,
  type ProvCode,
} from "./auctionSourceRegistry.ts";
import {
  extractAuctionCandidatesFromMarkdown,
  isLikelyDetailUrl,
  type AuctionCandidate,
} from "./auctionParser.ts";
import {
  apifyAvailable,
  isApifyEligible,
  runApifyAuctionSource,
} from "./apifyAuctionRunner.ts";

export interface DiscoverRequest {
  dryRun?: boolean;
  import?: boolean;
  province?: ProvCode[];
  sourceTypes?: AuctionSourceType[];
  maxSources?: number;
  maxPagesPerSource?: number;
  maxPdfPerSource?: number;
  maxDepth?: number;
  runFirecrawl?: boolean;
  runApify?: boolean;
  fallbackToApifyOnFirecrawlError?: boolean;
  downloadPdf?: boolean;
}

export interface DiscoverReport {
  ok: boolean;
  dryRun: boolean;
  importPerformed: boolean;
  config: Required<Omit<DiscoverRequest, "import" | "dryRun">>;
  sources_total: number;
  sources_checked: number;
  sources_allowed: number;
  sources_blocked: number;
  sources_manual_only: number;
  sources_skipped_manual_only: number;
  sources_used_firecrawl: number;
  sources_used_apify: number;
  apify_runs_started: number;
  apify_runs_succeeded: number;
  apify_runs_failed: number;
  dataset_items_read: number;
  pages_seen: number;
  detail_pages_seen: number;
  index_pages_seen: number;
  pdf_links_found: number;
  pdfs_downloaded: number;
  candidates_found: number;
  candidates_importable: number;
  candidates_needs_review: number;
  candidates_rejected: number;
  rejected_reasons: Record<string, number>;
  location_inference_stats: { from_text: number; from_title: number; from_breadcrumb: number; from_url: number; from_source_scope: number; failed: number };
  per_source: Array<{
    source_key: string;
    source_name: string;
    province_scope: ProvCode[] | "ALL_VENETO";
    method: "firecrawl" | "apify" | "skipped";
    apify_run_id?: string;
    apify_dataset_id?: string;
    pages_seen: number;
    pdf_links: number;
    candidates: number;
    error?: string;
  }>;
  sample_candidates: AuctionCandidate[];
  sample_needs_review: AuctionCandidate[];
  sample_rejected: Array<{ reason: string; source_url: string; excerpt?: string }>;
  errors: string[];
  warnings: string[];
  compliance_summary: {
    firecrawl_available: boolean;
    apify_available: boolean;
    captcha_bypass: false;
    login_bypass: false;
    aggressive_proxy: false;
    massive_blind_scrape: false;
    pdf_download_in_dry_run: false;
    manual_only_sources_excluded: true;
  };
  ready_for_controlled_import: boolean;
}

const PDF_LINK_RE = /\.pdf(?:[?#]|$)/i;

export async function discoverVenetoAuctions(req: DiscoverRequest): Promise<DiscoverReport> {
  const dryRun = req.dryRun !== false;
  const cfg = {
    province: req.province ?? (["PD", "VE", "VR", "VI", "TV", "BL", "RO"] as ProvCode[]),
    sourceTypes: req.sourceTypes ?? ([
      "ivg", "tribunal", "delegated_auction_portal",
      "public_asset_disposal", "municipal_alienation", "demanio",
    ] as AuctionSourceType[]),
    maxSources: req.maxSources ?? 20,
    maxPagesPerSource: req.maxPagesPerSource ?? 20,
    maxPdfPerSource: req.maxPdfPerSource ?? 5,
    maxDepth: req.maxDepth ?? 1,
    runFirecrawl: req.runFirecrawl !== false,
    runApify: req.runApify === true,
    fallbackToApifyOnFirecrawlError: req.fallbackToApifyOnFirecrawlError !== false,
    downloadPdf: req.downloadPdf === true && !dryRun,
  };

  const fcOk = firecrawlAvailable();
  const apifyOk = apifyAvailable();
  const report: DiscoverReport = {
    ok: true,
    dryRun,
    importPerformed: false,
    config: cfg,
    sources_total: AUCTION_SOURCE_REGISTRY.length,
    sources_checked: 0,
    sources_allowed: 0,
    sources_blocked: AUCTION_SOURCE_REGISTRY.filter((s) => s.compliance_status === "blocked").length,
    sources_manual_only: AUCTION_SOURCE_REGISTRY.filter((s) => s.compliance_status === "manual_only").length,
    sources_skipped_manual_only: 0,
    sources_used_firecrawl: 0,
    sources_used_apify: 0,
    apify_runs_started: 0,
    apify_runs_succeeded: 0,
    apify_runs_failed: 0,
    dataset_items_read: 0,
    pages_seen: 0,
    detail_pages_seen: 0,
    index_pages_seen: 0,
    pdf_links_found: 0,
    pdfs_downloaded: 0,
    candidates_found: 0,
    candidates_importable: 0,
    candidates_needs_review: 0,
    candidates_rejected: 0,
    rejected_reasons: {},
    location_inference_stats: { from_text: 0, from_title: 0, from_breadcrumb: 0, from_url: 0, from_source_scope: 0, failed: 0 },
    per_source: [],
    sample_candidates: [],
    sample_needs_review: [],
    sample_rejected: [],
    errors: [],
    warnings: [],
    compliance_summary: {
      firecrawl_available: fcOk,
      apify_available: apifyOk,
      captcha_bypass: false,
      login_bypass: false,
      aggressive_proxy: false,
      massive_blind_scrape: false,
      pdf_download_in_dry_run: false,
      manual_only_sources_excluded: true,
    },
    ready_for_controlled_import: false,
  };

  if (!fcOk && cfg.runFirecrawl) {
    report.warnings.push("FIRECRAWL_API_KEY missing: Firecrawl path skipped.");
  }
  if (!apifyOk && (cfg.runApify || cfg.fallbackToApifyOnFirecrawlError)) {
    report.warnings.push("APIFY_API_TOKEN missing: Apify path unavailable.");
  }

  // Skip count of manual_only fonti che sarebbero state in scope
  report.sources_skipped_manual_only = AUCTION_SOURCE_REGISTRY.filter((s) => s.compliance_status === "manual_only").length;

  const candidates = listEnabledSources({ province: cfg.province, sourceTypes: cfg.sourceTypes }).slice(0, cfg.maxSources);
  report.sources_allowed = candidates.length;

  const allCandidates: AuctionCandidate[] = [];
  const rejectReason = (k: string) => { report.rejected_reasons[k] = (report.rejected_reasons[k] ?? 0) + 1; };

  for (const src of candidates) {
    const perSrc = {
      source_key: src.source_key,
      source_name: src.source_name,
      province_scope: src.province_scope,
      method: "skipped" as "firecrawl" | "apify" | "skipped",
      apify_run_id: undefined as string | undefined,
      apify_dataset_id: undefined as string | undefined,
      pages_seen: 0,
      pdf_links: 0,
      candidates: 0,
      error: undefined as string | undefined,
    };
    report.sources_checked++;

    let pagesProcessed: Array<{ url: string; markdown: string; links: string[]; title?: string | null }> = [];
    let firecrawlHadCreditError = false;

    // ── Firecrawl path
    if (cfg.runFirecrawl && fcOk) {
      try {
        const urls: string[] = [];
        for (const path of src.allowed_paths.slice(0, 4)) {
          const seedUrl = src.base_url.replace(/\/$/, "") + path;
          try {
            const m = await fcMap(seedUrl, { search: "asta vendita", limit: Math.min(20, cfg.maxPagesPerSource), timeoutMs: 15_000 });
            if (m.ok) {
              for (const u of m.links) {
                if (urls.length >= cfg.maxPagesPerSource) break;
                if (src.excluded_paths.some((ex) => u.includes(ex))) continue;
                if (!urls.includes(u)) urls.push(u);
              }
            } else if (m.error?.includes("402")) {
              firecrawlHadCreditError = true;
            }
          } catch (_) { /* best-effort */ }
          if (urls.length >= cfg.maxPagesPerSource) break;
        }
        if (urls.length === 0) urls.push(src.base_url.replace(/\/$/, "") + (src.allowed_paths[0] ?? "/"));

        for (const u of urls.slice(0, cfg.maxPagesPerSource)) {
          await new Promise((r) => setTimeout(r, Math.min(src.rate_limit_ms, 2500)));
          const r = await fcScrape(u, { timeoutMs: 20_000, formats: ["markdown", "links"] });
          if (!r.ok) {
            if (r.error?.includes("402") || r.status === 402) firecrawlHadCreditError = true;
            if (r.error) report.warnings.push(`${src.source_key}: ${r.error}`.slice(0, 200));
            continue;
          }
          if (r.markdown) {
            pagesProcessed.push({ url: u, markdown: r.markdown, links: r.links ?? [], title: r.title ?? null });
          }
        }
        if (pagesProcessed.length > 0) {
          perSrc.method = "firecrawl";
          report.sources_used_firecrawl++;
        }
      } catch (e) {
        perSrc.error = (e as Error).message;
        report.errors.push(`${src.source_key} firecrawl: ${perSrc.error}`.slice(0, 240));
      }
    }

    // ── Apify path: diretto (runApify=true) o fallback su 402
    const shouldUseApify =
      apifyOk &&
      isApifyEligible(src) &&
      (
        (cfg.runApify && pagesProcessed.length === 0) ||
        (cfg.fallbackToApifyOnFirecrawlError && firecrawlHadCreditError && pagesProcessed.length === 0)
      );

    if (shouldUseApify) {
      report.apify_runs_started++;
      const runRes = await runApifyAuctionSource(src, {
        maxPagesPerSource: cfg.maxPagesPerSource,
        maxDepth: cfg.maxDepth,
        timeoutMs: 180_000,
      });
      perSrc.apify_run_id = runRes.actor_run_id;
      perSrc.apify_dataset_id = runRes.dataset_id;
      if (!runRes.ok) {
        report.apify_runs_failed++;
        perSrc.error = runRes.error;
        report.warnings.push(`${src.source_key} apify: ${runRes.error ?? "failed"}`.slice(0, 240));
      } else {
        report.apify_runs_succeeded++;
        report.dataset_items_read += runRes.pages.length;
        for (const p of runRes.pages) {
          const md = p.markdown ?? p.text ?? "";
          if (md) pagesProcessed.push({ url: p.url, markdown: md, links: p.links ?? [] });
        }
        perSrc.method = "apify";
        report.sources_used_apify++;
      }
    } else if (!shouldUseApify && pagesProcessed.length === 0 && !perSrc.error) {
      perSrc.error = perSrc.error ?? (firecrawlHadCreditError ? "firecrawl_402_no_apify_fallback" : "no_method_available");
    }

    // ── Estrazione candidati comune ai due path
    for (const page of pagesProcessed) {
      perSrc.pages_seen++;
      report.pages_seen++;
      const pdfLinks = (page.links ?? []).filter((l) => PDF_LINK_RE.test(l)).slice(0, cfg.maxPdfPerSource);
      perSrc.pdf_links += pdfLinks.length;
      report.pdf_links_found += pdfLinks.length;
      // Niente download PDF in dry run
      const cands = await extractAuctionCandidatesFromMarkdown(page.markdown, src, page.url, pdfLinks[0] ?? null);
      for (const c of cands) {
        if (c.privacy_redacted && (c.payload?.personal_hits as number) > 3) {
          rejectReason("personal_data_heavy");
          report.candidates_rejected++;
          if (report.sample_rejected.length < 10) {
            report.sample_rejected.push({ reason: "personal_data_heavy", source_url: page.url, excerpt: String((c.payload?.excerpt) ?? "").slice(0, 160) });
          }
          continue;
        }
        if (!c.province) {
          rejectReason("no_province");
          report.candidates_rejected++;
          continue;
        }
        allCandidates.push(c);
        perSrc.candidates++;
      }
    }

    report.per_source.push(perSrc);
  }

  report.candidates_found = allCandidates.length;
  for (const c of allCandidates) {
    if (c.confidence_score >= 0.70) report.candidates_importable++;
    else if (c.confidence_score >= 0.50) report.candidates_needs_review++;
    else {
      report.candidates_rejected++;
      rejectReason("low_confidence");
    }
  }
  report.sample_candidates = allCandidates.filter((c) => c.confidence_score >= 0.70).slice(0, 10);
  report.sample_needs_review = allCandidates.filter((c) => c.confidence_score >= 0.50 && c.confidence_score < 0.70).slice(0, 10);

  report.importPerformed = false;
  if (!dryRun) {
    report.warnings.push("dryRun=false richiesto, ma import disabilitato in questo modulo: usare endpoint dedicato (non ancora attivo).");
  }

  report.ready_for_controlled_import = report.candidates_importable >= 5 && report.errors.length === 0;
  return report;
}
