// ═══════════════════════════════════════════════════════════════
// Firecrawl enrichment per civiko-property-from-photo
//
// Recupera segnali vivi (aste, alienazioni, bandi, lavori pubblici,
// delibere, rigenerazione) tramite fcMap + fcScrape sulle fonti
// pubbliche già censite in civiko-radar-veneto/firecrawl/sourceRegistry.
// Non modifica nessun file in quel modulo.
//
// HARD RULES:
//   - Timeout totale 40s. Restituisce parziale se scade.
//   - PII guard: rimuove CF, email, telefoni dall'estratto.
//   - Mai lancia eccezioni.
// ═══════════════════════════════════════════════════════════════

import {
  VENETO_SOURCES,
  filterSources,
  type FirecrawlSource,
} from "../civiko-radar-veneto/firecrawl/sourceRegistry.ts";
import { fcMap, fcScrape } from "../civiko-radar-veneto/firecrawl/firecrawlClient.ts";
import { classifyPage, type PageClass } from "../civiko-radar-veneto/firecrawl/pageClassifier.ts";

export interface LiveSignal {
  tipo: "asta" | "alienazione" | "bando" | "lavori_pubblici" | "delibera" | "rigenerazione";
  titolo: string;
  estratto: string;
  url: string;
  fonte: string;
  dataRilevazione: string;
}

const TOTAL_TIMEOUT_MS = 40_000;
const MAP_TIMEOUT_MS = 12_000;
const SCRAPE_TIMEOUT_MS = 18_000;
const MAX_SOURCES = 3;
const MAX_URLS_PER_SOURCE = 15;
const MAX_SCRAPES = 5;
const MAX_RESULTS = 10;

const SEARCH_KEYWORDS = [
  "asta", "aste", "vendita giudiziaria", "alienazione",
  "urbanistica", "bando", "variante", "lavori pubblici", "delibera",
];

const KEYWORD_REGEX = new RegExp(
  SEARCH_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "i",
);

// Tipi di sorgente prioritari (in ordine).
const PRIORITY_TYPES: string[] = ["ivg", "pvp", "auctions", "municipal_notices", "public_works", "urban_planning", "public_assets"];

function selectSources(provincia: string): FirecrawlSource[] {
  const prov = (provincia || "").toUpperCase().trim();
  const pool = filterSources({
    province: prov ? [prov] : undefined,
    sourceTypes: PRIORITY_TYPES,
  });
  // filterSources già ordina per priority desc.
  // Garantiamo prima aste, poi avvisi comunali, poi resto.
  const rank = (s: FirecrawlSource) => {
    const i = PRIORITY_TYPES.indexOf(s.source_type);
    return i === -1 ? 99 : i;
  };
  pool.sort((a, b) => rank(a) - rank(b) || b.priority - a.priority);
  return pool.slice(0, MAX_SOURCES);
}

function classToTipo(c: PageClass): LiveSignal["tipo"] | null {
  switch (c) {
    case "auction":
    case "pvp":
    case "ivg":                return "asta";
    case "municipal_notice":   return "alienazione";   // bandi/alienazioni patrimonio
    case "urban_planning":     return "bando";         // varianti/PI/PAT come bandi pubblici
    case "public_work":        return "lavori_pubblici";
    case "territorial_service":return "rigenerazione";
    default:                   return null;
  }
}

// PII guard: rimuove CF, email, telefoni dall'estratto.
const CF_RE      = /\b[A-Z0-9]{16}\b/g;
const EMAIL_RE   = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const PHONE_RE   = /(?:\+?\d{1,3}[\s.\-]?)?(?:\(?\d{2,4}\)?[\s.\-]?)?\d{3,4}[\s.\-]?\d{3,4}/g;

function sanitizeExcerpt(raw: string): string {
  // Rimuovi marker markdown e collapse whitespace.
  let s = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\[\]()|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(CF_RE, "[redacted]")
       .replace(EMAIL_RE, "[redacted]")
       .replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 7 ? "[redacted]" : m));
  return s.slice(0, 300);
}

function filterRelevantLinks(links: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of links) {
    if (!l || typeof l !== "string") continue;
    if (!/^https?:\/\//i.test(l)) continue;
    if (seen.has(l)) continue;
    seen.add(l);
    if (KEYWORD_REGEX.test(l)) out.push(l);
    if (out.length >= MAX_URLS_PER_SOURCE) break;
  }
  return out;
}

function tipoPriority(t: LiveSignal["tipo"]): number {
  switch (t) {
    case "asta":            return 100;
    case "alienazione":     return 90;
    case "bando":           return 80;
    case "lavori_pubblici": return 70;
    case "delibera":        return 60;
    case "rigenerazione":   return 50;
    default:                return 0;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); })
     .catch(() => { clearTimeout(timer); resolve(fallback); });
  });
}

/**
 * Esegue Firecrawl per arricchire la response con segnali vivi del territorio.
 * Mai blocca: in errore o timeout restituisce ciò che ha raccolto fino a quel
 * momento (o []).
 */
export async function runFirecrawlPhotoEnrichment(
  _lat: number,
  _lng: number,
  provincia: string,
): Promise<LiveSignal[]> {
  const collected: LiveSignal[] = [];
  let timedOut = false;
  const totalTimer = setTimeout(() => { timedOut = true; }, TOTAL_TIMEOUT_MS);

  try {
    const sources = selectSources(provincia);
    if (sources.length === 0) {
      clearTimeout(totalTimer);
      return [];
    }

    // STEP 1 — Map in parallelo per ogni sorgente, una keyword search join.
    const mapResults = await Promise.allSettled(
      sources.map((src) =>
        withTimeout(
          fcMap(src.base_url, {
            search: SEARCH_KEYWORDS.join(" "),
            limit: MAX_URLS_PER_SOURCE * 2,
            timeoutMs: MAP_TIMEOUT_MS,
          }),
          MAP_TIMEOUT_MS + 1_000,
          { ok: false, links: [] as string[] },
        ),
      ),
    );

    if (timedOut) { clearTimeout(totalTimer); return collected; }

    // Costruisci la coda (url, source) con limite globale.
    const queue: Array<{ url: string; source: FirecrawlSource }> = [];
    mapResults.forEach((r, i) => {
      const src = sources[i];
      const links = r.status === "fulfilled" && r.value?.ok ? r.value.links : [];
      const relevant = filterRelevantLinks(links);
      for (const url of relevant) {
        if (queue.length >= MAX_SCRAPES) break;
        queue.push({ url, source: src });
      }
    });

    if (queue.length === 0) { clearTimeout(totalTimer); return collected; }

    // STEP 2 — Scrape top URL in parallelo.
    const scrapes = await Promise.allSettled(
      queue.slice(0, MAX_SCRAPES).map((q) =>
        withTimeout(
          fcScrape(q.url, { timeoutMs: SCRAPE_TIMEOUT_MS, formats: ["markdown"] }),
          SCRAPE_TIMEOUT_MS + 1_000,
          { ok: false, url: q.url } as { ok: boolean; url: string; markdown?: string | null; title?: string | null; publishedAt?: string | null },
        ).then((res) => ({ res, source: q.source })),
      ),
    );

    const nowIso = new Date().toISOString();
    for (const s of scrapes) {
      if (s.status !== "fulfilled") continue;
      const { res, source } = s.value;
      if (!res || !res.ok) continue;
      const md = (res as { markdown?: string | null }).markdown ?? "";
      const url = (res as { url: string }).url;
      const cls = classifyPage(url, md);
      const tipo = classToTipo(cls);
      if (!tipo) continue;
      const titolo = (((res as { title?: string | null }).title) ?? "").trim() || source.source_name;
      const estratto = sanitizeExcerpt(md || titolo);
      collected.push({
        tipo,
        titolo: titolo.slice(0, 200),
        estratto,
        url,
        fonte: source.source_name,
        dataRilevazione: nowIso,
      });
    }
  } catch (e) {
    console.warn(`[firecrawlPhotoEnrichment] error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(totalTimer);
  }

  // Ordina per rilevanza tipo e tronca.
  collected.sort((a, b) => tipoPriority(b.tipo) - tipoPriority(a.tipo));
  return collected.slice(0, MAX_RESULTS);
}

/** Hint di sorgenti potenzialmente raggiungibili per provincia (per fontiUsate). */
export function listFirecrawlSourceNames(provincia: string): string[] {
  return selectSources(provincia).map((s) => s.source_name);
}

// Re-export per il chiamante senza forzare un altro import path.
export { VENETO_SOURCES };
