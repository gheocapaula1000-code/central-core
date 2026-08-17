// Pure Padova street-number parsers. No I/O — used by padova-civici-ingest
// and unit tests. Official source: Open Data Veneto / Comune di Padova.

export interface Civico {
  street_name: string;
  civic_number: string;
  civic_suffix: string | null;
  cap: string | null;
  lat: number | null;
  lng: number | null;
  raw: Record<string, unknown>;
}

export function normalizeStreet(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanIntLike(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  if (!s) return "";
  const m = s.match(/^(-?\d+)\.0+$/);
  return m ? m[1] : s;
}

export function cleanFloat(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

export function civicFingerprint(streetNormalized: string, civic: string, suffix: string | null): string {
  return `padova|${streetNormalized}|${civic}|${suffix ?? ""}`;
}

export function parseVenetoFlat(records: unknown[]): Civico[] {
  const out: Civico[] = [];
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const street = String(r["Nome Via"] ?? r.NOME_VIA ?? "").trim();
    const civic = cleanIntLike(r["Civico"] ?? r.CIVICO);
    if (!street || !civic) continue;
    const esp = cleanIntLike(r["Esponente"] ?? r.ESPONENTE);
    const suffix = esp && esp !== "-" ? esp : null;
    const lat = cleanFloat(r["Latitudine"] ?? r.LAT);
    const lng = cleanFloat(r["Longitudine"] ?? r.LNG);
    out.push({
      street_name: street,
      civic_number: civic,
      civic_suffix: suffix,
      cap: null,
      lat,
      lng,
      raw: { codice_via: cleanIntLike(r["Codice Via"]) },
    });
  }
  return out;
}

export function parseGeoJSON(geojson: unknown): Civico[] {
  const root = geojson && typeof geojson === "object" ? geojson as { features?: unknown[] } : {};
  const features = Array.isArray(root.features) ? root.features : [];
  const out: Civico[] = [];
  for (const f of features) {
    if (!f || typeof f !== "object") continue;
    const feat = f as {
      properties?: Record<string, unknown>;
      geometry?: { type?: string; coordinates?: unknown[] };
    };
    const p = feat.properties ?? {};
    const street = String(p.VIA ?? p.NOMEVIA ?? p["Nome Via"] ?? "").trim();
    const civic = cleanIntLike(p.CIVICO ?? p.NUMERO ?? p["Civico"]);
    if (!street || !civic) continue;
    let lat: number | null = null;
    let lng: number | null = null;
    if (feat.geometry?.type === "Point" && Array.isArray(feat.geometry.coordinates)) {
      lng = cleanFloat(feat.geometry.coordinates[0]);
      lat = cleanFloat(feat.geometry.coordinates[1]);
    }
    const esp = cleanIntLike(p.ESPONENTE ?? p["Esponente"]);
    out.push({
      street_name: street,
      civic_number: civic,
      civic_suffix: esp || null,
      cap: p.CAP ? String(p.CAP).trim() : null,
      lat,
      lng,
      raw: p,
    });
  }
  return out;
}

export function parseOfficialCiviciPayload(data: unknown, format: string): { records: Civico[]; raw_count: number } {
  if (format === "veneto_flat_json" && Array.isArray(data)) {
    return { records: parseVenetoFlat(data), raw_count: data.length };
  }
  if (data && typeof data === "object" && Array.isArray((data as { features?: unknown[] }).features)) {
    const features = (data as { features: unknown[] }).features;
    return { records: parseGeoJSON(data), raw_count: features.length };
  }
  if (Array.isArray(data)) {
    return { records: parseVenetoFlat(data), raw_count: data.length };
  }
  throw new Error("unknown_payload_shape");
}
