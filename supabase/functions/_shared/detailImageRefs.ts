// _shared/detailImageRefs.ts — estrazione multi-foto dai result detail GIÀ
// memorizzati (nessuno scraping, nessun costo provider).
//
// Regole non negoziabili:
//  - solo host realmente osservati nelle evidenze Padova (allowlist condivisa);
//  - massimo 5 URL per annuncio, deduplicati per identità reale della foto
//    (stesso ID immagine in varianti di dimensione = una sola foto);
//  - scarta planimetrie, mappe, loghi, icone, captcha, avatar, banner;
//  - preferisce formati decodificabili (jpg/png) alle varianti webp/avif;
//  - l'URL NON è mai un fingerprint: serve solo a scaricare i byte reali.

import { IMAGE_HOST_ALLOWLIST } from "./imageFetchGuard.ts";

export const MAX_DETAIL_IMAGE_REFS = 5;

const URL_RE =
  /https?:\/\/[^\s"'()<>\\\]]+?\.(?:jpe?g|png|webp|avif)(?:\?[^\s"'()<>\\\]]*)?/gi;

/** Percorsi che non possono essere prova fotografica dell'unità. */
const PATH_DENY =
  /(logo|sprite|icon|favicon|placeholder|captcha|avatar|badge|banner|watermark|pixel|blank|default|thumb(?:nail)?|planimetr|\/plan\/|\/map|static\/|\/ads?\/|agency|agenzia)/i;

/** Miniature dichiarate nell'URL: 120x90, /xs/, -s. , ecc. */
const TINY_HINT = /(?:^|[^0-9])(\d{2,3})x(\d{2,3})(?:[^0-9]|$)/;

const DECODABLE = /\.(jpe?g|png)(?:\?|$)/i;

function hostAllowed(host: string): boolean {
  return IMAGE_HOST_ALLOWLIST.includes(host.toLowerCase());
}

/** Identità della foto: ID numerico più lungo nel path, altrimenti path pulito. */
export function photoIdentityKey(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const segments = u.pathname.split("/").filter(Boolean);
  let best = "";
  for (const seg of segments) {
    for (const num of seg.match(/\d{5,}/g) ?? []) {
      if (num.length > best.length) best = num;
    }
  }
  const family = host.split(".").slice(-2).join(".");
  return best ? `${family}:${best}` : `${family}:${u.pathname.replace(/\.[a-z0-9]+$/i, "")}`;
}

function tooSmall(rawUrl: string): boolean {
  const m = rawUrl.match(TINY_HINT);
  if (!m) return false;
  return Number(m[1]) < 200 || Number(m[2]) < 200;
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || out.length > 4000) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out, depth + 1);
    }
  }
}

/**
 * Estrae fino a `limit` URL di fotografie reali dalle strutture, dall'HTML e
 * dal markdown già memorizzati nel result detail. Deterministico e puro.
 */
export function extractDetailImageRefs(
  result: unknown,
  limit: number = MAX_DETAIL_IMAGE_REFS,
): string[] {
  const strings: string[] = [];
  collectStrings(result, strings);

  const byIdentity = new Map<string, string>();
  for (const s of strings) {
    for (const raw of s.match(URL_RE) ?? []) {
      const url = raw.replace(/&amp;/gi, "&").replace(/\\u002f/gi, "/");
      if (url.length > 400) continue;
      let host: string;
      try {
        const u = new URL(url);
        if (u.protocol !== "https:") continue;
        host = u.hostname.toLowerCase();
      } catch {
        continue;
      }
      if (!hostAllowed(host)) continue;
      if (PATH_DENY.test(new URL(url).pathname)) continue;
      if (tooSmall(url)) continue;

      const key = photoIdentityKey(url);
      if (!key) continue;
      const prev = byIdentity.get(key);
      if (!prev) {
        byIdentity.set(key, url);
        continue;
      }
      // stessa foto: tieni la variante decodificabile e la più "grande"
      const prevOk = DECODABLE.test(prev);
      const curOk = DECODABLE.test(url);
      if (!prevOk && curOk) byIdentity.set(key, url);
      else if (prevOk === curOk && url.length > prev.length) byIdentity.set(key, url);
    }
  }

  return Array.from(byIdentity.values())
    .filter((u) => DECODABLE.test(u))
    .slice(0, Math.max(0, Math.min(limit, MAX_DETAIL_IMAGE_REFS)));
}
