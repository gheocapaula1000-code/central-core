// ═══════════════════════════════════════════════════════════════
// Civiko One — shared utilities for hyperlocal endpoints.
//
// Centralizes:
//   - forbidden vocabulary sanitizer (FORBIDDEN_RE + sanitizeOutgoing)
//   - Padova boundary helpers
//   - signal scoring + match helpers
//   - safe Supabase client factory
//
// All user-facing strings produced by Civiko endpoints MUST be
// passed through sanitizeOutgoing(...) right before they leave the
// process. This is the only authoritative ban-list.
// ═══════════════════════════════════════════════════════════════

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Padova scope ──────────────────────────────────────────────
export const PADOVA_COMUNE_ISTAT_LONG = "5028060";
export const PADOVA_COMUNE_ISTAT_SHORT = "028060";
export const PADOVA_LABEL = "Padova";
export const PADOVA_BBOX = {
  // Generous padded bounding box for the comune of Padova.
  minLat: 45.330, maxLat: 45.470,
  minLng: 11.770, maxLng: 11.985,
};

export function isPadovaMunicipality(municipality?: string | null): boolean {
  if (!municipality) return false;
  return /\bpadova\b/i.test(String(municipality));
}

export function isPadovaText(...vals: Array<string | null | undefined>): boolean {
  return vals.some((v) => v && /\bpadova\b/i.test(String(v)));
}

export function isPadovaCoord(lat?: number | null, lng?: number | null): boolean {
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  return lat >= PADOVA_BBOX.minLat && lat <= PADOVA_BBOX.maxLat &&
         lng >= PADOVA_BBOX.minLng && lng <= PADOVA_BBOX.maxLng;
}

// ── Forbidden vocabulary (Civiko hard rule) ───────────────────
export const FORBIDDEN_WORDS = [
  "ai", "ia",
  "intelligenza", "intelligence",
  "machine learning",
  "smart",
  "intelligent", "intelligente",
  "stima", "perizia",
  "valutazione ufficiale", "valutazioni ufficiali",
  "prezzo giusto", "prezzo corretto",
  "valore reale",
  "garantito", "garantita",
];

export const FORBIDDEN_RE = new RegExp(
  "(?<![\\p{L}\\p{N}])(" +
    FORBIDDEN_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
    ")(?![\\p{L}\\p{N}])",
  "giu",
);

export function sanitizeCopy(value: string): string {
  if (!value) return value;
  return value.replace(FORBIDDEN_RE, "").replace(/\s{2,}/g, " ").trim();
}

export function sanitizeOutgoing<T>(value: T): T {
  if (value == null) return value;
  if (typeof value === "string") return sanitizeCopy(value) as unknown as T;
  if (Array.isArray(value)) return value.map(sanitizeOutgoing) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeOutgoing(v);
    }
    return out as unknown as T;
  }
  return value;
}

// ── Supabase client (service role) ────────────────────────────
export function getServiceSupabase(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key);
}

// ── Geo helpers ───────────────────────────────────────────────
export function haversineMeters(
  aLat: number, aLng: number, bLat: number, bLng: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ── Signal types (shape used across endpoints) ────────────────
export interface LocalSignalRow {
  id: number;
  source_id: number | null;
  title: string;
  summary: string | null;
  category: string | null;
  location_text: string | null;
  lat: number | null;
  lng: number | null;
  radius_meters: number | null;
  municipality: string | null;
  neighborhood: string | null;
  published_at: string | null;
  detected_at: string;
  confidence: "high" | "medium" | "low";
  signal_tone: "positive" | "negative" | "mixed" | "neutral";
  commercial_use: string | null;
  evidence_url: string | null;
  source_level: 1 | 2 | 3 | 4;
}

export interface LocalSourceRow {
  id: number;
  name: string;
  type: string;
  level: 1 | 2 | 3 | 4;
  source_owner: string | null;
  url: string | null;
  reliability_score: number | null;
  last_checked_at: string | null;
}

export interface CivikoFact {
  title: string;
  summary: string;
  source: string;
  publishedAt: string | null;
  detectedAt: string;
  confidence: "high" | "medium" | "low";
  evidenceUrl?: string | null;
  category?: string | null;
}

export interface CivikoCommercialUse {
  label: string;
  suggestedUse: string;
  useInReport: boolean;
}

export interface CivikoSignal {
  id: number;
  sourceLevel: 1 | 2 | 3 | 4;
  fact: CivikoFact;
  commercialUse: CivikoCommercialUse;
  distanceMeters?: number | null;
  matchReason?: string;
}

const COMMERCIAL_USE_LABELS: Record<string, string> = {
  owner_argument: "Leva narrativa",
  buyer_argument: "Leva narrativa",
  risk_warning: "Risposta preventiva",
  follow_up: "Follow-up",
  narrative_leverage: "Leva narrativa",
  objection_preparation: "Risposta preventiva",
};

export function defaultSuggestedUse(commercialUse: string | null): string {
  switch (commercialUse) {
    case "risk_warning":
    case "objection_preparation":
      return "Preparare una risposta preventiva da portare al Primo Appuntamento.";
    case "follow_up":
      return "Da inserire nel follow-up con il Proprietario.";
    case "owner_argument":
    case "narrative_leverage":
    case "buyer_argument":
      return "Usare come leva narrativa nella Presentazione Proprietario.";
    default:
      return "Portare questo punto nella Presentazione Proprietario.";
  }
}

export function commercialLabelFor(commercialUse: string | null): string {
  return COMMERCIAL_USE_LABELS[commercialUse ?? ""] ?? "Punto da verificare";
}

export function mapSourceOwner(level: 1 | 2 | 3 | 4, raw: string | null | undefined, fallback: string): string {
  if (raw && raw.trim()) return raw;
  if (level === 1) return fallback || "Fonte ufficiale";
  if (level === 2) return fallback || "Fonte pubblica";
  if (level === 3) return "Local Buzz Signal";
  return "Dati Interni Agenzia";
}

export function rowToSignal(row: LocalSignalRow, sourceOwner: string, distanceMeters?: number | null, matchReason?: string): CivikoSignal {
  return {
    id: row.id,
    sourceLevel: row.source_level,
    fact: {
      title: row.title,
      summary: row.summary ?? "",
      source: mapSourceOwner(row.source_level, sourceOwner, sourceOwner),
      publishedAt: row.published_at,
      detectedAt: row.detected_at,
      confidence: row.confidence,
      evidenceUrl: row.source_level === 3 ? null : row.evidence_url, // never expose raw L3 urls
      category: row.category,
    },
    commercialUse: {
      label: commercialLabelFor(row.commercial_use),
      suggestedUse: defaultSuggestedUse(row.commercial_use),
      useInReport: row.source_level === 3 ? false : true,
    },
    distanceMeters: distanceMeters ?? null,
    matchReason,
  };
}

// ── Loaders ───────────────────────────────────────────────────
export async function loadActiveSignals(
  sb: SupabaseClient,
  municipality: string,
): Promise<{ signals: LocalSignalRow[]; sources: Map<number, LocalSourceRow> }> {
  const { data: sigData } = await sb
    .from("local_signals")
    .select("id,source_id,title,summary,category,location_text,lat,lng,radius_meters,municipality,neighborhood,published_at,detected_at,confidence,signal_tone,commercial_use,evidence_url,source_level")
    .eq("is_active", true)
    .ilike("municipality", `%${municipality}%`)
    .limit(200);

  const signals = (sigData ?? []) as unknown as LocalSignalRow[];
  const sourceIds = Array.from(new Set(signals.map((s) => s.source_id).filter((x): x is number => !!x)));
  const sources = new Map<number, LocalSourceRow>();
  if (sourceIds.length > 0) {
    const { data: srcData } = await sb
      .from("local_sources")
      .select("id,name,type,level,source_owner,url,reliability_score,last_checked_at")
      .in("id", sourceIds);
    for (const r of (srcData ?? []) as unknown as LocalSourceRow[]) {
      sources.set(r.id, r);
    }
  }
  return { signals, sources };
}

// ── Source coverage summary ───────────────────────────────────
export interface SourceCoverageEntry {
  level: 1 | 2 | 3 | 4;
  label: string;
  count: number;
  status: "ok" | "partial" | "non_disponibile";
}

export function summarizeCoverage(signals: LocalSignalRow[]): SourceCoverageEntry[] {
  const levels: Array<{ lvl: 1 | 2 | 3 | 4; label: string }> = [
    { lvl: 1, label: "Fonti Dure" },
    { lvl: 2, label: "Segnali di Zona" },
    { lvl: 3, label: "Local Buzz Signal" },
    { lvl: 4, label: "Dati Interni Agenzia" },
  ];
  return levels.map(({ lvl, label }) => {
    const count = signals.filter((s) => s.source_level === lvl).length;
    return {
      level: lvl,
      label,
      count,
      status: count > 0 ? "ok" : (lvl === 4 ? "non_disponibile" : "partial"),
    };
  });
}
