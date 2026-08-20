// ═══════════════════════════════════════════════════════════════
// padovaPortalPages — modulo PURO per la scansione multipagina
// dei portali di Padova (Fase 1B shadow mode).
//
// VINCOLI:
// - Nessun fetch, nessun DB, nessun secret.
// - URL deterministici, senza doppi parametri query.
// - Nessun dato proveniente dal body può modificare host, comune o
//   percorso base: gli URL sono costanti per portale/pagina.
// - page: intero >= 1.
// - soft: default max_pages = 2, massimo consentito = 3.
// - full: default max_pages = 30, massimo consentito = 50.
// ═══════════════════════════════════════════════════════════════

export type Portal =
  | "immobiliare.it"
  | "idealista.it"
  | "casa.it"
  | "subito.it"
  | "bakeca.it";

export type Mode = "soft" | "full";

export const ALL_PORTALS: Portal[] = [
  "immobiliare.it",
  "idealista.it",
  "casa.it",
  "subito.it",
  "bakeca.it",
];

/** Live ingest path on jpunnzgixcghuydstdlt (2026-08-20). Do not pretend stale Apify is fresh. */
export const PORTAL_LIVE_PATH = {
  "immobiliare.it": "firecrawl",
  "idealista.it": "firecrawl",
  "casa.it": "apify",
  "subito.it": "firecrawl_soft",
  "bakeca.it": "firecrawl",
} as const;

const DEFAULT_MAX: Record<Mode, number> = { soft: 2, full: 30 };
const ABSOLUTE_MAX: Record<Mode, number> = { soft: 3, full: 60 };

export function getDefaultMaxPages(mode: Mode): number {
  return DEFAULT_MAX[mode];
}

export function getAbsoluteMaxPages(mode: Mode): number {
  return ABSOLUTE_MAX[mode];
}

export function validatePageNumber(page: unknown): number | null {
  if (typeof page !== "number") return null;
  if (!Number.isFinite(page) || !Number.isInteger(page)) return null;
  if (page < 1) return null;
  // Hard-cap universale coerente con getAbsoluteMaxPages("full").
  if (page > 60) return null;
  return page;
}

/**
 * URL canonici deterministici. Costruiti da costanti: nessun input esterno
 * può alterare host, path o comune.
 */
export function buildPortalPageUrl(portal: Portal, page: number): string {
  const p = validatePageNumber(page);
  if (p === null) {
    throw new Error(`invalid_page:${String(page)}`);
  }
  switch (portal) {
    case "immobiliare.it": {
      // page1 → solo ordinamento; pageN → ordinamento + pag=N (nessun duplicato)
      if (p === 1) {
        return "https://www.immobiliare.it/vendita-case/padova/?ordinamento=dataModifica";
      }
      return `https://www.immobiliare.it/vendita-case/padova/?ordinamento=dataModifica&pag=${p}`;
    }
    case "idealista.it": {
      if (p === 1) return "https://www.idealista.it/vendita-case/padova-padova/";
      return `https://www.idealista.it/vendita-case/padova-padova/pagina-${p}.htm`;
    }
    case "casa.it": {
      if (p === 1) return "https://www.casa.it/vendita/residenziale/padova";
      return `https://www.casa.it/vendita/residenziale/padova?page=${p}`;
    }
    case "subito.it": {
      if (p === 1) return "https://www.subito.it/annunci-veneto/vendita/immobili/padova/";
      return `https://www.subito.it/annunci-veneto/vendita/immobili/padova/?o=${p}`;
    }
    case "bakeca.it": {
      const base = "https://www.bakeca.it/annunci/immobili-vendita/padova/";
      if (p === 1) return base;
      return `${base}?page=${p}`;
    }
    default: {
      // Difesa in profondità: il TS impedisce già altri valori.
      throw new Error(`invalid_portal:${String(portal)}`);
    }
  }
}

/**
 * Idempotency key deterministica per pagina.
 * Include SEMPRE il numero pagina.
 */
export function buildPageIdempotencyKey(params: {
  runDate: string;
  portal: Portal;
  mode: Mode;
  page: number;
  urlHash16: string;
}): string {
  const p = validatePageNumber(params.page);
  if (p === null) throw new Error(`invalid_page:${String(params.page)}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.runDate)) {
    throw new Error("invalid_run_date");
  }
  if (!/^[0-9a-f]{16}$/i.test(params.urlHash16)) {
    throw new Error("invalid_url_hash");
  }
  return `padova_portal:${params.runDate}:${params.portal}:${params.mode}:p${p}:${params.urlHash16}`;
}

export function buildPageGroupKey(portal: Portal): string {
  return `radar:padova:portal:${portal}`;
}
