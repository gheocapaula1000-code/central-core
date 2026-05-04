// ═══════════════════════════════════════════════════════════════
// crawlPlanner — genera URL mirati per fonte combinando:
//   - base_url
//   - allowed_paths (concatenati come slug + sottopagine probabili)
//   - sitemap.xml (se disponibile)
//   - fcMap (search-driven discovery)
// Niente bypass: solo URL pubblicamente raggiungibili.
// ═══════════════════════════════════════════════════════════════
import { fcMap } from "./firecrawlClient.ts";
import type { FirecrawlSource } from "./sourceRegistry.ts";

const TARGETED_KEYWORDS = [
  "asta","aste","vendita","vendite","vendite-giudiziarie","pignoramento","liquidazion",
  "alienazion","patrimonio","dismission","concession","valorizzazion",
  "bandi","avvisi","avvisi-pubblici","gare","appalti",
  "amministrazione-trasparente","opere-pubbliche","lavori-pubblici",
  "urbanistica","piano-degli-interventi","piano-interventi","varianti",
  "delibere","atti","provvediment",
  "rigenerazione",
];

function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

async function trySitemap(baseUrl: string): Promise<string[]> {
  try {
    const u = new URL(baseUrl);
    const sm = `${u.origin}/sitemap.xml`;
    const res = await fetch(sm, { headers: { "User-Agent": "CivikoBot/1.0 (+contact@civiko)" } });
    if (!res.ok) return [];
    const xml = await res.text();
    const out: string[] = [];
    const rx = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(xml)) && out.length < 200) {
      const url = m[1].trim();
      if (TARGETED_KEYWORDS.some((k) => url.toLowerCase().includes(k))) out.push(url);
    }
    return out;
  } catch { return []; }
}

function expandSeedPaths(source: FirecrawlSource): string[] {
  const seeds = new Set<string>([source.base_url]);
  const paths = source.allowed_paths ?? [];
  for (const p of paths) {
    seeds.add(joinUrl(source.base_url, p));
    seeds.add(joinUrl(source.base_url, `${p}/`));
    // common Italian municipal patterns
    seeds.add(joinUrl(source.base_url, `it/${p}`));
    seeds.add(joinUrl(source.base_url, `home/${p}`));
  }
  return Array.from(seeds);
}

function allowedByPaths(url: string, s: FirecrawlSource): boolean {
  const u = url.toLowerCase();
  if (s.excluded_paths && s.excluded_paths.some((p) => u.includes(p.toLowerCase()))) return false;
  if (s.allowed_paths && s.allowed_paths.length) {
    return s.allowed_paths.some((p) => u.includes(p.toLowerCase()));
  }
  return true;
}

export async function planCrawlUrls(source: FirecrawlSource, opts: { maxUrls: number; useFirecrawlMap?: boolean; mapSearch?: string }): Promise<string[]> {
  const found = new Set<string>();
  // 1) seeds da allowed_paths
  for (const u of expandSeedPaths(source)) {
    if (allowedByPaths(u, source)) found.add(u);
    if (found.size >= opts.maxUrls) break;
  }
  // 2) sitemap.xml
  if (found.size < opts.maxUrls) {
    const sm = await trySitemap(source.base_url);
    for (const u of sm) {
      if (allowedByPaths(u, source)) found.add(u);
      if (found.size >= opts.maxUrls) break;
    }
  }
  // 3) Firecrawl map (search)
  if (opts.useFirecrawlMap !== false && found.size < opts.maxUrls) {
    const search = opts.mapSearch ?? "asta vendita alienazione bando avviso urbanistica";
    const m = await fcMap(source.base_url, { search, limit: Math.min(opts.maxUrls * 2, 200) });
    if (m.ok) {
      for (const raw of m.links) {
        const l = typeof raw === "string" ? raw : (raw as { url?: string })?.url;
        if (!l || typeof l !== "string") continue;
        if (!allowedByPaths(l, source)) continue;
        found.add(l);
        if (found.size >= opts.maxUrls) break;
      }
    }
  }
  return Array.from(found).slice(0, opts.maxUrls);
}
