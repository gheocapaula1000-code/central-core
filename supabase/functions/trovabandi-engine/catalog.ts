// TrovaBandi — catalogo ufficiale aperto (Bandiora-style).
// Nessun matching di profilo obbligatorio, nessuna invenzione di COMPATIBILE
// o di prefissi ATECO. Il feed personale resta invariato in index.ts.

export const CATALOG_DEFAULT_LIMIT = 5000;
export const CATALOG_MAX_LIMIT = 5000;
export const CATALOG_SAFE_CAP = 5000;
export const CATALOG_MIN_DEFAULT = 200;

/** Colonne contratto PWA (sanitizeFeedResponse) + campi catalogo. No raw_excerpt. */
export const CATALOG_SELECT_COLUMNS = [
  "id",
  "title",
  "authority_name",
  "authority_level",
  "category",
  "summary",
  "official_url",
  "notice_url",
  "region",
  "province",
  "municipality",
  "protocol_email",
  "source_kind",
  "programme_name",
  "programme_code",
  "pnrr_mission",
  "pnrr_component",
  "implementing_body",
  "forms_url",
  "application_url",
  "deadline_at",
  "opens_at",
  "last_verified_at",
  "first_seen_at",
  "max_grant_amount",
  "min_grant_amount",
  "rarity_score",
  "min_partners",
  "aid_intensity_percent",
  "total_budget",
  "click_day",
  "official_source",
  "consortium_required",
  "requirements",
  "eligible_expenses",
  "eligible_countries",
  "eligible_ateco_prefixes",
  "verification_status",
].join(",");

export type CatalogProfile = {
  codice_ateco?: string;
  ateco_secondari?: string[];
};

export type CatalogMatch = {
  status: "COMPATIBILE" | "DA_VERIFICARE";
  score: number;
  confirmed: string[];
  missing: string[];
  blockers: string[];
};

export type CatalogPaging = {
  limit: number;
  page: number;
  offset: number;
  fetchAll: boolean;
};

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCode(value: unknown): string {
  return normalizeText(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function isCatalogRequest(
  action: string,
  body: { mode?: unknown } = {},
): boolean {
  if (action === "catalog") return true;
  if (action !== "feed") return false;
  return normalizeText(body.mode).toLowerCase() === "catalog";
}

/** URL ufficiale reale: solo http(s) con hostname. */
export function isRealHttpUrl(value: unknown): value is string {
  if (!normalizeText(value)) return false;
  try {
    const parsed = new URL(normalizeText(value));
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !!parsed.hostname
    );
  } catch {
    return false;
  }
}

export function isOfficialOpenDeadline(
  deadlineAt: unknown,
  now: Date = new Date(),
): boolean {
  if (deadlineAt == null || deadlineAt === "") return true;
  const parsed = Date.parse(String(deadlineAt));
  if (!Number.isFinite(parsed)) return false;
  return parsed >= now.getTime();
}

/**
 * Riga ammissibile al catalogo: official_source, titolo, URL http(s) reale,
 * scadenza assente o non passata. Non inventa ATECO né COMPATIBILE.
 */
export function isOfficialOpenCatalogRow(
  row: {
    official_source?: unknown;
    title?: unknown;
    authority_name?: unknown;
    summary?: unknown;
    official_url?: unknown;
    deadline_at?: unknown;
  },
  now: Date = new Date(),
): boolean {
  if (row.official_source !== true) return false;
  if (!normalizeText(row.title)) return false;
  if (!normalizeText(row.authority_name)) return false;
  if (!normalizeText(row.summary)) return false;
  if (!isRealHttpUrl(row.official_url)) return false;
  return isOfficialOpenDeadline(row.deadline_at, now);
}

export function parseCatalogPaging(
  body: Record<string, unknown>,
): CatalogPaging {
  const hasLimit = body.limit != null && body.limit !== "";
  const hasPage = body.page != null && body.page !== "";
  const hasCursor = body.cursor != null && body.cursor !== "";
  const fetchAll = !hasLimit && !hasPage && !hasCursor;

  let page = 1;
  if (hasPage) {
    const parsed = Math.trunc(Number(body.page));
    page = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  } else if (hasCursor && (typeof body.cursor === "string" || typeof body.cursor === "number")) {
    const parsed = Math.trunc(Number(body.cursor));
    page = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  const rawLimit = hasLimit ? Math.trunc(Number(body.limit)) : NaN;
  const limit = fetchAll
    ? CATALOG_SAFE_CAP
    : Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(CATALOG_MAX_LIMIT, rawLimit))
      : CATALOG_DEFAULT_LIMIT;

  return {
    limit,
    page,
    offset: (page - 1) * (fetchAll ? CATALOG_MAX_LIMIT : limit),
    fetchAll,
  };
}

function profileAtecos(profile: CatalogProfile | null | undefined): string[] {
  if (!profile) return [];
  return [profile.codice_ateco, ...(profile.ateco_secondari ?? [])]
    .map(normalizeCode)
    .filter(Boolean);
}

function officialAtecoPrefixes(row: {
  eligible_ateco_prefixes?: unknown;
}): string[] {
  const raw = row.eligible_ateco_prefixes;
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeCode).filter(Boolean);
}

/**
 * Match opzionale del catalogo. Senza profilo: omesso.
 * COMPATIBILE solo se i prefissi ATECO già presenti sulla riga matchano
 * il profilo fornito. Non inventa prefissi (niente ATECO 62 fittizio).
 */
export function catalogMatch(
  row: { eligible_ateco_prefixes?: unknown },
  profile?: CatalogProfile | null,
): CatalogMatch | undefined {
  const atecos = profileAtecos(profile);
  if (atecos.length === 0) return undefined;
  const prefixes = officialAtecoPrefixes(row);
  if (prefixes.length === 0) {
    return {
      status: "DA_VERIFICARE",
      score: 40,
      confirmed: [],
      missing: ["ATECO da verificare nel testo ufficiale"],
      blockers: [],
    };
  }
  const matched = prefixes.some((prefix) =>
    atecos.some((ateco) => ateco.startsWith(prefix)),
  );
  if (matched) {
    return {
      status: "COMPATIBILE",
      score: 70,
      confirmed: ["Codice ATECO ammesso"],
      missing: [],
      blockers: [],
    };
  }
  return {
    status: "DA_VERIFICARE",
    score: 40,
    confirmed: [],
    missing: ["ATECO da verificare nel testo ufficiale"],
    blockers: [],
  };
}

function truncateSummary(text: unknown, maxLen = 400): string {
  const raw = normalizeText(text);
  if (!raw) return "";
  if (raw.length <= maxLen) return raw;
  // Try to break at the last whitespace before the limit.
  const slice = raw.slice(0, maxLen);
  const lastSpace = slice.search(/\s+[^\s]*$/);
  if (lastSpace > 0) return slice.slice(0, lastSpace).trimEnd();
  return slice;
}

export function mapCatalogBando(
  row: Record<string, unknown>,
  profile?: CatalogProfile | null,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    ...row,
    summary: truncateSummary(row.summary),
    modulistica_url: row.forms_url ?? null,
  };
  const match = catalogMatch(row, profile);
  if (match) mapped.match = match;
  return mapped;
}
