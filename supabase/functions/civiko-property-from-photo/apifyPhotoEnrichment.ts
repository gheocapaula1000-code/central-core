// ═══════════════════════════════════════════════════════════════
// Apify enrichment per civiko-property-from-photo
//
// NOTA: Le edge function Supabase non possono importare moduli da
// altre function dirs (bundler scope). Per rispettare il vincolo
// "non modificare i file di civiko-radar-veneto/apify/", qui
// chiamiamo direttamente l'API HTTP di Apify usando una versione
// minimale e read-only del registry (sottoinsieme verificato).
// La logica e le actor_id sono allineate a APIFY_VENETO_REGISTRY.
//
// HARD RULES:
//   - Timeout totale 45s. Mai bloccante.
//   - Token Apify mai loggato/restituito.
//   - In errore → [].
// ═══════════════════════════════════════════════════════════════

export interface TerritorialDocument {
  tipo: "open_data" | "urbanistica" | "geoportale" | "alienazione_comunale";
  titolo: string;
  descrizione: string;
  url: string;
  fonte: string;
  dataPublicazione?: string;
}

const TOTAL_TIMEOUT_MS = 45_000;
const PER_SOURCE_TIMEOUT_MS = 25_000;
const MAX_SOURCES = 2;
const MAX_DOCS_PER_SOURCE = 6;
const APIFY_BASE = "https://api.apify.com/v2";

// Mappa province → token presenti nei source_name.
const PROVINCE_TOKENS: Record<string, string[]> = {
  PD: ["padova"], VR: ["verona"], VI: ["vicenza"],
  VE: ["venezia"], TV: ["treviso"], BL: ["belluno"], RO: ["rovigo"],
};

interface MinimalSource {
  source_name: string;
  tipo: TerritorialDocument["tipo"];
  priority: number;          // 100 = top
  actor_id: string;          // apify actor
  start_urls: string[];
  allowed_use: string;
}

// Sottoinsieme verificato del registry Veneto. Tutti read-only.
// Coerente con APIFY_VENETO_REGISTRY (stessi actor_id, stesse base_url).
const SOURCES: MinimalSource[] = [
  {
    source_name: "comune_padova_urbanistica",
    tipo: "urbanistica",
    priority: 100,
    actor_id: "apify/website-content-crawler",
    start_urls: ["https://www.padovanet.it/informazione/urbanistica"],
    allowed_use: "trasparenza",
  },
  {
    source_name: "comune_vicenza_alienazioni",
    tipo: "alienazione_comunale",
    priority: 100,
    actor_id: "apify/website-content-crawler",
    start_urls: ["https://www.comune.vicenza.it/albo/avvisi.php"],
    allowed_use: "trasparenza",
  },
  {
    source_name: "comune_verona_pdf_index",
    tipo: "urbanistica",
    priority: 70,
    actor_id: "apify/website-content-crawler",
    start_urls: ["https://www.comune.verona.it/nqcontent.cfm?a_id=1"],
    allowed_use: "trasparenza",
  },
  {
    source_name: "open_data_veneto_discovery",
    tipo: "open_data",
    priority: 40,
    actor_id: "apify/website-content-crawler",
    start_urls: ["https://dati.veneto.it/dataset?groups=urbanistica"],
    allowed_use: "open_data",
  },
  {
    source_name: "geoportale_veneto_layers",
    tipo: "geoportale",
    priority: 60,
    actor_id: "apify/website-content-crawler",
    start_urls: ["https://idt2.regione.veneto.it/"],
    allowed_use: "open_data",
  },
];

function selectSources(provincia: string): MinimalSource[] {
  const prov = (provincia || "").toUpperCase().trim();
  const tokens = PROVINCE_TOKENS[prov] ?? [];
  const filtered = SOURCES.filter((s) => {
    const lower = s.source_name.toLowerCase();
    if (tokens.some((tok) => lower.includes(tok))) return true;
    return /veneto/.test(lower);
  });
  filtered.sort((a, b) => b.priority - a.priority);
  return filtered.slice(0, MAX_SOURCES);
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); })
     .catch(() => { clearTimeout(timer); resolve(fallback); });
  });
}

function safeStr(v: unknown, max = 400): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : String(v);
  return s.trim().slice(0, max);
}

interface ApifyItem {
  url?: string; loadedUrl?: string;
  title?: string; metadata?: { title?: string; description?: string };
  description?: string; text?: string; markdown?: string;
  publishedAt?: string;
}

async function runActorSync(
  src: MinimalSource,
  token: string,
): Promise<TerritorialDocument[]> {
  // run-sync-get-dataset-items: actor parte e ritorna il dataset
  // alla chiusura. Usiamo timeout HTTP a 25s.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_SOURCE_TIMEOUT_MS);
  try {
    const actorPath = src.actor_id.replace("/", "~");
    const url = `${APIFY_BASE}/acts/${actorPath}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=20&memory=512`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startUrls: src.start_urls.map((u) => ({ url: u })),
        maxCrawlPages: 12,
        maxCrawlDepth: 1,
        crawlerType: "cheerio",
        respectRobotsTxtFile: true,
        saveMarkdown: true,
        saveHtml: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const items = (await res.json().catch(() => [])) as ApifyItem[];
    if (!Array.isArray(items)) return [];
    const out: TerritorialDocument[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      const u = safeStr(it.url ?? it.loadedUrl ?? "", 600);
      if (!u || seen.has(u)) continue;
      seen.add(u);
      const titolo = safeStr(it.title ?? it.metadata?.title ?? "", 200) || src.source_name;
      const descrizione = safeStr(it.description ?? it.metadata?.description ?? it.text ?? it.markdown ?? "", 300) || src.allowed_use;
      out.push({
        tipo: src.tipo,
        titolo,
        descrizione,
        url: u,
        fonte: src.source_name,
        ...(it.publishedAt ? { dataPublicazione: safeStr(it.publishedAt, 40) } : {}),
      });
      if (out.length >= MAX_DOCS_PER_SOURCE) break;
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Esegue Apify per arricchire la response con documenti territoriali.
 * Mai blocca: timeout totale 45s, in errore → [].
 *
 * NOTA: lat/lng non sono usati per filtrare sorgenti (il registry non
 * è geolocalizzato); la selezione avviene per provincia + tipo.
 */
export async function runApifyPhotoEnrichment(
  _lat: number,
  _lng: number,
  provincia: string,
): Promise<TerritorialDocument[]> {
  try {
    const token = Deno.env.get("APIFY_TOKEN") || Deno.env.get("APIFY_API_TOKEN");
    if (!token) return [];
    const sources = selectSources(provincia);
    if (sources.length === 0) return [];

    const run = async (): Promise<TerritorialDocument[]> => {
      const all: TerritorialDocument[] = [];
      for (const src of sources) {
        const docs = await withTimeout(runActorSync(src, token), PER_SOURCE_TIMEOUT_MS + 1_000, []);
        all.push(...docs);
      }
      return all;
    };

    return await withTimeout(run(), TOTAL_TIMEOUT_MS, []);
  } catch (e) {
    console.warn(`[apifyPhotoEnrichment] error: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** Hint sorgenti potenziali per provincia (per fontiUsate). */
export function listApifySourceNames(provincia: string): string[] {
  return selectSources(provincia).map((s) => s.source_name);
}
