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
