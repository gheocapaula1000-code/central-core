// TrovaBandi — risoluzione avviso da pagina indice/elenco.
//
// Se official_url è un elenco / home / bandi, si seguono soltanto link
// https dello stesso host che sembrano un avviso (bando, avviso, decreto,
// misura, sportello). Nessun aggregatore (Bandiora), nessun dominio nuovo.

import { isIndexOrLandingUrl } from "./opportunity-gate.ts";
import { isAllowedOfficialUrl, isBlockedAggregatorUrl } from "./scrape.ts";

export interface NoticeLink {
  url: string;
  score: number;
  label: string;
}

const HTML_LINK =
  /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))[^>]*>([\s\S]*?)<\/a>/gi;
const MD_LINK = /\[([^\]]{0,200})\]\(\s*<?([^)\s>]+)>?\s*\)/gi;

const NOTICE_HINT =
  /\b(bando|avviso|decreto|determina|delibera|misura|sportello)\b/i;

const LISTING_SEGMENT =
  /^(bandi|avvisi|incentivi|contributi|agevolazioni|opportunita|opportunità|elenco|elenchi|lista|news|novita|novità|faq|faqs|newsletter|home|homepage|index|index\.html|index\.php)(?:[-_].*)?$/i;

const LISTING_PREFIX =
  /^(bandi|avvisi|elenco|elenchi|incentivi|contributi)([-_]|$)/i;

const NEGATIVE =
  /(privacy|cookie|accessibilit|login|newsletter|facebook|twitter|linkedin|instagram|youtube|rss|\.(?:jpg|jpeg|png|gif|svg|zip|mp4)(?:\?|#|$))/i;

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function canonical(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function pathLeaf(url: string): string {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    return (segments[segments.length - 1] ?? "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Indice, elenco, home o pagina /bandi senza scheda.
 * `/bandi/digitalizzazione-2026` non è un elenco: la foglia non è un listing.
 */
export function isOfficialListingUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url.trim()) return true;
  if (isIndexOrLandingUrl(url)) return true;
  const leaf = pathLeaf(url);
  if (!leaf) return true;
  return LISTING_SEGMENT.test(leaf) || LISTING_PREFIX.test(leaf);
}

/** Path o query che nominano un avviso, non un elenco. */
export function isNoticeLikeUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url.trim()) return false;
  if (isOfficialListingUrl(url)) return false;
  try {
    const parsed = new URL(url);
    const hay = `${parsed.pathname} ${parsed.search}`;
    return NOTICE_HINT.test(hay);
  } catch {
    return false;
  }
}

function scoreNotice(label: string, url: string): number {
  const hay = `${label} ${url}`;
  if (NEGATIVE.test(hay)) return 0;
  let score = 0;
  if (/\bavviso\b/i.test(hay)) score += 6;
  if (/\bbando\b/i.test(hay)) score += 6;
  if (/\bdecreto\b/i.test(hay)) score += 5;
  if (/\b(determina|delibera)\b/i.test(hay)) score += 4;
  if (/\bmisura\b/i.test(hay)) score += 4;
  if (/\bsportello\b/i.test(hay)) score += 4;
  if (/\.pdf(\?|#|$)/i.test(url)) score += 2;
  return score;
}

function consider(
  scored: Map<string, NoticeLink>,
  rawHref: string,
  label: string,
  baseUrl: string,
  officialDomain: string,
  excluded: Set<string>,
) {
  if (!rawHref || rawHref.startsWith("#")) return;
  if (/^(javascript|mailto|tel|data):/i.test(rawHref)) return;
  let absolute: string;
  try {
    absolute = canonical(new URL(rawHref, baseUrl).toString());
  } catch {
    return;
  }
  if (!absolute || excluded.has(absolute)) return;
  if (isBlockedAggregatorUrl(absolute)) return;
  if (!isAllowedOfficialUrl(absolute, officialDomain)) return;
  if (isOfficialListingUrl(absolute)) return;
  const text = stripTags(label).slice(0, 200);
  const score = scoreNotice(text, absolute);
  if (score <= 0 && !isNoticeLikeUrl(absolute)) return;
  const finalScore = score > 0 ? score : 1;
  const existing = scored.get(absolute);
  if (!existing || existing.score < finalScore) {
    scored.set(absolute, { url: absolute, score: finalScore, label: text });
  }
}

/**
 * Link stesso-host che sembrano un avviso. Nessun fetch: solo parsing.
 */
export function extractNoticeLinks(
  html: string,
  markdown: string,
  baseUrl: string,
  officialDomain: string,
  options?: { limit?: number; exclude?: Iterable<string> },
): NoticeLink[] {
  const limit = Math.max(0, options?.limit ?? 6);
  if (limit === 0) return [];
  const excluded = new Set(
    [...(options?.exclude ?? [])].map((value) => canonical(value)).filter(Boolean),
  );
  const base = canonical(baseUrl);
  if (base) excluded.add(base);

  const scored = new Map<string, NoticeLink>();

  if (html) {
    HTML_LINK.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HTML_LINK.exec(html)) !== null) {
      const href = (match[2] ?? match[3] ?? match[4] ?? "").trim();
      consider(scored, href, match[5] ?? "", baseUrl, officialDomain, excluded);
    }
  }

  if (markdown) {
    MD_LINK.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MD_LINK.exec(markdown)) !== null) {
      consider(
        scored,
        (match[2] ?? "").trim(),
        match[1] ?? "",
        baseUrl,
        officialDomain,
        excluded,
      );
    }
  }

  return [...scored.values()]
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .slice(0, limit);
}
