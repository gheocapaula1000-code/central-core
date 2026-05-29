// _shared/snapshotPing.ts
// Pure-logic helpers for the Padova snapshot "ping" job.
// Kept dependency-free so it can be unit-tested under vitest/node.

export type PingOutcome = "ok" | "removed" | "error";

export interface FirecrawlPingResult {
  outcome: PingOutcome;
  http_status: number | null;
  price_eur: number | null;
  surface_sqm: number | null;
}

/**
 * Parse a Firecrawl /v2/scrape JSON response into a normalised ping result.
 * Returns:
 *   - "removed" when the upstream portal answered 404 / 410 / 451 OR the markdown
 *     contains an unambiguous "annuncio non disponibile / rimosso" indicator;
 *   - "ok" when a numeric price was extracted (either via JSON formats or markdown);
 *   - "error" for everything else (transient network / parser issue → retry next night).
 */
export function parseFirecrawlPing(raw: unknown): FirecrawlPingResult {
  if (!raw || typeof raw !== "object") {
    return { outcome: "error", http_status: null, price_eur: null, surface_sqm: null };
  }
  const r = raw as Record<string, unknown>;
  const data = (r.data && typeof r.data === "object" ? r.data : r) as Record<string, unknown>;
  const meta = (data.metadata && typeof data.metadata === "object" ? data.metadata : {}) as Record<string, unknown>;
  const httpStatus = typeof meta.statusCode === "number" ? meta.statusCode : null;

  if (httpStatus === 404 || httpStatus === 410 || httpStatus === 451) {
    return { outcome: "removed", http_status: httpStatus, price_eur: null, surface_sqm: null };
  }

  const markdown = typeof data.markdown === "string" ? data.markdown : "";
  const removedHints = [
    "più disponibile",
    "non e' più disponibile",
    "annuncio non disponibile",
    "annuncio scaduto",
    "annuncio rimosso",
    "pagina non trovata",
    "page not found",
  ];
  const md = markdown.toLowerCase();
  if (md.length > 0 && removedHints.some((h) => md.includes(h))) {
    return { outcome: "removed", http_status: httpStatus, price_eur: null, surface_sqm: null };
  }

  // Extract price: prefer JSON format payload, fall back to markdown regex.
  let price: number | null = null;
  let surface: number | null = null;
  const json = (data.json && typeof data.json === "object" ? data.json : null) as Record<string, unknown> | null;
  if (json) {
    price = parsePrice(json.price ?? json.price_eur ?? json.prezzo);
    surface = parseSurface(json.surface_sqm ?? json.surface ?? json.superficie);
  }
  if (price == null && markdown) {
    const m = markdown.match(/€\s*([0-9][0-9.\s]{2,})/);
    if (m) price = parsePrice(m[1]);
  }
  if (price != null && Number.isFinite(price) && price > 1000) {
    return { outcome: "ok", http_status: httpStatus ?? 200, price_eur: price, surface_sqm: surface };
  }
  return { outcome: "error", http_status: httpStatus, price_eur: null, surface_sqm: null };
}

function parsePrice(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[^0-9,.\s]/g, "").trim();
  if (!s) return null;
  const n = Number(s.replace(/\./g, "").replace(/\s+/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function parseSurface(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw);
  if (typeof raw !== "string") return null;
  const m = raw.match(/(\d{1,5})/);
  return m ? Number(m[1]) : null;
}

/** Convert an ISO timestamp into its UTC date key (YYYY-MM-DD). */
export function utcDateKey(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/**
 * Given a list of recorded failure timestamps (ISO strings) and a new failure today,
 * decide whether the listing should be confirmed as delisted. The rule is: at least
 * TWO distinct UTC days with a 404 ping. A single 404 is never enough.
 */
export function shouldConfirmDelisted(previousFailures: Array<string | Date>, now: Date): boolean {
  const days = new Set<string>();
  for (const f of previousFailures) {
    const k = utcDateKey(f);
    if (k) days.add(k);
  }
  days.add(utcDateKey(now));
  return days.size >= 2;
}
