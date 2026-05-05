// ═══════════════════════════════════════════════════════════════
// Geoportale Veneto — spatial join layer→comune (no inventions)
//
// Strategy (in order):
//   1. Direct properties (comune+provincia explicit)
//   2. ISTAT code lookup → comune name + provincia via VENETO_COMUNI
//   3. Cleaned nome comune → VENETO_COMUNI lookup
//   4. (deferred) point-in-polygon → marked unassigned
// Never invent a comune/provincia; if all fail, return null.
// ═══════════════════════════════════════════════════════════════

import { VENETO_COMUNI } from "./venetoComuni.ts";

const VENETO_PROV = new Set(["PD", "VE", "BL", "VI", "VR", "TV", "RO"]);

/** Normalize comune name to match VENETO_COMUNI keys (Title Case, trimmed). */
export function normalizeComune(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  // Title case each word, including small connectors
  const tc = cleaned.toLowerCase().replace(/(^|\s|')([a-zà-ÿ])/g, (_, p, c) => p + c.toUpperCase());
  // Try exact, then case-insensitive
  if (VENETO_COMUNI[tc]) return tc;
  const lc = tc.toLowerCase();
  for (const k of Object.keys(VENETO_COMUNI)) {
    if (k.toLowerCase() === lc) return k;
  }
  return null;
}

export function normalizeProvince(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const p = raw.trim().toUpperCase();
  if (VENETO_PROV.has(p)) return p;
  return null;
}

/** ISTAT cache loaded once per dry run / import call. */
export type IstatCache = Map<string, string>; // codice_istat (6-digit padded) → comune name

export function buildIstatLookup(rows: Array<{ codice_istat: string; comune: string }>): IstatCache {
  const m: IstatCache = new Map();
  for (const r of rows) {
    if (!r.codice_istat || !r.comune) continue;
    const padded = r.codice_istat.padStart(6, "0");
    m.set(padded, r.comune);
    // Also index 5-digit version (no leading 0) — WFS uses '23001' instead of '023001'
    m.set(padded.replace(/^0+/, ""), r.comune);
    m.set(r.codice_istat, r.comune);
  }
  return m;
}

export function inferFromCodIstat(properties: Record<string, unknown>, istat: IstatCache): { comune: string; provincia: string } | null {
  const candidates = ["cod_istat", "codice_istat", "istat", "a_codice", "ISTAT", "codistat", "cod_istat_comune"];
  for (const k of Object.keys(properties)) {
    if (!candidates.includes(k.toLowerCase())) continue;
    const v = properties[k];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (!s) continue;
    const padded = s.padStart(6, "0");
    const comune = istat.get(padded) ?? istat.get(s);
    if (comune) {
      const prov = VENETO_COMUNI[comune];
      if (prov) return { comune, provincia: prov };
    }
  }
  return null;
}

export function inferFromNomeComune(properties: Record<string, unknown>): { comune: string; provincia: string } | null {
  const candidates = ["comune", "denom_com", "denominazione_comune", "b_nome", "nome", "nome_comune", "comune_nome"];
  for (const k of Object.keys(properties)) {
    if (!candidates.includes(k.toLowerCase())) continue;
    const c = normalizeComune(properties[k]);
    if (c) {
      const prov = VENETO_COMUNI[c];
      if (prov) return { comune: c, provincia: prov };
    }
  }
  return null;
}

export function inferComuneProvinciaFromProperties(
  properties: Record<string, unknown>,
  istat: IstatCache,
): { comune: string; provincia: string; method: "direct" | "istat" | "nome" } | null {
  // 1. Direct
  const directProv = normalizeProvince(properties.provincia ?? properties.PROVINCIA ?? properties.prov ?? properties.sigla_prov);
  const directComune = normalizeComune(properties.comune ?? properties.COMUNE ?? properties.denom_com ?? properties.b_nome);
  if (directComune && directProv && VENETO_COMUNI[directComune] === directProv) {
    return { comune: directComune, provincia: directProv, method: "direct" };
  }
  // 2. ISTAT
  const fromIstat = inferFromCodIstat(properties, istat);
  if (fromIstat) return { ...fromIstat, method: "istat" };
  // 3. Nome
  const fromNome = inferFromNomeComune(properties);
  if (fromNome) return { ...fromNome, method: "nome" };
  // 4. Direct comune only (no province in props but VENETO_COMUNI gives it)
  if (directComune && VENETO_COMUNI[directComune]) {
    return { comune: directComune, provincia: VENETO_COMUNI[directComune], method: "direct" };
  }
  return null;
}

/** Compute centroid of a GeoJSON geometry (Polygon/MultiPolygon). Pure JS. */
export function geometryCentroid(geom: { type: string; coordinates: any } | null | undefined): { lng: number; lat: number } | null {
  if (!geom || !geom.coordinates) return null;
  const acc = { x: 0, y: 0, n: 0 };
  const visit = (coords: any) => {
    if (typeof coords[0] === "number") {
      acc.x += coords[0]; acc.y += coords[1]; acc.n++;
    } else for (const c of coords) visit(c);
  };
  try { visit(geom.coordinates); } catch { return null; }
  if (!acc.n) return null;
  return { lng: acc.x / acc.n, lat: acc.y / acc.n };
}

/** Sanitize a properties dict to keep payload small and safe. */
export function sanitizeProperties(props: Record<string, unknown>, maxKeys = 20): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(props)) {
    if (n >= maxKeys) break;
    if (v === null || v === undefined) continue;
    const s = typeof v === "string" ? v.slice(0, 200) : v;
    out[k] = s;
    n++;
  }
  return out;
}
