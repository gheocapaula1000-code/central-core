// ═══════════════════════════════════════════════════════════════
// auctionDiscovery — dry run crawler per fonti aste/legali Veneto.
// Compliance-safe. Niente bypass. Niente import in dryRun.
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
  type AuctionCandidate,
} from "./auctionParser.ts";

export interface DiscoverRequest {
  dryRun?: boolean;
  import?: boolean;
  province?: ProvCode[];
  sourceTypes?: AuctionSourceType[];
  maxSources?: number;
  maxPagesPerSource?: number;
  maxPdfPerSource?: number;
  runFirecrawl?: boolean;
  runApify?: boolean;
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
  pages_seen: number;
  pdf_links_found: number;
  pdfs_downloaded: number;
  candidates_found: number;
  candidates_importable: number;
  candidates_needs_review: number;
  candidates_rejected: number;
  rejected_reasons: Record<string, number>;
  per_source: Array<{
    source_key: string;
    source_name: string;
    province_scope: ProvCode[] | "ALL_VENETO";
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
    captcha_bypass: false;
    login_bypass: false;
    aggressive_proxy: false;
    massive_blind_scrape: false;
    pdf_download_in_dry_run: false;
  };
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
    runFirecrawl: req.runFirecrawl !== false,
    runApify: req.runApify === true,
    downloadPdf: req.downloadPdf === true && !dryRun,
  };

  const fcOk = firecrawlAvailable();
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
    pages_seen: 0,
    pdf_links_found: 0,
    pdfs_downloaded: 0,
    candidates_found: 0,
    candidates_importable: 0,
    candidates_needs_review: 0,
    candidates_rejected: 0,
    rejected_reasons: {},
    per_source: [],
    sample_candidates: [],
    sample_needs_review: [],
    sample_rejected: [],
    errors: [],
    warnings: [],
    compliance_summary: {
      firecrawl_available: fcOk,
      captcha_bypass: false,
      login_bypass: false,
      aggressive_proxy: false,
      massive_blind_scrape: false,
      pdf_download_in_dry_run: false,
    },
  };

  if (!fcOk && cfg.runFirecrawl) {
    report.warnings.push("FIRECRAWL_API_KEY missing: discovery limited to registry metadata only.");
  }

  const candidates = listEnabledSources({ province: cfg.province, sourceTypes: cfg.sourceTypes }).slice(0, cfg.maxSources);
  report.sources_allowed = candidates.length;

  const allCandidates: AuctionCandidate[] = [];
  const rejectReason = (k: string) => { report.rejected_reasons[k] = (report.rejected_reasons[k] ?? 0) + 1; };

  for (const src of candidates) {
    const perSrc = {
      source_key: src.source_key,
      source_name: src.source_name,
      province_scope: src.province_scope,
      pages_seen: 0,
      pdf_links: 0,
      candidates: 0,
      error: undefined as string | undefined,
    };
    report.sources_checked++;

    if (!fcOk || !cfg.runFirecrawl) {
      perSrc.error = "firecrawl unavailable or disabled";
      report.per_source.push(perSrc);
      continue;
    }

    try {
      // Discovery URLs via map (limit small per compliance)
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
          }
        } catch (_) { /* best-effort */ }
        if (urls.length >= cfg.maxPagesPerSource) break;
      }

      // Fallback: includi sempre seed url stesso se nessun link
      if (urls.length === 0) urls.push(src.base_url.replace(/\/$/, "") + (src.allowed_paths[0] ?? "/"));

      // Scrape conservativo
      for (const u of urls.slice(0, cfg.maxPagesPerSource)) {
        // Rate limit soft
        await new Promise((r) => setTimeout(r, Math.min(src.rate_limit_ms, 2500)));
        const r = await fcScrape(u, { timeoutMs: 20_000, formats: ["markdown", "links"] });
        perSrc.pages_seen++;
        report.pages_seen++;
        if (!r.ok || !r.markdown) {
          if (r.error) report.warnings.push(`${src.source_key}: ${r.error}`.slice(0, 200));
          continue;
        }
        // PDF link discovery
        const pdfLinks = (r.links ?? []).filter((l) => PDF_LINK_RE.test(l)).slice(0, cfg.maxPdfPerSource);
        perSrc.pdf_links += pdfLinks.length;
        report.pdf_links_found += pdfLinks.length;
        // dryRun: NON scarica PDF
        const cands = await extractAuctionCandidatesFromMarkdown(r.markdown, src, u, pdfLinks[0] ?? null);
        for (const c of cands) {
          if (c.privacy_redacted && (c.payload?.personal_hits as number) > 3) {
            rejectReason("personal_data_heavy");
            report.candidates_rejected++;
            if (report.sample_rejected.length < 10) {
              report.sample_rejected.push({ reason: "personal_data_heavy", source_url: u, excerpt: String((c.payload?.excerpt) ?? "").slice(0, 160) });
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
    } catch (e) {
      perSrc.error = e instanceof Error ? e.message : String(e);
      report.errors.push(`${src.source_key}: ${perSrc.error}`.slice(0, 240));
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
  report.sample_candidates = allCandidates
    .filter((c) => c.confidence_score >= 0.70)
    .slice(0, 10);
  report.sample_needs_review = allCandidates
    .filter((c) => c.confidence_score >= 0.50 && c.confidence_score < 0.70)
    .slice(0, 10);

  // dryRun: nessun import
  report.importPerformed = false;
  if (!dryRun) {
    report.warnings.push("dryRun=false richiesto, ma import disabilitato in questo modulo: usare /jobs/import-veneto-auction-signals (separato).");
  }

  return report;
}
