// ═══════════════════════════════════════════════════════════════
// Firecrawl enrichment per civiko-property-from-photo
//
// Self-contained: chiama direttamente l'API Firecrawl v2 (i moduli
// in civiko-radar-veneto/firecrawl non possono essere importati per
// il bundler scope delle edge function).
//
// HARD RULES:
//   - Timeout totale 40s. Restituisce parziale se scade.
//   - PII guard: rimuove CF, email, telefoni dall'estratto.
//   - Mai lancia eccezioni.
// ═══════════════════════════════════════════════════════════════

export interface LiveSignal {
  tipo: "asta" | "alienazione" | "bando" | "lavori_pubblici" | "delibera" | "rigenerazione";
  titolo: string;
  estratto: string;
  url: string;
  fonte: string;
  dataRilevazione: string;
}

const FIRECRAWL_V2 = "https://api.firecrawl.dev/v2";
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

interface MinimalFcSource {
  source_name: string;
  base_url: string;
  source_type: "ivg" | "pvp" | "auctions" | "municipal_notices" | "urban_planning" | "public_assets" | "public_works";
  province: string[];
  priority: number;
}

// Sottoinsieme verificato delle fonti pubbliche Veneto.
// Coerente con VENETO_SOURCES in civiko-radar-veneto/firecrawl/sourceRegistry.ts.
const SOURCES: MinimalFcSource[] = [
  { source_name: "pvp_giustizia_veneto", base_url: "https://pvp.giustizia.it/pvp/it/risultati_ricerca.page",
    source_type: "pvp", province: ["VE","VR","VI","PD","TV","BL","RO"], priority: 96 },
  { source_name: "asteannunci_veneto", base_url: "https://www.asteannunci.it/aste-immobiliari/veneto/",
    source_type: "auctions", province: ["VE","VR","VI","PD","TV","BL","RO"], priority: 88 },
  { source_name: "comune_padova_avvisi", base_url: "https://www.padovanet.it/avvisi",
    source_type: "municipal_notices", province: ["PD"], priority: 75 },
  { source_name: "comune_verona_avvisi", base_url: "https://www.comune.verona.it/nqcontent.cfm?a_id=1",
    source_type: "municipal_notices", province: ["VR"], priority: 74 },
  { source_name: "comune_vicenza_avvisi", base_url: "https://www.comune.vicenza.it/albo/avvisi.php",
    source_type: "municipal_notices", province: ["VI"], priority: 74 },
  { source_name: "comune_treviso_avvisi", base_url: "https://www.comune.treviso.it/albo-pretorio/",
    source_type: "municipal_notices", province: ["TV"], priority: 73 },
  { source_name: "comune_venezia_avvisi", base_url: "https://www.comune.venezia.it/it/notizie",
    source_type: "municipal_notices", province: ["VE"], priority: 73 },
];

const PRIORITY_TYPE_RANK = ["pvp", "ivg", "auctions", "municipal_notices", "public_works", "urban_planning", "public_assets"];

function selectSources(provincia: string): MinimalFcSource[] {
  const prov = (provincia || "").toUpperCase().trim();
  const pool = SOURCES.filter((s) => !prov || s.province.includes(prov));
  pool.sort((a, b) => {
    const ra = PRIORITY_TYPE_RANK.indexOf(a.source_type);
    const rb = PRIORITY_TYPE_RANK.indexOf(b.source_type);
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb) || b.priority - a.priority;
  });
  return pool.slice(0, MAX_SOURCES);
}

// ── inline classifier (coerente con pageClassifier.ts) ──────────
type PageClass = "auction" | "pvp" | "ivg" | "urban_planning" | "public_work" | "municipal_notice" | "territorial_service" | "irrelevant";
const RULES: Array<{ cls: PageClass; tokens: string[] }> = [
  { cls: "pvp",                tokens: ["pvp.giustizia","portale vendite pubbliche"] },
  { cls: "ivg",                tokens: ["ivg ","istituto vendite giudiziarie"] },
  { cls: "auction",            tokens: ["asta","aste immobiliari","vendita giudiziaria","perizia"] },
  { cls: "urban_planning",     tokens: ["pat ","piano interventi","variante urbanistica","p.i.","puc","prg","zoning"] },
  { cls: "public_work",        tokens: ["lavori pubblici","opera pubblica","appalto","cantiere","rotatoria","viabilità","viabilita"] },
  { cls: "municipal_notice",   tokens: ["avviso pubblico","bando","alienazione","patrimonio comunale","dismissione"] },
  { cls: "territorial_service",tokens: ["rigenerazione urbana","brownfield"] },
];
function classifyPage(url: string, markdown: string | null): PageClass {
  const hay = `${url}\n${(markdown ?? "").slice(0, 4000)}`.toLowerCase();
  for (const r of RULES) if (r.tokens.some((t) => hay.includes(t))) return r.cls;
  return "irrelevant";
}
function classToTipo(c: PageClass): LiveSignal["tipo"] | null {
  switch (c) {
    case "auction": case "pvp": case "ivg":   return "asta";
    case "municipal_notice":                  return "alienazione";
    case "urban_planning":                    return "bando";
    case "public_work":                       return "lavori_pubblici";
    case "territorial_service":               return "rigenerazione";
    default:                                  return null;
  }
}

// ── PII guard ───────────────────────────────────────────────────
const CF_RE    = /\b[A-Z0-9]{16}\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?\d{1,3}[\s.\-]?)?(?:\(?\d{2,4}\)?[\s.\-]?)?\d{3,4}[\s.\-]?\d{3,4}/g;

function sanitizeExcerpt(raw: string): string {
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
  return { asta: 100, alienazione: 90, bando: 80, lavori_pubblici: 70, delibera: 60, rigenerazione: 50 }[t] ?? 0;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); })
     .catch(() => { clearTimeout(timer); resolve(fallback); });
  });
}

// ── Firecrawl HTTP (inline) ─────────────────────────────────────
async function fcMap(url: string, search: string, key: string): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MAP_TIMEOUT_MS);
  try {
    const res = await fetch(`${FIRECRAWL_V2}/map`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, search, limit: MAX_URLS_PER_SOURCE * 2, includeSubdomains: false }),
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    const raw: unknown[] = Array.isArray(data?.links)
      ? data.links
      : Array.isArray(data?.data?.links) ? data.data.links
      : Array.isArray(data?.data) ? data.data : [];
    return raw.map((l) => (typeof l === "string" ? l : (l as { url?: string })?.url ?? ""))
              .filter((s): s is string => typeof s === "string" && s.length > 0);
  } catch { return []; }
  finally { clearTimeout(timer); }
}

interface FcScrape { ok: boolean; url: string; markdown: string | null; title: string | null }
async function fcScrape(url: string, key: string): Promise<FcScrape> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SCRAPE_TIMEOUT_MS);
  try {
    const res = await fetch(`${FIRECRAWL_V2}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, url, markdown: null, title: null };
    const data = await res.json().catch(() => ({}));
    const root = data?.data ?? data;
    const md = typeof root?.markdown === "string" ? root.markdown.slice(0, 12_000) : null;
    const title = typeof root?.metadata?.title === "string" ? root.metadata.title : null;
    return { ok: true, url, markdown: md, title };
  } catch { return { ok: false, url, markdown: null, title: null }; }
  finally { clearTimeout(timer); }
}

/** Esegue Firecrawl. Mai blocca: in errore o timeout → parziale. */
export async function runFirecrawlPhotoEnrichment(
  _lat: number,
  _lng: number,
  provincia: string,
): Promise<LiveSignal[]> {
  const collected: LiveSignal[] = [];
  let timedOut = false;
  const totalTimer = setTimeout(() => { timedOut = true; }, TOTAL_TIMEOUT_MS);

  try {
    const key = Deno.env.get("FIRECRAWL_API_KEY");
    if (!key) { clearTimeout(totalTimer); return []; }
    const sources = selectSources(provincia);
    if (sources.length === 0) { clearTimeout(totalTimer); return []; }

    const search = SEARCH_KEYWORDS.join(" ");
    const mapResults = await Promise.allSettled(
      sources.map((s) => withTimeout(fcMap(s.base_url, search, key), MAP_TIMEOUT_MS + 1_000, [] as string[])),
    );
    if (timedOut) { clearTimeout(totalTimer); return collected; }

    const queue: Array<{ url: string; source: MinimalFcSource }> = [];
    mapResults.forEach((r, i) => {
      const src = sources[i];
      const links = r.status === "fulfilled" ? r.value : [];
      for (const url of filterRelevantLinks(links)) {
        if (queue.length >= MAX_SCRAPES) break;
        queue.push({ url, source: src });
      }
    });
    if (queue.length === 0) { clearTimeout(totalTimer); return collected; }

    const scrapes = await Promise.allSettled(
      queue.slice(0, MAX_SCRAPES).map((q) =>
        withTimeout(fcScrape(q.url, key), SCRAPE_TIMEOUT_MS + 1_000, { ok: false, url: q.url, markdown: null, title: null } as FcScrape)
          .then((res) => ({ res, source: q.source })),
      ),
    );

    const nowIso = new Date().toISOString();
    for (const s of scrapes) {
      if (s.status !== "fulfilled") continue;
      const { res, source } = s.value;
      if (!res.ok) continue;
      const cls = classifyPage(res.url, res.markdown);
      const tipo = classToTipo(cls);
      if (!tipo) continue;
      const titolo = (res.title ?? "").trim() || source.source_name;
      collected.push({
        tipo,
        titolo: titolo.slice(0, 200),
        estratto: sanitizeExcerpt(res.markdown || titolo),
        url: res.url,
        fonte: source.source_name,
        dataRilevazione: nowIso,
      });
    }
  } catch (e) {
    console.warn(`[firecrawlPhotoEnrichment] error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(totalTimer);
  }

  collected.sort((a, b) => tipoPriority(b.tipo) - tipoPriority(a.tipo));
  return collected.slice(0, MAX_RESULTS);
}

export function listFirecrawlSourceNames(provincia: string): string[] {
  return selectSources(provincia).map((s) => s.source_name);
}
