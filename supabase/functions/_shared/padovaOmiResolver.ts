// _shared/padovaOmiResolver.ts
// Single source of truth for resolving a record → Padova OMI zone code.
//
// Rules:
//  - Returns one of the 22 official Padova OMI codes (B1..R3) or null.
//  - Never invents codes. Never collapses different OMI codes.
//  - Resolution order: explicit pre-computed code → point-in-polygon → alias match.

import { PADOVA_OMI_ZONES, isValidPadovaOmiZone } from "./comuneRegistry.ts";

export type PadovaOmiResolution = {
  omi_zone_code: string | null;
  omi_zone_label: string | null;
  omi_zone_confidence: number;
  omi_zone_reason: string;
};

/** Salvage code: il record NON ha né PIP né alias forte ma ha un hint (fascia/CAP/quartiere).
 *  Non lo scartiamo silenziosamente — la PWA lo mostra in coda con badge "da verificare". */
export const UNRESOLVED_OMI_CODE = "UNRESOLVED_ZONE";
export const UNRESOLVED_OMI_LABEL = "Zona da verificare";

// CAP → fascia OMI ufficiale Padova (best-effort, non sostituisce il PIP).
// I CAP 351xx coprono il Comune di Padova; sono mappati alla zona OMI prevalente.
const CAP_TO_OMI_HINT: Record<string, string> = {
  "35121": "B1", // Centro storico
  "35122": "B2", // Carmine/Savonarola/Santo
  "35123": "B2",
  "35124": "C5", // Madonna Pellegrina/S.Rita
  "35125": "D2", // Sud/Voltabarozzo
  "35126": "C6", // Palestro/Sacra Famiglia
  "35127": "E1", // Stanga/San Lazzaro
  "35128": "C3", // Arcella/Borgomagno
  "35129": "C2", // Stazione/Scrovegni
  "35131": "C2",
  "35132": "C3",
  "35133": "C3",
  "35134": "D3", // Mortise/Torre
  "35135": "D1", // Chiesanuova/Brusegana
  "35136": "D1",
  "35137": "B1",
  "35138": "C1", // Portello
  "35139": "B1",
  "35141": "D2",
  "35142": "D2",
  "35143": "D1",
};

const CODE_TO_LABEL = new Map(PADOVA_OMI_ZONES.map((z) => [z.code, z.descrizione]));

function labelFor(code: string | null): string | null {
  return code ? CODE_TO_LABEL.get(code) ?? null : null;
}

function pickValidCode(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const c = code.trim().toUpperCase();
  return isValidPadovaOmiZone(c) ? c : null;
}

function readNested(record: Record<string, unknown>, key: string): unknown {
  const v = (record as any)[key];
  return v;
}

function extractAliasText(record: Record<string, unknown>): string {
  const parts: string[] = [];
  const keys = [
    "address", "raw_address", "title", "raw_title", "description",
    "neighborhood", "quartiere", "zona", "zone", "zona_descr",
    "via", "indirizzo",
  ];
  for (const k of keys) {
    const v = readNested(record, k);
    if (typeof v === "string" && v.trim()) parts.push(v);
  }
  const payload = readNested(record, "payload");
  if (payload && typeof payload === "object") {
    for (const k of keys) {
      const v = (payload as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) parts.push(v);
    }
  }
  return parts.join(" | ");
}

function resolveByAlias(text: string): { code: string | null; reason: string } {
  if (!text) return { code: null, reason: "no_alias_match" };
  const lower = " " + text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ") + " ";
  const hits = new Set<string>();
  for (const z of PADOVA_OMI_ZONES) {
    for (const a of z.alias) {
      const needle = a.toLowerCase().trim();
      if (needle.length < 4) continue;
      if (lower.includes(" " + needle + " ")) { hits.add(z.code); break; }
    }
  }
  if (hits.size === 1) return { code: [...hits][0], reason: "alias_match" };
  if (hits.size > 1) return { code: null, reason: "low_confidence" };
  return { code: null, reason: "no_alias_match" };
}

/** Estrae il CAP da un record (campi diretti o testo libero). */
function extractCap(record: Record<string, unknown>): string | null {
  const direct = [readNested(record, "cap"), readNested(record, "zip"), readNested(record, "postal_code")];
  for (const v of direct) {
    if (typeof v === "string" || typeof v === "number") {
      const s = String(v).replace(/\D/g, "");
      if (s.length === 5 && s.startsWith("351")) return s;
    }
  }
  const text = extractAliasText(record);
  const m = text.match(/\b(351\d{2})\b/);
  return m ? m[1] : null;
}

/** Restituisce un hint di fascia OMI (B/C/D/E/R) se troviamo qualcosa di non valido ma riconducibile. */
function fasciaHint(record: Record<string, unknown>): string | null {
  const raw = [readNested(record, "omi_zone_code"), readNested(record, "microzona"), readNested(record, "codice_omi"), readNested(record, "zona")]
    .filter((v) => typeof v === "string")
    .map((v) => String(v).trim().toUpperCase());
  for (const v of raw) {
    if (/^[BCDER]$/.test(v)) return v;
    if (/^[BCDER][0-9A-Z]*$/.test(v)) return v[0];
  }
  return null;
}

/**
 * Salvage finale: se non riusciamo a determinare un codice ufficiale ma il record
 * ha CAP padovano o un hint di fascia, ritorniamo UNRESOLVED_ZONE invece di null
 * così la PWA può mostrarlo (con badge "da verificare") anziché scartarlo a monte.
 */
function salvageResolution(record: Record<string, unknown>, baseReason: string): PadovaOmiResolution {
  const cap = extractCap(record);
  if (cap && CAP_TO_OMI_HINT[cap]) {
    const code = CAP_TO_OMI_HINT[cap];
    return {
      omi_zone_code: code,
      omi_zone_label: labelFor(code),
      omi_zone_confidence: 0.4,
      omi_zone_reason: `cap_hint_${cap}`,
    };
  }
  const fh = fasciaHint(record);
  if (cap || fh) {
    return {
      omi_zone_code: UNRESOLVED_OMI_CODE,
      omi_zone_label: UNRESOLVED_OMI_LABEL,
      omi_zone_confidence: 0.15,
      omi_zone_reason: `salvage_${fh ? "fascia_" + fh : "cap_only"}`,
    };
  }
  return { omi_zone_code: null, omi_zone_label: null, omi_zone_confidence: 0, omi_zone_reason: baseReason };
}

/** Sync resolver: uses only pre-computed codes + alias text. No DB. */
export function resolvePadovaOmiSync(record: Record<string, unknown>): PadovaOmiResolution {
  const codeCandidates: unknown[] = [
    readNested(record, "omi_zone_code"),
    readNested(record, "microzona"),
    readNested(record, "codice_omi"),
    readNested(record, "zona"),
  ];
  const omi = readNested(record, "omi");
  if (omi && typeof omi === "object") {
    codeCandidates.push((omi as any).microzona, (omi as any).code, (omi as any).zona);
  }
  for (const c of codeCandidates) {
    const code = pickValidCode(c);
    if (code) {
      return { omi_zone_code: code, omi_zone_label: labelFor(code), omi_zone_confidence: 0.95, omi_zone_reason: "precomputed_omi" };
    }
  }
  const aliasRes = resolveByAlias(extractAliasText(record));
  if (aliasRes.code) {
    return { omi_zone_code: aliasRes.code, omi_zone_label: labelFor(aliasRes.code), omi_zone_confidence: 0.7, omi_zone_reason: aliasRes.reason };
  }
  return salvageResolution(record, aliasRes.reason);
}

type LatLng = { lat: number | null; lng: number | null };

function defaultLatLng(r: Record<string, unknown>): LatLng {
  const lat = Number((r as any).lat ?? (r as any).lat_rounded ?? (r as any).latitude ?? NaN);
  const lng = Number((r as any).lng ?? (r as any).lng_rounded ?? (r as any).lon ?? (r as any).longitude ?? NaN);
  return {
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
}

/**
 * Batch resolver. Tries:
 *  1) sync (precomputed code)
 *  2) point-in-polygon via RPC omi_zones_by_points (Padova-only validation)
 *  3) alias text
 *  Returns one resolution per input record, in input order.
 */
export async function resolvePadovaOmiBatch(
  records: Array<Record<string, unknown>>,
  supa: { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> } | null,
  getLatLng: (r: Record<string, unknown>) => LatLng = defaultLatLng,
): Promise<PadovaOmiResolution[]> {
  const out: PadovaOmiResolution[] = new Array(records.length);
  const pipIdx: number[] = [];
  const pipLats: number[] = [];
  const pipLngs: number[] = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const sync = resolvePadovaOmiSync(r);
    if (sync.omi_zone_code) { out[i] = sync; continue; }
    const { lat, lng } = getLatLng(r);
    if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
      pipIdx.push(i); pipLats.push(lat); pipLngs.push(lng);
      out[i] = { omi_zone_code: null, omi_zone_label: null, omi_zone_confidence: 0, omi_zone_reason: "pending_pip" };
    } else {
      out[i] = { omi_zone_code: null, omi_zone_label: null, omi_zone_confidence: 0, omi_zone_reason: "missing_location" };
    }
  }

  if (pipIdx.length > 0 && supa) {
    try {
      const { data, error } = await supa.rpc("omi_zones_by_points", { p_lats: pipLats, p_lngs: pipLngs });
      if (!error && Array.isArray(data)) {
        for (const row of data as Array<{ idx: number; zona: string | null }>) {
          const localIdx = Number(row.idx) - 1; // RPC uses 1-based ordinality
          const origIdx = pipIdx[localIdx];
          if (origIdx == null) continue;
          const code = pickValidCode(row.zona);
          if (code) {
            out[origIdx] = { omi_zone_code: code, omi_zone_label: labelFor(code), omi_zone_confidence: 0.95, omi_zone_reason: "point_in_polygon" };
          } else {
            out[origIdx] = { omi_zone_code: null, omi_zone_label: null, omi_zone_confidence: 0, omi_zone_reason: row.zona ? "outside_padova_omi" : "no_pip_match" };
          }
        }
      }
    } catch { /* fall through to alias */ }
  }

  // Alias fallback for any still unresolved
  for (let i = 0; i < records.length; i++) {
    if (out[i] && out[i].omi_zone_code) continue;
    const aliasRes = resolveByAlias(extractAliasText(records[i]));
    if (aliasRes.code) {
      out[i] = { omi_zone_code: aliasRes.code, omi_zone_label: labelFor(aliasRes.code), omi_zone_confidence: 0.7, omi_zone_reason: aliasRes.reason };
    } else if (!out[i] || out[i].omi_zone_reason === "pending_pip") {
      out[i] = { omi_zone_code: null, omi_zone_label: null, omi_zone_confidence: 0, omi_zone_reason: aliasRes.reason || "missing_location" };
    }
  }
  return out;
}
