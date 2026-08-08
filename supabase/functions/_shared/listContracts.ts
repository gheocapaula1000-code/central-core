// Contratti autorevoli di paginazione, snapshot e perimetro tenant per gli
// endpoint di lista (Civiko One / Padova). Modulo puro: nessun DB, nessuna rete.

import { isCivikoCommercialZoneSlug } from "./civikoCommercialZoneContract.ts";

/** Le 8 zone commerciali ufficiali: unica allowlist ammessa. */
export const OFFICIAL_ZONE_SLUGS = [
  "centro-storico",
  "nord-arcella",
  "est-brenta",
  "nord-est",
  "sud-est-sant-osvaldo",
  "sud-voltabarozzo-guizza",
  "sud-ovest-mandria",
  "ovest-chiesanuova-brentelle",
] as const;

export type ZoneSlugError = "SLUG_OUT_OF_CONTRACT" | "ZONE_NOT_ASSIGNED";

/**
 * Uno slug è accettato SOLO come match esatto nell'allowlist canonica:
 * niente wildcard, niente pattern LIKE, niente slug sconosciuti.
 */
export function parseZoneSlug(raw: unknown): { ok: true; slug: string } | { ok: false; code: ZoneSlugError } {
  if (typeof raw !== "string") return { ok: false, code: "SLUG_OUT_OF_CONTRACT" };
  const slug = raw.trim();
  if (!slug) return { ok: false, code: "SLUG_OUT_OF_CONTRACT" };
  // Caratteri wildcard/pattern: rifiuto esplicito prima di qualsiasi query.
  if (/[%_*?\\]/.test(slug)) return { ok: false, code: "SLUG_OUT_OF_CONTRACT" };
  if (!isCivikoCommercialZoneSlug(slug)) return { ok: false, code: "SLUG_OUT_OF_CONTRACT" };
  return { ok: true, slug };
}

export type TenantScopeResult =
  | { ok: true; slugs: string[]; full_city: boolean }
  | { ok: false; code: "NO_ZONE_ASSIGNED" | ZoneSlugError | "FULL_CITY_FORBIDDEN" };

/**
 * Perimetro dati autorevole:
 *  - il tenant vede SOLO gli slug che gli sono assegnati;
 *  - il full-city (tutte le 8 zone) è riservato ad admin/owner service-side;
 *  - lo slug del client può solo RESTRINGERE, mai ampliare.
 */
export function resolveTenantScope(opts: {
  isAdmin: boolean;
  assignedSlugs: readonly string[];
  requestedSlug?: unknown;
}): TenantScopeResult {
  const assigned = [
    ...new Set(opts.assignedSlugs.filter((s) => typeof s === "string" && isCivikoCommercialZoneSlug(s))),
  ];
  const allowed: string[] = opts.isAdmin ? [...OFFICIAL_ZONE_SLUGS] : assigned;
  if (!allowed.length) return { ok: false, code: "NO_ZONE_ASSIGNED" };

  const raw = opts.requestedSlug;
  const requested = typeof raw === "string" ? raw.trim() : "";
  if (requested) {
    const parsed = parseZoneSlug(requested);
    if (!parsed.ok) return { ok: false, code: parsed.code };
    if (!allowed.includes(parsed.slug)) return { ok: false, code: "ZONE_NOT_ASSIGNED" };
    return { ok: true, slugs: [parsed.slug], full_city: false };
  }

  if (!opts.isAdmin && allowed.length > 1) {
    // Nessun full-city implicito per un tenant.
    return { ok: false, code: "FULL_CITY_FORBIDDEN" };
  }
  return { ok: true, slugs: allowed, full_city: opts.isAdmin && allowed.length > 1 };
}

export interface PageWindow {
  limit: number;
  offset: number;
  /** true quando l'offset è oltre il totale: pagina vuota, nessun clamp. */
  beyond_eof: boolean;
  /** intervallo range() da usare solo se !beyond_eof */
  from: number;
  to: number;
}

export function boundedInt(raw: unknown, def: number, min: number, max: number): number {
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * Finestra di pagina: offset oltre il totale NON viene mai riportato a
 * total-1; restituisce pagina vuota e has_more=false.
 */
export function pageWindow(limitRaw: unknown, offsetRaw: unknown, total: number, maxLimit: number, defLimit: number): PageWindow {
  const limit = boundedInt(limitRaw, defLimit, 1, maxLimit);
  const offset = boundedInt(offsetRaw, 0, 0, Number.MAX_SAFE_INTEGER);
  const beyond = total <= 0 || offset >= total;
  return { limit, offset, beyond_eof: beyond, from: offset, to: offset + limit - 1 };
}

export function hasMore(offset: number, itemsCount: number, total: number): boolean {
  return offset + itemsCount < total;
}

/**
 * snapshot_complete non descrive la pagina: è vero solo se il server ha
 * provato un conteggio esatto e nessuna sorgente è stata troncata da un cap.
 */
export function snapshotComplete(opts: { countExact: boolean; truncated: boolean }): boolean {
  return opts.countExact === true && opts.truncated === false;
}

/** Nessun placeholder inventato: testo assente resta null. */
export function nullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length ? t : null;
}

/** Envelope coerente: gli stessi campi a livello top e dentro `data`. */
export function listEnvelope(opts: {
  items: unknown[];
  total: number;
  limit: number;
  offset: number;
  snapshot_complete: boolean;
  extra?: Record<string, unknown>;
}) {
  const core = {
    items: opts.items,
    total: opts.total,
    items_count: opts.items.length,
    limit: opts.limit,
    offset: opts.offset,
    has_more: hasMore(opts.offset, opts.items.length, opts.total),
    snapshot_complete: opts.snapshot_complete,
    ...(opts.extra ?? {}),
  };
  return { ok: true, ...core, data: { ...core } };
}
