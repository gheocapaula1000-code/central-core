// ═══════════════════════════════════════════════════════════════
// crawlRunner + orchestratore Firecrawl Deep per il Veneto.
// Endpoint: POST /jobs/firecrawl-deep-veneto
// Compliance: niente bypass, niente demo/mock/seed.
// ═══════════════════════════════════════════════════════════════
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { fcScrape, fcMap, firecrawlAvailable } from "./firecrawlClient.ts";
import { filterSources, type FirecrawlSource } from "./sourceRegistry.ts";
import { classifyPage, type PageClass } from "./pageClassifier.ts";
import { extractEntities } from "./entityExtractor.ts";
import { scoreDocument } from "./documentScorer.ts";
import { sha1Hex, UrlDedupe } from "./dedupe.ts";
import { isForbiddenPage, isDemoText, isVenetoProvince } from "./complianceGuards.ts";
import { buildAuctionCandidate, type AuctionCandidate } from "./auctionExtractor.ts";
import { buildTerritorialCandidate, type TerritorialCandidate } from "./territorialSignalExtractor.ts";

export interface DeepCrawlRequest {
  dryRun?: boolean;
  mode?: "deep" | "targeted" | "auctions_only" | "territory_only" | "municipal_only";
  maxPagesPerSource?: number;
  maxDepth?: number;
  province?: string[];
  comuni?: string[];
  sourceTypes?: string[];
  import?: boolean;
}

export interface DeepCrawlReport {
  ok: boolean;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  firecrawl_available: boolean;
  sources_planned: number;
  sources_crawled: number;
  pages_seen: number;
  pages_classified: number;
  documents_saved: number;
  auction_candidates: number;
  auction_imported: number;
  territorial_candidates: number;
  territorial_imported: number;
  rejected: number;
  warnings: string[];
  errors: string[];
  top_sources: Array<{ source_name: string; pages: number; saved: number }>;
  next_actions: string[];
}

function svc(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function pickSourceTypes(mode: DeepCrawlRequest["mode"]): string[] | undefined {
  switch (mode) {
    case "auctions_only": return ["auctions","ivg"];
    case "territory_only": return ["urban_planning","public_works","open_data","infrastructure"];
    case "municipal_only": return ["municipal_notices"];
    default: return undefined;
  }
}

function fingerprintAuction(c: AuctionCandidate): Promise<string> {
  return sha1Hex(`${c.source_name}|${c.source_url}|${c.provincia}|${c.comune.toUpperCase()}|${c.data_vendita ?? ""}`).then((h) => "auction_" + h.slice(0, 24));
}
function fingerprintTerritorial(c: TerritorialCandidate): Promise<string> {
  return sha1Hex(`${c.source_name}|${c.source_url}|${c.signal_type}|${c.provincia}|${c.comune.toUpperCase()}`).then((h) => "terr_" + h.slice(0, 24));
}

export async function runFirecrawlDeepVeneto(req: DeepCrawlRequest): Promise<DeepCrawlReport> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const warnings: string[] = [];
  const errors: string[] = [];
  const dryRun = req.dryRun !== false;
  const doImport = req.import === true && !dryRun;
  const maxPages = Math.max(1, Math.min(100, req.maxPagesPerSource ?? 25));
  const maxDepth = Math.max(0, Math.min(2, req.maxDepth ?? 1));
  const requestedTypes = req.sourceTypes && req.sourceTypes.length ? req.sourceTypes : pickSourceTypes(req.mode);

  const fcOk = firecrawlAvailable();
  const sources = filterSources({ province: req.province, comuni: req.comuni, sourceTypes: requestedTypes });

  const report: DeepCrawlReport = {
    ok: true, started_at: startedAt, ended_at: startedAt, duration_ms: 0,
    firecrawl_available: fcOk,
    sources_planned: sources.length, sources_crawled: 0,
    pages_seen: 0, pages_classified: 0, documents_saved: 0,
    auction_candidates: 0, auction_imported: 0,
    territorial_candidates: 0, territorial_imported: 0,
    rejected: 0, warnings, errors,
    top_sources: [], next_actions: [],
  };

  if (!fcOk) {
    warnings.push("FIRECRAWL_API_KEY non configurata: impossibile crawl reale.");
    report.ok = false;
    report.ended_at = new Date().toISOString();
    report.duration_ms = Date.now() - t0;
    report.next_actions.push("Configurare FIRECRAWL_API_KEY o connettore Firecrawl.");
    return report;
  }
  if (sources.length === 0) {
    warnings.push("Nessuna fonte selezionata con i filtri forniti.");
    report.ended_at = new Date().toISOString();
    report.duration_ms = Date.now() - t0;
    return report;
  }

  const supa = svc();
  if (!supa) {
    errors.push("SUPABASE_SERVICE_ROLE_KEY mancante: nessuna scrittura possibile.");
    report.ok = false;
    report.ended_at = new Date().toISOString();
    report.duration_ms = Date.now() - t0;
    return report;
  }

  // Insert ingestion run
  const { data: runRow } = await supa.from("ingestion_runs").insert({
    job_name: "firecrawl-deep-veneto",
    source_name: "firecrawl",
    status: "running",
  }).select("id").single();
  const runId = (runRow as { id: number } | null)?.id ?? null;

  const auctionCandidates: AuctionCandidate[] = [];
  const territorialCandidates: TerritorialCandidate[] = [];
  const dedupe = new UrlDedupe();
  const perSource: Record<string, { pages: number; saved: number }> = {};

  for (const source of sources) {
    perSource[source.source_name] = { pages: 0, saved: 0 };
    let urlsToVisit: string[] = [source.base_url];

    // Map per espansione (depth 1)
    if (source.crawl_depth >= 1 && maxDepth >= 1) {
      const mapped = await fcMap(source.base_url, { limit: maxPages * 2 });
      if (mapped.ok) {
        const filtered = mapped.links.filter((u) => allowedByPaths(u, source));
        urlsToVisit = unique([source.base_url, ...filtered]).slice(0, maxPages);
      } else if (mapped.error) {
        warnings.push(`map ${source.source_name}: ${mapped.error}`);
      }
    }

    report.sources_crawled++;

    for (const url of urlsToVisit) {
      if (!dedupe.add(url)) continue;
      report.pages_seen++;

      // log fetch
      const fetchStart = Date.now();
      const res = await fcScrape(url, { timeoutMs: 25_000, formats: ["markdown","links"] });
      await supa.from("source_fetch_logs").insert({
        source_name: source.source_name,
        url,
        ok: res.ok,
        status_code: res.status ?? null,
        duration_ms: Date.now() - fetchStart,
        error: res.error ?? null,
      }).then(() => {/*silent*/});

      if (!res.ok) { warnings.push(`scrape ${url}: ${res.error}`); continue; }
      if (isForbiddenPage(res.markdown ?? null)) { report.rejected++; warnings.push(`skip forbidden page: ${url}`); continue; }
      if (isDemoText(url, res.title)) { report.rejected++; continue; }

      report.pages_classified++;
      const cls = classifyPage(url, res.markdown ?? null);
      const ents = extractEntities({
        url, title: res.title ?? null, markdown: res.markdown ?? null,
        links: res.links ?? [],
        hintComune: source.comuni?.[0],
        hintProv: source.province?.[0],
      });
      const score = scoreDocument({
        source, pageClass: cls, entities: ents,
        publishedAt: res.publishedAt ?? null, hasMarkdown: !!res.markdown,
      });
      const rawHash = res.markdown ? await sha1Hex(res.markdown) : await sha1Hex(url);

      // Save document (sempre, dryRun incluso, per audit)
      const { error: docErr } = await supa.from("source_documents").upsert({
        source_name: source.source_name,
        source_type: source.source_type,
        source_url: url,
        url,
        title: res.title ?? null,
        text_excerpt: (res.markdown ?? "").slice(0, 600),
        markdown: res.markdown ?? null,
        raw_hash: rawHash,
        content_hash: rawHash,
        fetched_at: new Date().toISOString(),
        published_at: res.publishedAt ?? null,
        comune: ents.comune,
        provincia: isVenetoProvince(ents.provincia ?? null) ? ents.provincia : null,
        classification: cls,
        extracted_entities: ents,
        relevance_score: score.relevance_score,
        confidence_score: score.confidence_score,
        freshness_score: score.freshness_score,
        importability: score.importability,
        import_reason: score.reason,
        quality: score.importability ? "reale" : "parziale",
        data_basis: `firecrawl,${source.source_name}`,
        doc_type: cls,
        metadata: { source_priority: source.priority, source_reliability: score.source_reliability },
      }, { onConflict: "source_url" });

      if (docErr) { warnings.push(`upsert doc ${url}: ${docErr.message}`); continue; }
      report.documents_saved++;
      perSource[source.source_name].saved++;
      perSource[source.source_name].pages++;

      // Build candidates per import
      if (cls === "auction" || cls === "pvp" || cls === "ivg") {
        const cand = buildAuctionCandidate({
          sourceName: source.source_name, sourceUrl: url, title: res.title ?? null,
          entities: ents, confidence: score.confidence_score,
        });
        if (cand && cand.confidence_score >= 50) auctionCandidates.push(cand);
        else if (!cand) report.rejected++;
      } else if (score.importability) {
        const tcand = buildTerritorialCandidate({
          sourceName: source.source_name, sourceUrl: url, title: res.title ?? null,
          pageClass: cls, entities: ents, publishedAt: res.publishedAt ?? null,
          relevance: score.relevance_score, confidence: score.confidence_score,
        });
        if (tcand) territorialCandidates.push(tcand);
      }
    }

    // Touch source registry
    await supa.from("data_sources").update({
      last_run_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("source_name", source.source_name);
  }

  report.auction_candidates = auctionCandidates.length;
  report.territorial_candidates = territorialCandidates.length;

  // Import (solo se import=true e non dryRun) — solo confidence>=70 per aste, >=60 per territorial
  if (doImport) {
    // Aste
    const acceptable = auctionCandidates.filter((c) => c.confidence_score >= 70);
    if (acceptable.length > 0) {
      const fps = await Promise.all(acceptable.map(fingerprintAuction));
      const { data: existing } = await supa.from("auction_signals").select("fingerprint").in("fingerprint", fps);
      const existingSet = new Set((existing ?? []).map((x) => (x as { fingerprint: string }).fingerprint));
      const rows = acceptable.map((c, i) => ({
        fingerprint: fps[i],
        source_name: c.source_name,
        source_url: c.source_url,
        province: c.provincia,
        municipality: c.comune,
        cap: null,
        lat: c.lat, lng: c.lng,
        property_type: c.tipologia,
        base_price_eur: c.prezzo_base,
        minimum_offer_eur: c.offerta_minima,
        sale_date: c.data_vendita,
        status: c.stato,
        quality: c.quality,
        data_basis: c.data_basis.join(","),
        payload: { tribunale: c.tribunale, descrizione: c.descrizione, source_basis: c.data_basis },
      })).filter((r) => !existingSet.has(r.fingerprint));
      if (rows.length > 0) {
        const { error, count } = await supa.from("auction_signals").insert(rows, { count: "exact" });
        if (error) errors.push(`auction insert: ${error.message}`);
        else report.auction_imported = count ?? rows.length;
      }
    }

    // Territorial
    const accT = territorialCandidates.filter((c) => c.confidence_score >= 60 && c.relevance_score >= 60);
    if (accT.length > 0) {
      const fps = await Promise.all(accT.map(fingerprintTerritorial));
      const { data: existing } = await supa.from("territorial_signals").select("fingerprint").in("fingerprint", fps);
      const existingSet = new Set((existing ?? []).map((x) => (x as { fingerprint: string }).fingerprint));
      const rows = accT.map((c, i) => ({
        fingerprint: fps[i],
        signal_type: c.signal_type,
        source_name: c.source_name,
        title: c.title,
        description: c.description,
        municipality: c.comune,
        province: c.provincia,
        lat: null, lng: null,
        is_active: true,
        quality: c.quality,
        data_basis: c.data_basis.join(","),
        payload: {
          source_url: c.source_url,
          published_at: c.published_at,
          amount_eur: c.amount_eur,
          location_text: c.location_text,
          confidence_score: c.confidence_score,
          relevance_score: c.relevance_score,
        },
      })).filter((r) => !existingSet.has(r.fingerprint));
      if (rows.length > 0) {
        const { error, count } = await supa.from("territorial_signals").insert(rows, { count: "exact" });
        if (error) errors.push(`territorial insert: ${error.message}`);
        else report.territorial_imported = count ?? rows.length;
      }
    }
  } else if (auctionCandidates.length || territorialCandidates.length) {
    warnings.push("dryRun/import=false: candidati non scritti in tabelle operative.");
  }

  report.top_sources = Object.entries(perSource)
    .map(([k, v]) => ({ source_name: k, pages: v.pages, saved: v.saved }))
    .sort((a, b) => b.saved - a.saved).slice(0, 10);

  if (report.documents_saved === 0) {
    report.next_actions.push("Nessun documento salvato: verificare connettività Firecrawl o ampliare maxPages/sources.");
  }
  if (report.auction_candidates === 0) {
    report.next_actions.push("Nessuna asta estratta: integrare adapter IVG/PVP regionale o dataset bulk autorizzato.");
  }
  if (!doImport && (report.auction_candidates || report.territorial_candidates)) {
    report.next_actions.push("Rilanciare con import=true e dryRun=false per persistere i candidati validi.");
  }

  report.ended_at = new Date().toISOString();
  report.duration_ms = Date.now() - t0;

  if (runId !== null) {
    await supa.from("ingestion_runs").update({
      status: "completed",
      completed_at: report.ended_at,
      duration_ms: report.duration_ms,
      rows_in: report.pages_seen,
      rows_out: report.documents_saved,
      warnings,
      errors,
      report,
    }).eq("id", runId);
  }

  return report;
}

function allowedByPaths(url: string, s: FirecrawlSource): boolean {
  const u = url.toLowerCase();
  if (s.excluded_paths && s.excluded_paths.some((p) => u.includes(p.toLowerCase()))) return false;
  if (s.allowed_paths && s.allowed_paths.length) {
    return s.allowed_paths.some((p) => u.includes(p.toLowerCase()));
  }
  return true;
}

function unique<T>(arr: T[]): T[] { return Array.from(new Set(arr)); }
