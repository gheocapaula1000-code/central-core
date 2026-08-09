// UEradar.com — cache persistente di candidati ufficiali + rotazione deterministica.
//
// Modulo puro (nessuna dipendenza di rete): tutte le decisioni di cache-first,
// dedup canonico, rotazione e sanificazione query sono testabili in isolamento.
// Dominio esclusivo: trovabandi-engine. Nessun impatto su altre PWA.

export const CANDIDATE_FRESH_HOURS = 72;
export const CANDIDATE_MAX_POOL = 200;
export const CANDIDATE_NO_CONTENT_QUARANTINE_AFTER = 2;
export const CANDIDATE_NO_CONTENT_COOLDOWN_HOURS = 24;

export type CachedCandidate = {
  url: string;
  title?: string | null;
  snippet?: string | null;
  provider?: string | null;
  discovered_at?: string | null;
  last_seen_at?: string | null;
  last_attempted_at?: string | null;
  attempt_count?: number | null;
  content_hash?: string | null;
};

export type RotationCandidate = CachedCandidate & { url: string };

/**
 * URL canonico per dedup: host minuscolo senza www, senza hash, senza
 * parametri di tracciamento, senza slash finale ridondante.
 */
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "ref",
  "utm_campaign",
  "utm_content",
  "utm_id",
  "utm_medium",
  "utm_source",
  "utm_term",
]);

export function canonicalCandidateUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  const params = [...url.searchParams.keys()];
  for (const key of params) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  const rendered = url.toString();
  return rendered.length > 2000 ? null : rendered;
}

function toTime(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/**
 * Un URL senza contenuto dopo tentativi ripetuti non è una hit fresca utile.
 * Una nuova hit lo riabilita aggiornando last_seen_at dopo last_attempted_at;
 * in alternativa rientra soltanto allo scadere del cooldown esplicito.
 */
export function isCandidateQuarantined(
  candidate: CachedCandidate,
  nowMs: number,
  quarantineAfter = CANDIDATE_NO_CONTENT_QUARANTINE_AFTER,
  cooldownHours = CANDIDATE_NO_CONTENT_COOLDOWN_HOURS,
): boolean {
  const attempts = Math.max(0, Number(candidate.attempt_count ?? 0) || 0);
  const attemptedAt = toTime(candidate.last_attempted_at);
  if (
    candidate.content_hash ||
    attempts < quarantineAfter ||
    attemptedAt == null
  ) {
    return false;
  }
  const seenAt = toTime(candidate.last_seen_at) ?? toTime(candidate.discovered_at);
  if (seenAt != null && seenAt > attemptedAt) return false;
  return nowMs - attemptedAt < cooldownHours * 3_600_000;
}

export function isFreshCandidate(
  candidate: CachedCandidate,
  nowMs: number,
  freshHours = CANDIDATE_FRESH_HOURS,
): boolean {
  if (isCandidateQuarantined(candidate, nowMs)) return false;
  const seen = toTime(candidate.last_seen_at) ?? toTime(candidate.discovered_at);
  if (seen == null) return false;
  return nowMs - seen <= freshHours * 3_600_000;
}

/** Deduplica per URL canonico conservando il record più recente/completo. */
export function dedupeCandidates(
  candidates: CachedCandidate[],
): RotationCandidate[] {
  const byUrl = new Map<string, RotationCandidate>();
  for (const candidate of candidates) {
    const url = canonicalCandidateUrl(candidate.url);
    if (!url) continue;
    const previous = byUrl.get(url);
    if (!previous) {
      byUrl.set(url, { ...candidate, url });
      continue;
    }
    const providers = [
      ...new Set(
        `${previous.provider ?? ""}+${candidate.provider ?? ""}`
          .split("+")
          .map((part) => part.trim())
          .filter(Boolean),
      ),
    ].join("+");
    byUrl.set(url, {
      ...previous,
      ...Object.fromEntries(
        Object.entries(candidate).filter(([, value]) => value != null),
      ),
      url,
      provider: providers || null,
      attempt_count: Math.max(
        Number(previous.attempt_count ?? 0) || 0,
        Number(candidate.attempt_count ?? 0) || 0,
      ),
      last_attempted_at:
        (toTime(previous.last_attempted_at) ?? 0) >=
        (toTime(candidate.last_attempted_at) ?? 0)
          ? (previous.last_attempted_at ?? null)
          : (candidate.last_attempted_at ?? null),
    });
  }
  return [...byUrl.values()].slice(0, CANDIDATE_MAX_POOL);
}

/**
 * Rotazione deterministica: prima i mai tentati, poi i meno recentemente
 * tentati, poi il minor numero di tentativi, infine ordine stabile per URL.
 * Evita che il motore riprocessi sempre le prime hit della ricerca.
 */
export function rotateCandidates(
  candidates: CachedCandidate[],
  limit: number,
  nowMs = Date.now(),
): RotationCandidate[] {
  const pool = dedupeCandidates(candidates).filter(
    (candidate) => !isCandidateQuarantined(candidate, nowMs),
  );
  const sorted = pool.slice().sort((a, b) => {
    const at = toTime(a.last_attempted_at);
    const bt = toTime(b.last_attempted_at);
    if (at == null && bt != null) return -1;
    if (bt == null && at != null) return 1;
    if (at != null && bt != null && at !== bt) return at - bt;
    const ac = Number(a.attempt_count ?? 0) || 0;
    const bc = Number(b.attempt_count ?? 0) || 0;
    if (ac !== bc) return ac - bc;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });
  return sorted.slice(0, Math.max(0, Math.floor(limit)));
}

/**
 * Cache-first: la ricerca a pagamento parte solo se il pool fresco non copre
 * il numero di pagine richiesto.
 */
export function shouldSkipPaidSearch(
  freshCandidateCount: number,
  maxPages: number,
): boolean {
  return freshCandidateCount >= Math.max(1, maxPages);
}

export function freshCandidates(
  candidates: CachedCandidate[],
  nowMs: number,
  freshHours = CANDIDATE_FRESH_HOURS,
): RotationCandidate[] {
  return dedupeCandidates(candidates).filter((candidate) =>
    isFreshCandidate(candidate, nowMs, freshHours),
  );
}

/**
 * Privacy fail-closed: nessun dato di profilo sensibile può raggiungere i
 * provider esterni. Rimuove email/PEC, telefoni, P.IVA/codice fiscale e IBAN.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/gi,
  /\b(?:p\.?\s?iva|partita\s+iva|codice\s+fiscale|c\.?f\.?|iban|pec|telefono|tel\.?|cell\.?)\b[:\s]*[^\s,;]*/gi,
  /\b(?:IT)?\d{11}\b/g,
  /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g,
  /(?:\+39[\s.-]?)?(?:\d[\s.-]?){9,12}\d/g,
];

export function sanitizeProviderQuery(query: unknown): string {
  let value = typeof query === "string" ? query : "";
  for (const pattern of SENSITIVE_PATTERNS) {
    value = value.replace(pattern, " ");
  }
  return value.replace(/\s{2,}/g, " ").trim().slice(0, 400);
}

export function containsSensitiveData(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  return SENSITIVE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}
