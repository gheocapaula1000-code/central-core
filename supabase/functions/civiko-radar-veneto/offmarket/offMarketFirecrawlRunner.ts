// ═══════════════════════════════════════════════════════════════
// Off-Market & Microzone Firecrawl Discovery Runner (DRY-RUN-FIRST)
// Strategia frugale:
//   1) fcMap su base_url con keywords → ottiene candidate URLs
//   2) Filtra per allowed_paths/excluded_paths
//   3) fcScrape SOLO sulle top N pagine per fonte (default 3)
//   4) Classifica + estrae candidate_signals (no import)
// Mai download PDF: solo raccolta link PDF dalle pagine.
// Compliance: niente login/CAPTCHA, niente PII, niente necrologi.
// ═══════════════════════════════════════════════════════════════

import { fcMap, fcScrape, firecrawlAvailable } from "../firecrawl/firecrawlClient.ts";
import {
  OFFMARKET_FIRECRAWL_REGISTRY,
  selectOffMarketSources,
  type OffMarketCategory,
  type OffMarketFirecrawlSource,
} from "./offMarketFirecrawlRegistry.ts";

// ── Tipi pubblici ───────────────────────────────────────────────
export type PageCategory =
  | "urban_planning" | "public_work" | "regeneration"
  | "public_asset" | "alienation" | "mobility"
  | "services" | "green_area" | "tourism"
  | "neighborhood_report" | "municipal_report"
  | "irrelevant" | "needs_review";

export type SignalType =
  | "urban_planning_signal" | "regeneration_signal"
  | "public_work_signal" | "public_asset_signal"
  | "alienation_signal" | "mobility_signal"
  | "green_signal" | "tourism_pressure_signal"
  | "neighborhood_sentiment_signal" | "offmarket_campaign_signal";

export type ImportRecommendation = "importable" | "needs_review" | "reject";

export interface ClassifiedPage {
  source_key: string;
  source_name: string;
  comune: string;
  provincia: string;
  source_url: string;
  title: string;
  category: PageCategory;
  published_at: string | null;
  importability: ImportRecommendation;
  confidence_score: number;
  keywords_matched: string[];
  source_excerpt: string;
  pdf_links: string[];
}

export interface CandidateSignal {
  comune: string;
  provincia: string;
  signal_type: SignalType;
  title: string;
  reason: string;
  possible_agent_action: string;
  source_url: string;
  source_name: string;
  confidence_score: number;
  quality: "alta" | "media" | "bassa";
  data_basis: string;
  import_recommendation: ImportRecommendation;
  reject_reason?: string;
}

export interface OffMarketDiscoveryReport {
  ok: boolean;
  dryRun: boolean;
  imported: false;
  firecrawl_available: boolean;
  firecrawl_credit_status: "ok" | "insufficient" | "rate_limited" | "unknown";
  sources_checked: number;
  sources_skipped: number;
  pages_seen: number;
  pages_classified: number;
  pdf_links_found: number;
  candidate_signals_found: number;
  importable_candidates: number;
  needs_review_candidates: number;
  rejected_candidates: number;
  candidates_by_category: Record<string, number>;
  candidates_by_comune: Record<string, number>;
  top_20_candidate_signals: CandidateSignal[];
  sample_importable: CandidateSignal[];
  sample_needs_review: CandidateSignal[];
  warnings: string[];
  errors: string[];
  estimated_value_for_radar: string;
  per_source_summary: Array<{
    source_key: string;
    comune: string;
    pages_seen: number;
    pages_classified: number;
    candidates: number;
    error?: string;
  }>;
}

// ── Privacy / PII guards (regex aggregate) ───────────────────────
const PII_PATTERNS = [
  /\bcodice\s*fiscale\b/i, /\bC\.?F\.?\s*[A-Z0-9]{16}\b/i,
  /\b\+?39?\s*0?\s*\d{2,4}[\s.-]?\d{6,8}\b/,        // tel
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/,                    // email
  /\bnecrologi?\b/i, /\bdefunto\b/i, /\beredi\b/i,
];

function containsPII(text: string): boolean {
  if (!text) return false;
  return PII_PATTERNS.some((re) => re.test(text));
}

function redactPreview(text: string, max = 280): string {
  let t = text.replace(/\s+/g, " ").trim();
  for (const re of PII_PATTERNS) t = t.replace(re, "[redatto]");
  if (t.length > max) t = t.slice(0, max) + "…";
  return t;
}

// ── Path guards ─────────────────────────────────────────────────
function urlAllowed(u: string, src: OffMarketFirecrawlSource): boolean {
  try {
    const url = new URL(u, src.base_url);
    const path = url.pathname.toLowerCase();
    const baseHost = new URL(src.base_url).hostname.toLowerCase();
    if (url.hostname.toLowerCase() !== baseHost) return false;
    if (src.excluded_paths.some((p) => path.includes(p.toLowerCase()))) return false;
    if (src.allowed_paths.length === 0) return true;
    return src.allowed_paths.some((p) => path.startsWith(p.toLowerCase()) || path.includes(p.toLowerCase()));
  } catch {
    return false;
  }
}

// ── Categoria → SignalType mapping ──────────────────────────────
const CATEGORY_SIGNAL: Record<PageCategory, SignalType | null> = {
  urban_planning: "urban_planning_signal",
  public_work: "public_work_signal",
  regeneration: "regeneration_signal",
  public_asset: "public_asset_signal",
  alienation: "alienation_signal",
  mobility: "mobility_signal",
  services: "neighborhood_sentiment_signal",
  green_area: "green_signal",
  tourism: "tourism_pressure_signal",
  neighborhood_report: "neighborhood_sentiment_signal",
  municipal_report: "offmarket_campaign_signal",
  irrelevant: null,
  needs_review: null,
};

// ── Keyword vocabolario per classificazione ─────────────────────
const KW: Record<PageCategory, string[]> = {
  urban_planning: ["piano interventi", " pi ", "p.i.", "pat ", "p.a.t.", "variante urbanistica", "comparto", "zonizzazione", "zona to", "PRG"],
  regeneration: ["rigenerazione urbana", "riqualificazione", "ex caserma", "ex area industriale", "comparto strategico"],
  public_work: ["lavori pubblici", "cantiere", "appalto lavori", "opera pubblica", "manutenzione straordinaria"],
  public_asset: ["patrimonio comunale", "patrimonio immobiliare", "immobile comunale", "concessione immobile"],
  alienation: ["alienazione", "vendita immobile", "asta pubblica", "bando vendita"],
  mobility: ["pums", "mobilità", "ztl", "isola pedonale", "tram", "metropolitana", "ciclabile"],
  services: ["servizi al cittadino", "scuola", "asilo", "presidio sanitario", "biblioteca"],
  green_area: ["verde pubblico", "parco urbano", "forestazione", "piantumazione", "area verde"],
  tourism: ["turismo", "flussi turistici", "contributo accesso", "stagione balneare", "turismo termale"],
  neighborhood_report: ["quartiere", "frazione", "circoscrizione", "consulta di quartiere"],
  municipal_report: ["bilancio sociale", "report comune", "rendiconto", "DUP "],
  irrelevant: [],
  needs_review: [],
};

function classifyPage(title: string, markdown: string): { category: PageCategory; matched: string[]; confidence: number } {
  const txt = (title + " " + markdown).toLowerCase();
  let best: PageCategory = "irrelevant";
  let bestHits: string[] = [];
  for (const [cat, words] of Object.entries(KW) as [PageCategory, string[]][]) {
    if (cat === "irrelevant" || cat === "needs_review") continue;
    const hits = words.filter((w) => txt.includes(w));
    if (hits.length > bestHits.length) { best = cat; bestHits = hits; }
  }
  if (bestHits.length === 0) {
    // possibilmente da rivedere (solo se contiene parole generiche)
    const generic = ["avviso", "delibera", "determina"];
    if (generic.some((g) => txt.includes(g))) return { category: "needs_review", matched: [], confidence: 0.25 };
    return { category: "irrelevant", matched: [], confidence: 0.05 };
  }
  const confidence = Math.min(0.95, 0.45 + bestHits.length * 0.12);
  return { category: best, matched: bestHits, confidence };
}

function extractPdfLinks(links: string[] | undefined, baseUrl: string): string[] {
  if (!links) return [];
  const out: string[] = [];
  for (const l of links) {
    if (typeof l !== "string") continue;
    if (!l.toLowerCase().endsWith(".pdf")) continue;
    try {
      const abs = new URL(l, baseUrl).toString();
      if (!out.includes(abs)) out.push(abs);
      if (out.length >= 10) break;
    } catch { /* ignore */ }
  }
  return out;
}

function extractPublishedAt(markdown: string): string | null {
  const m = markdown.match(/\b(0?[1-9]|[12]\d|3[01])[\/\-\.\s](0?[1-9]|1[0-2]|gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)[\/\-\.\s](20\d{2})\b/i);
  return m ? m[0] : null;
}

// ── Action templates per signal type ────────────────────────────
const ACTION_TEMPLATE: Record<SignalType, string> = {
  urban_planning_signal: "Visita i proprietari della zona prima dell'adozione del piano: chi ha terreno/immobile interessato sta valutando opzioni.",
  regeneration_signal: "Apri conversazioni nel comparto: la rigenerazione è leva di valorizzazione futura, ottima per acquisire incarichi.",
  public_work_signal: "Mappa gli edifici frontalieri al cantiere: turnover elevato post-cantiere, momento adatto per valutazioni gratuite.",
  public_asset_signal: "Monitora alienazioni: gli operatori che acquisteranno cercano agenzie locali per rivendita/locazione.",
  alienation_signal: "Avviso pubblico di vendita immobile comunale: prepara analisi comparativa per investitori della zona.",
  mobility_signal: "Cambio mobilità imminente: i proprietari della zona stanno rivalutando vendita/affitto, momento di contatto.",
  green_signal: "Nuovo verde pubblico: leva di valorizzazione, evidenziala nella valutazione agli proprietari della zona.",
  tourism_pressure_signal: "Pressione turistica in aumento: proprietari di seconde case stanno valutando uscita o conversione.",
  neighborhood_sentiment_signal: "Monitora il sentiment del quartiere per timing e narrazione delle valutazioni.",
  offmarket_campaign_signal: "Segnale aggregato per campagna off-market locale: pianifica casa-per-casa nella microzona.",
};

function buildCandidate(page: ClassifiedPage): CandidateSignal | null {
  const sig = CATEGORY_SIGNAL[page.category];
  if (!sig) return null;
  let imp: ImportRecommendation = "needs_review";
  let quality: CandidateSignal["quality"] = "media";
  let reject: string | undefined;
  if (page.confidence_score >= 0.75) { imp = "importable"; quality = "alta"; }
  else if (page.confidence_score < 0.4) { imp = "reject"; quality = "bassa"; reject = "Confidence troppo bassa"; }
  // Compliance check finale
  if (containsPII(page.source_excerpt)) {
    imp = "reject"; reject = "Possibile contenuto PII: escluso da import";
  }
  return {
    comune: page.comune,
    provincia: page.provincia,
    signal_type: sig,
    title: page.title.slice(0, 200),
    reason: `Pagina classificata "${page.category}" con keyword: ${page.keywords_matched.slice(0, 5).join(", ") || "—"}.`,
    possible_agent_action: ACTION_TEMPLATE[sig],
    source_url: page.source_url,
    source_name: page.source_name,
    confidence_score: page.confidence_score,
    quality,
    data_basis: `Fonte istituzionale ${page.source_name} — pagina pubblica`,
    import_recommendation: imp,
    reject_reason: reject,
  };
}

// ── Runner ──────────────────────────────────────────────────────
export interface DiscoveryRequest {
  dryRun?: boolean;
  import?: boolean;
  maxSources?: number;
  maxPagesPerSource?: number;   // pagine fcScrape per fonte (top per priorità keyword)
  maxDepth?: number;            // riservato (fcMap non lo richiede)
  categories?: OffMarketCategory[];
  comuni?: string[];
  province?: string[];
}

const DEFAULTS = {
  maxSources: 20,
  maxPagesPerSource: 3,         // limite frugale per dry run
  scrapeBudgetTotal: 30,        // hard cap globale di fcScrape
};

export async function runOffMarketFirecrawlDiscovery(
  body: DiscoveryRequest,
): Promise<OffMarketDiscoveryReport> {
  const dryRun = body?.dryRun !== false;            // default true
  const wantImport = body?.import === true && !dryRun;
  const warnings: string[] = [];
  const errors: string[] = [];

  if (wantImport) {
    warnings.push("Import richiesto ma in questa fase è disabilitato per design (solo dry run).");
  }

  if (!firecrawlAvailable()) {
    return emptyReport({
      ok: false, dryRun: true,
      firecrawl_available: false,
      credit: "unknown",
      warnings: ["FIRECRAWL_API_KEY non configurato"],
      errors: ["firecrawl_unavailable"],
    });
  }

  const sources = selectOffMarketSources({
    categories: body.categories,
    comuni: body.comuni,
    province: body.province,
    maxSources: body.maxSources ?? DEFAULTS.maxSources,
  });

  if (sources.length === 0) {
    return emptyReport({
      ok: true, dryRun: true,
      firecrawl_available: true,
      credit: "unknown",
      warnings: ["Nessuna fonte selezionata con i filtri richiesti"],
      errors: [],
    });
  }

  const maxPages = Math.max(1, Math.min(body.maxPagesPerSource ?? DEFAULTS.maxPagesPerSource, 8));
  let scrapeBudget = DEFAULTS.scrapeBudgetTotal;

  let pagesSeen = 0;
  let pagesClassified = 0;
  let pdfLinksFound = 0;
  let creditStatus: OffMarketDiscoveryReport["firecrawl_credit_status"] = "ok";
  const candidates: CandidateSignal[] = [];
  const perSource: OffMarketDiscoveryReport["per_source_summary"] = [];
  let sourcesSkipped = 0;

  for (const src of sources) {
    if (creditStatus === "insufficient") { sourcesSkipped++; continue; }
    const summary = { source_key: src.source_key, comune: src.comune, pages_seen: 0, pages_classified: 0, candidates: 0, error: undefined as string | undefined };

    // 1) fcMap discovery
    const search = src.keywords.slice(0, 3).join(" ");
    const map = await fcMap(src.base_url, { search, limit: src.max_pages, timeoutMs: 18_000 });
    if (!map.ok) {
      summary.error = `map: ${map.error ?? "unknown"}`;
      if (/402/.test(String(map.error))) creditStatus = "insufficient";
      if (/429/.test(String(map.error))) creditStatus = creditStatus === "insufficient" ? creditStatus : "rate_limited";
      perSource.push(summary);
      continue;
    }

    const candidatesUrl = map.links.filter((u) => urlAllowed(u, src)).slice(0, maxPages);
    summary.pages_seen = candidatesUrl.length;
    pagesSeen += candidatesUrl.length;

    // 2) fcScrape mirato (budget globale)
    for (const u of candidatesUrl) {
      if (scrapeBudget <= 0) { warnings.push(`Budget scrape esaurito su ${src.source_key}`); break; }
      if (creditStatus === "insufficient") break;
      scrapeBudget--;
      const sc = await fcScrape(u, { timeoutMs: 22_000, formats: ["markdown", "links"] });
      if (!sc.ok) {
        if (sc.status === 402 || /402/.test(String(sc.error))) { creditStatus = "insufficient"; break; }
        if (sc.status === 429 || /429/.test(String(sc.error))) { creditStatus = creditStatus === "insufficient" ? creditStatus : "rate_limited"; }
        continue;
      }
      const md = sc.markdown ?? "";
      const title = sc.title ?? u;
      // Skip se è palesemente una pagina di anagrafe / login / privacy
      if (containsPII(md) && /(necrolog|anagrafe|defunti)/i.test(md)) {
        warnings.push(`Pagina esclusa per PII: ${u}`);
        continue;
      }
      const cls = classifyPage(title, md);
      const pdfs = extractPdfLinks(sc.links, src.base_url);
      pdfLinksFound += pdfs.length;
      const page: ClassifiedPage = {
        source_key: src.source_key,
        source_name: src.source_name,
        comune: src.comune,
        provincia: src.provincia,
        source_url: u,
        title: title.slice(0, 200),
        category: cls.category,
        published_at: extractPublishedAt(md),
        importability: cls.confidence >= 0.75 ? "importable" : cls.confidence < 0.4 ? "reject" : "needs_review",
        confidence_score: Number(cls.confidence.toFixed(2)),
        keywords_matched: cls.matched,
        source_excerpt: redactPreview(md, 240),
        pdf_links: pdfs,
      };
      pagesClassified++;
      summary.pages_classified++;
      const cand = buildCandidate(page);
      if (cand) {
        candidates.push(cand);
        summary.candidates++;
      }
    }
    perSource.push(summary);
  }

  // ── Aggregazioni ────────────────────────────────────────────
  const byCategory: Record<string, number> = {};
  const byComune: Record<string, number> = {};
  for (const c of candidates) {
    byCategory[c.signal_type] = (byCategory[c.signal_type] ?? 0) + 1;
    byComune[c.comune] = (byComune[c.comune] ?? 0) + 1;
  }
  const importable = candidates.filter((c) => c.import_recommendation === "importable");
  const needsReview = candidates.filter((c) => c.import_recommendation === "needs_review");
  const rejected = candidates.filter((c) => c.import_recommendation === "reject");
  const top20 = [...candidates].sort((a, b) => b.confidence_score - a.confidence_score).slice(0, 20);

  const evalLine = importable.length >= 10
    ? `Buon valore: ${importable.length} segnali importabili in ${Object.keys(byComune).length} comuni.`
    : importable.length > 0
    ? `Valore moderato: ${importable.length} segnali importabili — affinare registry per coprire più comuni.`
    : `Valore basso in questa run — affinare keyword/allowed_paths o aggiungere fonti.`;

  return {
    ok: creditStatus !== "insufficient",
    dryRun: true,
    imported: false,
    firecrawl_available: true,
    firecrawl_credit_status: creditStatus,
    sources_checked: sources.length - sourcesSkipped,
    sources_skipped: sourcesSkipped,
    pages_seen: pagesSeen,
    pages_classified: pagesClassified,
    pdf_links_found: pdfLinksFound,
    candidate_signals_found: candidates.length,
    importable_candidates: importable.length,
    needs_review_candidates: needsReview.length,
    rejected_candidates: rejected.length,
    candidates_by_category: byCategory,
    candidates_by_comune: byComune,
    top_20_candidate_signals: top20,
    sample_importable: importable.slice(0, 5),
    sample_needs_review: needsReview.slice(0, 5),
    warnings,
    errors,
    estimated_value_for_radar: evalLine,
    per_source_summary: perSource,
  };
}

function emptyReport(o: { ok: boolean; dryRun: boolean; firecrawl_available: boolean; credit: OffMarketDiscoveryReport["firecrawl_credit_status"]; warnings: string[]; errors: string[] }): OffMarketDiscoveryReport {
  return {
    ok: o.ok, dryRun: true, imported: false,
    firecrawl_available: o.firecrawl_available,
    firecrawl_credit_status: o.credit,
    sources_checked: 0, sources_skipped: 0,
    pages_seen: 0, pages_classified: 0, pdf_links_found: 0,
    candidate_signals_found: 0, importable_candidates: 0, needs_review_candidates: 0, rejected_candidates: 0,
    candidates_by_category: {}, candidates_by_comune: {},
    top_20_candidate_signals: [], sample_importable: [], sample_needs_review: [],
    warnings: o.warnings, errors: o.errors,
    estimated_value_for_radar: "n/a",
    per_source_summary: [],
  };
}

export const _internals = { OFFMARKET_FIRECRAWL_REGISTRY };
