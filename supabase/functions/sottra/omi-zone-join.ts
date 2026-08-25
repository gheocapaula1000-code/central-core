// Pure helpers: join Core omi_zone_geometry (synthetic keys like G224-B1)
// to official omi_zone / omi_valori (Agenzia delle Entrate link_zona like PD00000015).
// Fail-closed: never invent a zona when the join is not unique.

export type OfficialZoneRow = {
  zona: string;
  zona_descr: string | null;
  link_zona: string;
  comune_descrizione: string;
  comune_amm?: string | null;
};

export type PolygonZoneRef = {
  zona: string;
  link_zona: string;
  comune_descrizione?: string;
};

export type OfficialOmiQuote = {
  tipologia: string;
  stato: string | null;
  comprMin: number | null;
  comprMax: number | null;
  locMin: number | null;
  locMax: number | null;
  semestre: string | null;
};

/**
 * Map a polygon-match row onto exactly one official omi_zone row.
 * Returns null when the match is missing or not unique.
 */
export function remapPolygonToOfficialZone(
  polygon: PolygonZoneRef,
  officialZones: OfficialZoneRow[],
): OfficialZoneRow | null {
  if (!polygon.zona && !polygon.link_zona) return null;
  if (!officialZones.length) return null;

  const byLink = officialZones.filter((z) => z.link_zona === polygon.link_zona);
  if (byLink.length === 1) return byLink[0];
  if (byLink.length > 1) return null;

  const zona = (polygon.zona || "").trim().toUpperCase();
  if (zona) {
    const byZona = officialZones.filter((z) => (z.zona || "").trim().toUpperCase() === zona);
    if (byZona.length === 1) return byZona[0];
    if (byZona.length > 1) return null;
  }

  const synthetic = polygon.link_zona.match(/^([A-Z0-9]+)-([A-Z0-9]+)$/i);
  if (synthetic) {
    const amm = synthetic[1].toUpperCase();
    const suffixZona = synthetic[2].toUpperCase();
    const byAmm = officialZones.filter(
      (z) => (z.comune_amm || "").toUpperCase() === amm
        && (z.zona || "").trim().toUpperCase() === suffixZona,
    );
    if (byAmm.length === 1) return byAmm[0];
    if (byAmm.length > 1) return null;
  }

  return null;
}

/** Prefer the official "valori normali" row when several conservation states exist. */
export function pickOfficialValoriRow(
  rows: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (!rows.length) return null;
  const stato = (r: Record<string, unknown>) => String(r.stato ?? "").trim().toUpperCase();
  const normale = rows.filter((r) => stato(r) === "NORMALE");
  if (normale.length === 1) return normale[0];
  if (normale.length > 1) return normale[0];
  const ottimo = rows.find((r) => stato(r) === "OTTIMO");
  if (ottimo) return ottimo;
  return rows[0];
}

function asQuoteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function quoteKey(q: Pick<OfficialOmiQuote, "tipologia" | "stato">): string {
  return `${(q.tipologia ?? "").trim().toLowerCase()}|${(q.stato ?? "").trim().toLowerCase()}`;
}

function preferSemestre(rows: Array<Record<string, unknown>>): string | null {
  const semesters = [...new Set(
    rows.map((r) => typeof r.semestre === "string" ? r.semestre.trim() : "").filter(Boolean),
  )];
  if (semesters.includes("2025/1")) return "2025/1";
  if (semesters.length === 0) return null;
  return [...semesters].sort().reverse()[0] ?? null;
}

/**
 * Read every official AdE row already stored in omi_valori for one link_zona.
 * Does not invent rows or prices. Prefers semestre 2025/1 when present.
 * Missing loc_* stays null.
 */
export function mapValoriRowsToQuotes(
  rows: Array<Record<string, unknown>>,
): OfficialOmiQuote[] {
  if (!rows.length) return [];
  const semestre = preferSemestre(rows);
  const scoped = semestre
    ? rows.filter((r) => String(r.semestre ?? "").trim() === semestre)
    : rows;

  const seen = new Set<string>();
  const quotes: OfficialOmiQuote[] = [];
  for (const r of scoped) {
    const tipologia = String(r.descr_tipologia ?? r.tipologia ?? "").trim();
    const stato = typeof r.stato === "string" && r.stato.trim() ? r.stato.trim() : null;
    const comprMin = asQuoteNumber(r.compr_min);
    const comprMax = asQuoteNumber(r.compr_max);
    if (!tipologia && comprMin == null && comprMax == null) continue;
    const q: OfficialOmiQuote = {
      tipologia,
      stato,
      comprMin,
      comprMax,
      locMin: asQuoteNumber(r.loc_min),
      locMax: asQuoteNumber(r.loc_max),
      semestre: typeof r.semestre === "string" && r.semestre.trim() ? r.semestre.trim() : semestre,
    };
    const key = quoteKey(q);
    if (!key || key === "|" || seen.has(key)) continue;
    seen.add(key);
    quotes.push(q);
  }

  return quotes.sort((a, b) => {
    const aCiv = /abitazioni\s+civili/i.test(a.tipologia) ? 0 : 1;
    const bCiv = /abitazioni\s+civili/i.test(b.tipologia) ? 0 : 1;
    if (aCiv !== bCiv) return aCiv - bCiv;
    const rank = (s: string | null) => /normale/i.test(s ?? "") ? 0 : /ottimo/i.test(s ?? "") ? 1 : 2;
    const statoCmp = rank(a.stato) - rank(b.stato);
    if (statoCmp !== 0) return statoCmp;
    const tip = a.tipologia.localeCompare(b.tipologia, "it");
    if (tip !== 0) return tip;
    return (a.stato ?? "").localeCompare(b.stato ?? "", "it");
  });
}

/**
 * Headline civile band. Prefer Abitazioni civili NORMALE (Padova D8: 1400–1850).
 * Never mash NORMALE+OTTIMO into a single 1400–2750 envelope.
 */
export function pickCivileHeadlineFromQuotes(quotes: OfficialOmiQuote[]): {
  min: number | null;
  max: number | null;
  tipologia: string | null;
  stato: string | null;
} {
  const civile = quotes.filter((q) => /abitazioni\s+civili/i.test(q.tipologia));
  const normale = civile.find((q) => /normale/i.test(q.stato ?? ""));
  const row = normale ?? civile[0] ?? null;
  if (!row) return { min: null, max: null, tipologia: null, stato: null };
  return {
    min: row.comprMin,
    max: row.comprMax,
    tipologia: row.tipologia || null,
    stato: row.stato,
  };
}
