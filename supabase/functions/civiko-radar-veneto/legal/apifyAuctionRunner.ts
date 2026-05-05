// ═══════════════════════════════════════════════════════════════
// apifyAuctionRunner — fallback Apify per fonti aste/legali Veneto.
// Compliance-safe. Niente bypass. Niente PDF download. Niente login.
// Niente token in log o in output.
// ═══════════════════════════════════════════════════════════════
import {
  isApifyConfigured,
  startActorRun,
  getRunStatus,
  getDatasetItems,
} from "../apify/apifyClient.ts";
import type { AuctionSource } from "./auctionSourceRegistry.ts";

export interface ApifyAuctionPage {
  url: string;
  title?: string | null;
  markdown?: string | null;
  text?: string | null;
  html?: string | null;
  links?: string[];
}

export interface ApifyAuctionRunResult {
  ok: boolean;
  source_key: string;
  actor_run_id?: string;
  dataset_id?: string;
  status?: string;
  pages: ApifyAuctionPage[];
  error?: string;
}

const ACTOR_ID = "apify~website-content-crawler";

// Globs portale-aste mirate a pagine dettaglio/lotto/scheda
const DETAIL_INCLUDE_GLOBS = [
  "**/scheda**", "**/dettaglio**", "**/lotto**", "**/lotti**",
  "**/vendita**", "**/vendite**", "**/asta**", "**/aste**",
  "**/annuncio**", "**/annunci**", "**/immobili**", "**/immobile**",
  "**/bene**", "**/beni**", "**/procedure**", "**/procedura**",
  "**/avviso**", "**/avvisi**", "**/alienazion**", "**/bandi**",
];
// Tribunali/PA: globs più larghe ma sempre tematiche
const PA_INCLUDE_GLOBS = [
  "**/vendite**", "**/aste**", "**/avvisi**", "**/alienazion**",
  "**/patrimonio**", "**/bandi**", "**/news**", "**/documenti**",
];
const EXCLUDE_GLOBS = [
  "**/login**", "**/user**", "**/account**", "**/registrazione**",
  "**/captcha**", "**/privacy**", "**/cookie**", "**/contatti**", "**/contact**",
  "**/search**", "**/cerca**", "**/admin**", "**/newsletter**",
  "**/sort=**", "**/order=**", "**/page=*", "**/p=*",
  "**/?page=*", "**/?p=*", "**/?sort=*", "**/?filter=*",
];

export function apifyAvailable(): boolean {
  return isApifyConfigured();
}

export function isApifyEligible(source: AuctionSource): boolean {
  if (source.compliance_status === "manual_only" || source.compliance_status === "blocked") return false;
  if (source.crawl_method === "manual_only") return false;
  // Eligibilità conservativa: portali con form/CAPTCHA noti restano fuori.
  if (/pvp\.giustizia\.it/i.test(source.base_url)) return false;
  return true;
}

export async function runApifyAuctionSource(
  source: AuctionSource,
  options: {
    maxPagesPerSource?: number;
    maxDepth?: number;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<ApifyAuctionRunResult> {
  if (!apifyAvailable()) {
    return { ok: false, source_key: source.source_key, pages: [], error: "APIFY_NOT_CONFIGURED" };
  }
  if (!isApifyEligible(source)) {
    return { ok: false, source_key: source.source_key, pages: [], error: "INELIGIBLE_SOURCE" };
  }

  const maxPages = Math.min(options.maxPagesPerSource ?? 10, 40);
  const maxDepth = Math.min(options.maxDepth ?? 1, 2);
  const timeout = Math.min(options.timeoutMs ?? 180_000, 240_000);
  const pollMs = options.pollMs ?? 4_000;

  const startUrls = (source.allowed_paths.length ? source.allowed_paths : ["/"])
    .slice(0, 4)
    .map((p) => ({ url: source.base_url.replace(/\/$/, "") + p }));

  const include = source.source_type === "delegated_auction_portal"
    ? DETAIL_INCLUDE_GLOBS
    : PA_INCLUDE_GLOBS;

  const input = {
    startUrls,
    maxCrawlDepth: maxDepth,
    maxCrawlPages: maxPages,
    crawlerType: "cheerio",
    respectRobotsTxtFile: true,
    includeUrlGlobs: include,
    excludeUrlGlobs: EXCLUDE_GLOBS,
    saveMarkdown: true,
    saveHtml: false,
    saveScreenshots: false,
    proxyConfiguration: { useApifyProxy: true },
  };

  let run;
  try {
    run = await startActorRun(ACTOR_ID, input, 30_000);
  } catch (e) {
    return { ok: false, source_key: source.source_key, pages: [], error: `start_failed:${(e as Error).message}`.slice(0, 160) };
  }

  const runId = run.id;
  let datasetId = run.defaultDatasetId;
  let status = run.status;
  const deadline = Date.now() + timeout;

  while (status && !["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT", "TIMED_OUT"].includes(status)) {
    if (Date.now() > deadline) {
      return { ok: false, source_key: source.source_key, actor_run_id: runId, dataset_id: datasetId, status, pages: [], error: "poll_timeout" };
    }
    await new Promise((r) => setTimeout(r, pollMs));
    try {
      const s = await getRunStatus(runId);
      status = s.status;
      datasetId = s.defaultDatasetId ?? datasetId;
    } catch (_) { /* retry next loop */ }
  }

  if (status !== "SUCCEEDED" || !datasetId) {
    return { ok: false, source_key: source.source_key, actor_run_id: runId, dataset_id: datasetId, status, pages: [], error: `run_${status ?? "unknown"}` };
  }

  let items: unknown[] = [];
  try {
    items = await getDatasetItems(datasetId, Math.min(maxPages, 50));
  } catch (e) {
    return { ok: false, source_key: source.source_key, actor_run_id: runId, dataset_id: datasetId, status, pages: [], error: `dataset_${(e as Error).message}`.slice(0, 160) };
  }

  const pages: ApifyAuctionPage[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const url = (o.url ?? o.loadedUrl ?? o.pageUrl) as string | undefined;
    if (!url || typeof url !== "string") continue;
    const md = (o.markdown ?? o.text ?? null) as string | null;
    const text = (o.text ?? null) as string | null;
    const links = Array.isArray(o.links)
      ? (o.links as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 100)
      : [];
    pages.push({
      url,
      title: (o.title ?? ((o.metadata as Record<string, unknown> | undefined)?.title) ?? null) as string | null,
      markdown: md ? String(md).slice(0, 14_000) : null,
      text: text ? String(text).slice(0, 14_000) : null,
      html: null,
      links,
    });
  }

  return { ok: true, source_key: source.source_key, actor_run_id: runId, dataset_id: datasetId, status, pages };
}
