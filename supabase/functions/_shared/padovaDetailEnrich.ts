// ═══════════════════════════════════════════════════════════════
// padovaDetailEnrich — funzioni PURE per l'arricchimento "detail"
// dei collect Padova (Subito / Idealista) PRIMA della promote.
//
// VINCOLI:
// - Nessun fetch, nessun secret, nessun accesso DB in questo modulo.
// - Nessun dato inventato: il quartiere è accettato SOLO se combacia
//   con un'etichetta già presente nella mappa ufficiale
//   civiko_quartiere_commercial_zone_map (passata come allowlist).
// - L'indirizzo è accettato SOLO se `extractViaFromText` riconosce un
//   odonimo reale (via/piazza/corso…), mai un quartiere.
// - Selezione candidati bounded e deterministica.
// ═══════════════════════════════════════════════════════════════

import { extractViaFromText, isQuartiereLabel, stripAccents } from "./unitEvidenceExtractor.ts";

export type DetailPortal = "subito.it" | "idealista.it";

export const DETAIL_ENRICH_PORTALS: DetailPortal[] = ["subito.it", "idealista.it"];

/** Cap massimo assoluto di pagine di dettaglio per run (difesa in profondità). */
export const DETAIL_ENRICH_HARD_CAP = 40;
/** Default per run. */
export const DETAIL_ENRICH_DEFAULT_LIMIT = 15;

export interface CollectRowLike {
  id: number | string;
  portal: string | null;
  url: string | null;
  quartiere?: string | null;
  raw_address?: string | null;
}

/** Indirizzi generici che NON identificano una via (es. "Padova (PD)"). */
const GENERIC_ADDRESS_RE =
  /^(padova(\s*\(pd\))?|padova,\s*padova|provincia di padova|veneto|italia)$/i;

export function isGenericAddress(raw: string | null | undefined): boolean {
  const v = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!v) return true;
  if (GENERIC_ADDRESS_RE.test(v)) return true;
  return extractViaFromText(v) === null;
}

export function normalizeDetailPortal(raw: string | null | undefined): DetailPortal | null {
  const v = (raw ?? "").toLowerCase().trim();
  if (v === "subito" || v === "subito.it") return "subito.it";
  if (v === "idealista" || v === "idealista.it") return "idealista.it";
  return null;
}

/** True se la riga collect ha bisogno del detail scrape (manca quartiere E indirizzo utile). */
export function needsDetailEnrichment(row: CollectRowLike): boolean {
  if (normalizeDetailPortal(row.portal) === null) return false;
  const url = (row.url ?? "").trim();
  if (!/^https:\/\/(www\.)?(subito|idealista)\.it\//i.test(url)) return false;
  const q = (row.quartiere ?? "").trim();
  if (q && !/^padova$/i.test(q)) return false;
  return isGenericAddress(row.raw_address);
}

/** Selezione bounded e deterministica (ordine stabile per id). */
export function selectDetailEnrichCandidates<T extends CollectRowLike>(
  rows: T[],
  limit = DETAIL_ENRICH_DEFAULT_LIMIT,
): T[] {
  const cap = Math.max(0, Math.min(Math.floor(limit) || 0, DETAIL_ENRICH_HARD_CAP));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (!needsDetailEnrichment(r)) continue;
    const key = (r.url ?? "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= cap) break;
  }
  return out;
}

function canonQuartiere(raw: string): string {
  return stripAccents(raw).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Indicizza l'allowlist ufficiale dei quartieri (etichette DB) per lookup canonico. */
export function buildQuartiereIndex(labels: Array<string | null | undefined>): Map<string, string> {
  const idx = new Map<string, string>();
  for (const l of labels) {
    const v = (l ?? "").trim();
    if (!v) continue;
    const k = canonQuartiere(v);
    if (k.length < 3) continue;
    if (!idx.has(k)) idx.set(k, v);
  }
  return idx;
}

export interface DetailLocation {
  quartiere: string | null;
  address: string | null;
}

function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const blocks = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const b of blocks) {
    const inner = b.replace(/^[\s\S]*?>/, "").replace(/<\/script>\s*$/i, "");
    try {
      const parsed = JSON.parse(inner);
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch { /* blocco non valido: ignorato */ }
  }
  return out;
}

function collectStrings(node: unknown, keys: string[], acc: string[], depth = 0): void {
  if (!node || typeof node !== "object" || depth > 6) return;
  if (Array.isArray(node)) {
    for (const n of node) collectStrings(n, keys, acc, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === "string" && keys.includes(k)) acc.push(v);
    else collectStrings(v, keys, acc, depth + 1);
  }
}

/**
 * Estrae quartiere/indirizzo da una pagina di dettaglio.
 * Fail-closed: restituisce null quando non c'è evidenza.
 */
export function parseDetailLocation(
  portal: DetailPortal,
  markdown: string,
  html: string,
  quartiereIndex: Map<string, string>,
): DetailLocation {
  const md = typeof markdown === "string" ? markdown.slice(0, 40_000) : "";
  const rawHtml = typeof html === "string" ? html.slice(0, 120_000) : "";

  // 1) JSON-LD (schema.org PostalAddress)
  const ldStrings: string[] = [];
  for (const block of jsonLdBlocks(rawHtml)) {
    collectStrings(block, ["streetAddress", "addressLocality", "addressRegion", "name"], ldStrings);
  }

  // 2) Testo mirato: breadcrumb / etichette di zona
  const textCandidates: string[] = [];
  const zoneRe = /(?:zona|quartiere)\s*[:\-–]\s*([^\n|,;<]{3,60})/gi;
  let m: RegExpExecArray | null;
  while ((m = zoneRe.exec(md)) !== null) textCandidates.push(m[1]);
  const crumbRe = portal === "idealista.it"
    ? /\bin\s+([A-Za-zÀ-ÿ'’\s-]{3,40}),\s*Padova\b/g
    : /\bPadova\s*(?:>|›|\/|»)\s*([A-Za-zÀ-ÿ'’\s-]{3,40})/g;
  while ((m = crumbRe.exec(md)) !== null) textCandidates.push(m[1]);

  // Quartiere: SOLO se presente nell'allowlist ufficiale.
  let quartiere: string | null = null;
  for (const cand of [...textCandidates, ...ldStrings]) {
    const hit = quartiereIndex.get(canonQuartiere(cand));
    if (hit) { quartiere = hit; break; }
  }

  // Indirizzo: solo odonimi reali, mai etichette di quartiere.
  let address: string | null = null;
  for (const cand of [...ldStrings, ...md.split(/\n/).slice(0, 60)]) {
    if (!cand || isQuartiereLabel(cand)) continue;
    const via = extractViaFromText(cand);
    if (via) { address = via.slice(0, 200); break; }
  }

  return { quartiere, address };
}

/** Patch minima da scrivere su padova_collect_v2_items (solo campi con evidenza). */
export function buildCollectPatch(
  row: CollectRowLike,
  loc: DetailLocation,
): Record<string, string> | null {
  const patch: Record<string, string> = {};
  if (loc.quartiere && !(row.quartiere ?? "").trim()) patch.quartiere = loc.quartiere;
  if (loc.address && isGenericAddress(row.raw_address)) patch.raw_address = loc.address;
  return Object.keys(patch).length > 0 ? patch : null;
}
