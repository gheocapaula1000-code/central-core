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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { fcMap, fcScrape, firecrawlAvailable } from "../firecrawl/firecrawlClient.ts";
import {
  OFFMARKET_FIRECRAWL_REGISTRY,
  selectOffMarketSources,
  type OffMarketCategory,
  type OffMarketFirecrawlSource,
} from "./offMarketFirecrawlRegistry.ts";

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !svc) return null;
  return createClient(url, svc, { auth: { persistSession: false } });
}

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
  imported: boolean;
  saved_candidates?: number;
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
  per_source_summary: Array<SourceDebug>;
  deferred_source_keys: string[];
  elapsed_ms: number;
  time_budget_ms: number;
  scrape_budget_remaining: number;
}

export interface SourceDebug {
  source_key: string;
  source_name: string;
  base_url: string;
  comune: string;
  provincia: string;
  category: string;
  enabled: boolean;
  compliance_status: "ok" | "skipped";
  map_status: "ok" | "error" | "empty" | "skipped";
  map_error?: string;
  map_urls_found: number;
  map_sample_urls: string[];
  fallback_used: boolean;
  scrape_attempted: boolean;
  scrape_urls_selected: string[];
  scrape_results: Array<{
    url: string;
    status?: number;
    ok: boolean;
    error?: string;
    title?: string | null;
    markdown_length: number;
    classification?: string;
    confidence?: number;
    keywords_matched?: string[];
    candidate_built: boolean;
    reject_reason?: string;
  }>;
  candidates: number;
  warning?: string;
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
// Hostname e excluded_paths sono HARD filter (sicurezza/compliance).
// allowed_paths è SOFT hint: usato per ranking, non per filtro.
function urlSafe(u: string, src: OffMarketFirecrawlSource): boolean {
  try {
    const url = new URL(u, src.base_url);
    const baseHost = new URL(src.base_url).hostname.toLowerCase();
    if (url.hostname.toLowerCase() !== baseHost) return false;
    const path = url.pathname.toLowerCase();
    if (src.excluded_paths.some((p) => path.includes(p.toLowerCase()))) return false;
    return true;
  } catch {
    return false;
  }
}

function urlPriority(u: string, src: OffMarketFirecrawlSource): number {
  try {
    const path = new URL(u, src.base_url).pathname.toLowerCase();
    let score = 0;
    for (const p of src.allowed_paths) {
      if (path.includes(p.toLowerCase())) score += 2;
    }
    for (const k of src.keywords) {
      if (path.includes(k.toLowerCase().replace(/\s+/g, "-"))) score += 1;
    }
    return score;
  } catch {
    return 0;
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
  sourceKeys?: string[];
  timeBudgetMs?: number;
  scrapeBudgetRemaining?: number;
}

const DEFAULTS = {
  maxSources: 20,
  maxPagesPerSource: 3,         // limite frugale per dry run
  scrapeBudgetTotal: 30,        // hard cap globale di fcScrape
};

export async function runOffMarketFirecrawlDiscovery(
  body: DiscoveryRequest,
): Promise<OffMarketDiscoveryReport> {
  const dryRun = body?.dryRun === true;             // default false (live run)
  const wantImport = body?.import === true && !dryRun;
  const warnings: string[] = [];
  const errors: string[] = [];
  const startedAt = Date.now();
  const timeBudget = Math.max(15_000, Math.min(body.timeBudgetMs ?? 90_000, 120_000));

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

  let sources = selectOffMarketSources({
    categories: body.categories,
    comuni: body.comuni,
    province: body.province,
    maxSources: body.maxSources ?? DEFAULTS.maxSources,
  });

  if (body.sourceKeys && body.sourceKeys.length > 0) {
    const keep = new Set(body.sourceKeys);
    sources = sources.filter((s) => keep.has(s.source_key));
  }

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
  let scrapeBudget = body.scrapeBudgetRemaining ?? DEFAULTS.scrapeBudgetTotal;

  let pagesSeen = 0;
  let pagesClassified = 0;
  let pdfLinksFound = 0;
  let creditStatus: OffMarketDiscoveryReport["firecrawl_credit_status"] = "ok";
  const candidates: CandidateSignal[] = [];
  const perSource: OffMarketDiscoveryReport["per_source_summary"] = [];
  let sourcesSkipped = 0;
  const deferredSourceKeys: string[] = [];

  for (const src of sources) {
    const dbg: SourceDebug = {
      source_key: src.source_key,
      source_name: src.source_name,
      base_url: src.base_url,
      comune: src.comune,
      provincia: src.provincia,
      category: src.category,
      enabled: src.enabled,
      compliance_status: "ok",
      map_status: "skipped",
      map_urls_found: 0,
      map_sample_urls: [],
      fallback_used: false,
      scrape_attempted: false,
      scrape_urls_selected: [],
      scrape_results: [],
      candidates: 0,
    };

    if (creditStatus === "insufficient") {
      dbg.warning = "Skipped: credito Firecrawl insufficiente";
      sourcesSkipped++;
      perSource.push(dbg);
      continue;
    }

    // 1) fcMap discovery
    const search = src.keywords.slice(0, 3).join(" ");
    const map = await fcMap(src.base_url, { search, limit: src.max_pages, timeoutMs: 18_000 });
    let candidatesUrl: string[] = [];
    if (!map.ok) {
      dbg.map_status = "error";
      dbg.map_error = map.error ?? "unknown";
      if (/402/.test(String(map.error))) creditStatus = "insufficient";
      if (/429/.test(String(map.error))) creditStatus = creditStatus === "insufficient" ? creditStatus : "rate_limited";
    } else {
      const safe = map.links.filter((u) => urlSafe(u, src));
      dbg.map_urls_found = safe.length;
      dbg.map_sample_urls = safe.slice(0, 5);
      dbg.map_status = safe.length > 0 ? "ok" : "empty";
      // ranking: priorità a path coerenti con allowed_paths/keywords
      candidatesUrl = [...safe]
        .sort((a, b) => urlPriority(b, src) - urlPriority(a, src))
        .slice(0, maxPages);
    }

    // 2) Fallback: se map vuoto/errore → scrape diretto base_url
    if (candidatesUrl.length === 0 && creditStatus !== "insufficient") {
      dbg.fallback_used = true;
      candidatesUrl = [src.base_url];
      dbg.warning = (dbg.warning ?? "") + (dbg.warning ? " | " : "") + "Fallback: nessuna URL da map, uso base_url";
    }

    dbg.scrape_urls_selected = candidatesUrl.slice(0, 5);
    dbg.scrape_attempted = candidatesUrl.length > 0;

    // 3) fcScrape mirato
    for (const u of candidatesUrl) {
      if (scrapeBudget <= 0) {
        warnings.push(`Budget scrape esaurito su ${src.source_key}`);
        break;
      }
      if (creditStatus === "insufficient") break;
      scrapeBudget--;
      const sc = await fcScrape(u, { timeoutMs: 22_000, formats: ["markdown", "links"] });
      const r: SourceDebug["scrape_results"][number] = {
        url: u,
        ok: sc.ok,
        status: sc.status,
        error: sc.error,
        title: sc.title,
        markdown_length: sc.markdown?.length ?? 0,
        candidate_built: false,
      };

      if (!sc.ok) {
        if (sc.status === 402 || /402/.test(String(sc.error))) creditStatus = "insufficient";
        if (sc.status === 429 || /429/.test(String(sc.error))) creditStatus = creditStatus === "insufficient" ? creditStatus : "rate_limited";
        dbg.scrape_results.push(r);
        continue;
      }

      const md = sc.markdown ?? "";
      const title = sc.title ?? u;
      pagesSeen++;

      if (containsPII(md) && /(necrolog|anagrafe|defunti)/i.test(md)) {
        r.reject_reason = "PII (necrologi/anagrafe)";
        warnings.push(`Pagina esclusa per PII: ${u}`);
        dbg.scrape_results.push(r);
        continue;
      }

      const cls = classifyPage(title, md);
      r.classification = cls.category;
      r.confidence = Number(cls.confidence.toFixed(2));
      r.keywords_matched = cls.matched;

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
      const cand = buildCandidate(page);
      if (cand) {
        candidates.push(cand);
        dbg.candidates++;
        r.candidate_built = true;
        r.reject_reason = cand.reject_reason;
      } else {
        r.reject_reason = `categoria ${cls.category} non mappata a signal`;
      }
      dbg.scrape_results.push(r);
    }
    perSource.push(dbg);
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

  const result: OffMarketDiscoveryReport = {
    ok: creditStatus !== "insufficient",
    dryRun,
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

  const allCandidates = candidates;
  if (!dryRun && allCandidates.filter(c => c.import_recommendation === "importable" || c.import_recommendation === "needs_review").length > 0) {
    const supa = getServiceClient();
    if (supa) {
      const toSave = allCandidates
        .filter(c => c.import_recommendation === "importable" || c.import_recommendation === "needs_review")
        .map(c => ({
          comune: c.comune,
          provincia: c.provincia,
          signal_type: c.signal_type,
          title: c.title,
          summary: c.reason ?? "",
          why_it_matters: c.reason ?? "",
          possible_agent_action: c.possible_agent_action ?? "",
          source_url: c.source_url,
          source_name: c.source_name,
          confidence_score: c.confidence_score,
          quality: c.quality,
          data_basis: c.data_basis,
          privacy_safe: true,
          needs_review: c.import_recommendation === "needs_review",
          import_recommendation: c.import_recommendation,
          fingerprint: `${c.signal_type}::${c.source_url?.toLowerCase()}`,
          status: c.import_recommendation === "importable" ? "discovered" : "needs_review",
        }));
      const { error } = await supa
        .from("early_offmarket_signal_candidates")
        .upsert(toSave, { onConflict: "fingerprint", ignoreDuplicates: true });
      if (!error) {
        result.saved_candidates = toSave.length;
        result.imported = true;
      } else {
        warnings.push(`save failed: ${error.message}`);
      }
    } else {
      warnings.push("save skipped: SUPABASE_SERVICE_ROLE_KEY missing");
    }
  }

  return result;
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
