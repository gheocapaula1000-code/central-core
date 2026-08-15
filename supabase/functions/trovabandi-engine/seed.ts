// UEradar.com — pagine di partenza ufficiali (seed listing) e raccolta link.
//
// Modulo puro: nessuna rete. Contiene soltanto URL già verificati e la logica
// di estrazione link vincolata all'`official_domain` della fonte.
// Nessun path inventato, nessun dominio nuovo.

/** Pagine di partenza verificate, indicizzate per dominio ufficiale. */
export const SEED_LISTING_URLS: Record<string, string[]> = {
  "provincia.pd.it": [
    "https://www.provincia.pd.it/sovvenzioni-contributi-sussidi-vantaggi-economici",
  ],
  "provincia.padova.it": ["https://www.provincia.padova.it"],
  "padovanet.it": ["https://www.padovanet.it"],
  "pd.camcom.it": ["https://www.pd.camcom.it"],
  "galpatavino.it": ["https://www.galpatavino.it"],
  "bur.regione.veneto.it": ["https://bur.regione.veneto.it"],
};

export const SEED_PROVIDER = "seed-listing";
/** Budget: nessuna esplosione del tempo di collect sulle pagine indice. */
export const SEED_MAX_LINKS_PER_PAGE = 60;

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

export function seedListingUrls(officialDomain: string): string[] {
  return SEED_LISTING_URLS[normalizeDomain(officialDomain)] ?? [];
}

/**
 * Fail-closed: soltanto URL https dello stesso dominio ufficiale (o suoi
 * sottodomini). Qualunque altro schema, host o URL malformato viene scartato.
 */
export function isSameDomainHttpsUrl(
  rawUrl: string,
  officialDomain: string,
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = normalizeDomain(url.hostname);
  const allowed = normalizeDomain(officialDomain);
  return !!allowed && (host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * Estrae i link di una pagina indice ufficiale (HTML o markdown Firecrawl) e
 * conserva soltanto quelli https dello stesso dominio ufficiale.
 */
export function extractSameDomainLinks(
  content: string,
  baseUrl: string,
  officialDomain: string,
  maxLinks = SEED_MAX_LINKS_PER_PAGE,
): string[] {
  if (typeof content !== "string" || !content) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /<a\b[^>]*?href\s*=\s*["']([^"'#\s]+)["']/gi,
    /\]\(\s*(https?:\/\/[^)\s]+)\s*\)/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const href = match[1];
      if (!href || /^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
      let absolute: string;
      try {
        absolute = new URL(href, baseUrl).toString();
      } catch {
        continue;
      }
      if (!isSameDomainHttpsUrl(absolute, officialDomain)) continue;
      const key = absolute.replace(/#.*$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
      if (out.length >= maxLinks) return out;
    }
  }
  return out;
}
