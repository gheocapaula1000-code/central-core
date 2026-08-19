// Pure Bakeca listing parser — no fetch, no secrets, no Deno.env.
// Firecrawl markdown for Bakeca listing cards is usually:
//   [Titolo](https://www.bakeca.it/dettaglio/… ) € 250.000  85 mq  3 locali  Privato
// Search/category pages must be skipped.

export interface ParsedListing {
  url: string;
  titolo: string;
  prezzo: number | null;
  mq: number | null;
  locali: number | null;
  indirizzo: string | null;
  isPrivato: boolean;
  firstSeenAt: string | null;
}

export const BAKECA_LISTING_PAGES = [
  "https://www.bakeca.it/annunci/immobili-vendita/padova/",
  "https://www.bakeca.it/annunci/vendita-case-appartamenti/padova/",
] as const;

export const BAKECA_MAX_PAGES = 5;

export function bakecaPageUrl(base: string, page: number): string {
  const root = base.replace(/\?.*$/, "").replace(/\/+$/, "/") ;
  if (page <= 1) return root;
  const joiner = root.includes("?") ? "&" : "?";
  return `${root}${joiner}page=${page}`;
}

export function parseEuro(s: string): number | null {
  const m = s.match(/€\s*([\d.]+(?:[\.,]\d{3})*)/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/\./g, "").replace(/,(\d{3})$/, "$1"), 10);
  return Number.isFinite(n) && n > 1000 ? n : null;
}

export function parseInt2(s: string, pat: RegExp): number | null {
  const m = s.match(pat);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

export function isBakecaListingUrl(url: string): boolean {
  if (!/^https?:\/\/(?:www\.)?bakeca\.it\//i.test(url)) return false;
  const path = url.replace(/^https?:\/\/(?:www\.)?bakeca\.it/i, "").split("?")[0];
  if (/\/(immobili-vendita|vendita-case-appartamenti|immobili-in-vendita)\/?$/i.test(path)) {
    return false;
  }
  if (/\/(dettaglio|annuncio)\//i.test(path)) return true;
  if (/\/annunci\/.+\d{5,}/i.test(path)) return true;
  if (/\/\d{6,}(?:\/|$)/.test(path)) return true;
  return false;
}

export function normalizeBakecaUrl(raw: string): string {
  return raw.replace(/[),.;]+$/, "").split("#")[0].split("?")[0];
}

/** Relative Bakeca ages → ISO first-seen estimate (UTC, start of that day). */
export function parseRelativeAge(text: string, now = new Date()): string | null {
  const t = text.toLowerCase();
  if (/\boggi\b/.test(t) || /\b\d+\s*or[ae]\s+fa\b/.test(t)) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  }
  if (/\bieri\b/.test(t)) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString();
  }
  const days = t.match(/(\d{1,3})\s*giorn[io]\s+fa/);
  if (days) {
    const n = parseInt(days[1], 10);
    if (Number.isFinite(n) && n > 0 && n < 4000) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      d.setUTCDate(d.getUTCDate() - n);
      return d.toISOString();
    }
  }
  const weeks = t.match(/(\d{1,2})\s*settiman[ae]\s+fa/);
  if (weeks) {
    const n = parseInt(weeks[1], 10);
    if (Number.isFinite(n) && n > 0 && n < 200) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      d.setUTCDate(d.getUTCDate() - n * 7);
      return d.toISOString();
    }
  }
  const months = t.match(/(\d{1,2})\s*mes[ie]\s+fa/);
  if (months) {
    const n = parseInt(months[1], 10);
    if (Number.isFinite(n) && n > 0 && n < 120) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      d.setUTCMonth(d.getUTCMonth() - n);
      return d.toISOString();
    }
  }
  return null;
}

export function detectPrivato(tail: string): boolean {
  const head = tail.slice(0, 400);
  if (/\bagenzia\b/i.test(head)) return false;
  if (/\b(tecnocasa|gabetti|re\/?max|immobiliare\.it|casa\.it)\b/i.test(head)) return false;
  return /\bprivato\b/i.test(tail);
}

export function parseListingsFromMarkdown(md: string, now = new Date()): ParsedListing[] {
  const out: ParsedListing[] = [];
  const seen = new Set<string>();

  const linkRe = /\[([^\]\n]{4,200})\]\((https?:\/\/[^\s)]*bakeca\.it[^\s)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(md)) !== null) {
    const titolo = m[1].trim();
    const url = normalizeBakecaUrl(m[2]);
    if (!isBakecaListingUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const tail = cardWindow(md, m.index);
    out.push(listingFromTail(url, titolo, tail, now));
  }

  // Bare listing URLs (Firecrawl sometimes drops the markdown link text).
  const bareRe = /https?:\/\/(?:www\.)?bakeca\.it\/[^\s)\]"'<>]+/gi;
  while ((m = bareRe.exec(md)) !== null) {
    const url = normalizeBakecaUrl(m[0]);
    if (!isBakecaListingUrl(url) || seen.has(url)) continue;
    seen.add(url);
    const lineStart = md.lastIndexOf("\n", m.index - 1) + 1;
    const tail = cardWindow(md, lineStart, m.index + url.length);
    const titleGuess = tail.match(/([A-ZÀÈÌÒÙ][^|\n]{8,120})/);
    out.push(listingFromTail(url, titleGuess ? titleGuess[1].trim() : "Annuncio Bakeca", tail, now));
  }

  return out;
}

/** One listing card: from `from` until the next markdown/bare Bakeca link. */
export function cardWindow(md: string, from: number, searchFrom = from + 1): string {
  const slice = md.slice(from, from + 800);
  const rest = md.slice(searchFrom, from + 800);
  const nextMd = rest.search(/\n\s*\[[^\]]{4,200}\]\(https?:\/\/[^\s)]*bakeca\.it/i);
  const nextBare = rest.search(/\n\s*https?:\/\/(?:www\.)?bakeca\.it\//i);
  const cuts = [nextMd, nextBare].filter((n) => n >= 0);
  if (cuts.length === 0) return slice;
  return md.slice(from, searchFrom + Math.min(...cuts));
}

function listingFromTail(url: string, titolo: string, tail: string, now: Date): ParsedListing {
  return {
    url,
    titolo,
    prezzo: parseEuro(tail),
    mq: parseInt2(tail, /(\d{2,4})\s*m(?:q|²|2)/i),
    locali: parseInt2(tail, /(\d{1,2})\s*(?:local[ie]|stanze|vani)/i),
    indirizzo: (() => {
      const indMatch = tail.match(
        /(?:Via|Viale|Piazza|Corso|Largo|Vicolo|Strada)\s+[A-ZÀÈÌÒÙ][^,\n]{3,80}/i,
      );
      return indMatch ? indMatch[0].trim() : null;
    })(),
    isPrivato: detectPrivato(tail),
    firstSeenAt: parseRelativeAge(tail, now),
  };
}
