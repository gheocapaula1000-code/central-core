// Civiko Padova Scope Guard — perimetro territoriale fail-closed.
//
// Perimetro Civiko = Comune di Padova SOLO + gli 8 slug ufficiali letterali.
// Regola non negoziabile: il comune autoritativo di una riga raw/provider deve
// essere presente, non ambiguo e normalizzato ESATTAMENTE 'padova' PRIMA di
// qualsiasi mapping/upsert/output. Mai stampare citta='Padova' e validare dopo.
//
// Modulo isolato: nessun accesso DB, nessuna dipendenza runtime oltre il
// contratto delle 8 zone.

import {
  CIVIKO_COMMERCIAL_ZONE_SLUGS,
  isCivikoCommercialZoneSlug,
  type CivikoCommercialZoneSlug,
} from "./civikoCommercialZoneContract.ts";

export const CIVIKO_COMUNE_CANONICAL = "padova" as const;

export const CIVIKO_EXACT8_SLUGS: readonly string[] = Array.from(
  CIVIKO_COMMERCIAL_ZONE_SLUGS,
) as readonly string[];

const PROVINCE_SUFFIX_RE = /[\s,]*[(\[]?\s*(pd|padova|italia|italy|veneto)\s*[)\]]?$/;

/** Normalizza un valore comune: minuscolo, senza accenti/punteggiatura/suffissi provincia. */
export function normalizeComune(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .toLowerCase()
    .trim();
  if (!s) return "";
  s = s.replace(/^comune\s+di\s+/, "");
  s = s.replace(/^(citta'?|city)\s+(di|of)\s+/, "");
  // rimuove suffissi provincia/paese ripetuti: "padova (pd), italia"
  for (let i = 0; i < 3; i++) {
    const next = s.replace(PROVINCE_SUFFIX_RE, "").trim();
    if (next === s || next === "") break;
    s = next;
  }
  s = s.replace(/[.;:]+$/g, "").replace(/\s+/g, " ").trim();
  return s;
}

export type ComuneRejectCode =
  | "COMUNE_MISSING"
  | "COMUNE_AMBIGUOUS"
  | "COMUNE_OUT_OF_SCOPE";

export type ComuneScopeVerdict =
  | { ok: true; comune: typeof CIVIKO_COMUNE_CANONICAL }
  | { ok: false; code: ComuneRejectCode; observed: string[] };

/**
 * Valuta i candidati comune autoritativi di una riga raw.
 * Fail-closed: assente → MISSING, più valori distinti → AMBIGUOUS,
 * valore != esattamente 'padova' → OUT_OF_SCOPE.
 */
export function evaluateComuneScope(candidates: readonly unknown[]): ComuneScopeVerdict {
  const seen: string[] = [];
  for (const c of candidates) {
    const n = normalizeComune(c);
    if (n && !seen.includes(n)) seen.push(n);
  }
  if (seen.length === 0) return { ok: false, code: "COMUNE_MISSING", observed: [] };
  if (seen.length > 1) return { ok: false, code: "COMUNE_AMBIGUOUS", observed: seen };
  if (seen[0] !== CIVIKO_COMUNE_CANONICAL) {
    return { ok: false, code: "COMUNE_OUT_OF_SCOPE", observed: seen };
  }
  return { ok: true, comune: CIVIKO_COMUNE_CANONICAL };
}

export function isComunePadova(value: unknown): boolean {
  return normalizeComune(value) === CIVIKO_COMUNE_CANONICAL;
}

export type CivikoPortal = "subito" | "casa" | "idealista" | "immobiliare";

/**
 * Estrae i candidati comune autoritativi dallo shape raw del provider.
 * NON inventa valori: se il portale non espone il comune il verdetto sarà MISSING.
 */
export function rawComuneCandidates(portal: CivikoPortal, raw: any): unknown[] {
  if (!raw || typeof raw !== "object") return [];
  switch (portal) {
    case "subito": {
      const loc = raw.location ?? {};
      return [loc.city, raw.city];
    }
    case "casa":
      return [raw.city, raw.town, raw.municipality];
    case "idealista": {
      const ub = raw.ubication ?? {};
      const addr = raw?.contactInfo?.address ?? {};
      return [
        ub.municipality,
        ub.administrativeAreaLevel3,
        addr.town,
        raw.municipality,
        raw.city,
      ];
    }
    case "immobiliare": {
      const g = raw.geography ?? {};
      const e = raw._enhanced ?? {};
      const props = Array.isArray(raw.properties) ? raw.properties : [];
      const loc = props.find((p: any) => p?.isMain)?.location ?? props[0]?.location ?? {};
      return [g.city, g.town, e.city, loc.city];
    }
    default:
      return [];
  }
}

/** Verdetto comune direttamente dallo shape raw del portale. */
export function evaluateRawComuneScope(portal: CivikoPortal, raw: any): ComuneScopeVerdict {
  return evaluateComuneScope(rawComuneCandidates(portal, raw));
}

// ---------------------------------------------------------------------------
// Zona: nessuna riga Padova è esponibile senza slug esatto tra gli 8 ufficiali.
// ---------------------------------------------------------------------------

export type ZoneExposureVerdict =
  | { exposable: true; slug: CivikoCommercialZoneSlug }
  | { exposable: false; code: "ZONE_NULL" | "ZONE_NOT_EXACT8"; observed: string | null };

export function evaluateZoneExposure(storedSlug: unknown): ZoneExposureVerdict {
  if (storedSlug === null || storedSlug === undefined || String(storedSlug).trim() === "") {
    return { exposable: false, code: "ZONE_NULL", observed: null };
  }
  const s = String(storedSlug);
  if (!isCivikoCommercialZoneSlug(s)) {
    return { exposable: false, code: "ZONE_NOT_EXACT8", observed: s };
  }
  return { exposable: true, slug: s };
}

// ---------------------------------------------------------------------------
// Contatori bounded di run corrente (audit/result).
// ---------------------------------------------------------------------------

export interface CivikoScopeCounters {
  scanned: number;
  padova_kept: number;
  out_of_scope_rejected: number;
  null_or_invalid_zone_rejected: number;
  other_rejected: number;
  writes: number;
  out_of_scope_written: number;
}

const MAX_COUNTER = 1_000_000;

function bounded(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(MAX_COUNTER, Math.trunc(n));
}

export function createScopeCounters(): CivikoScopeCounters {
  return {
    scanned: 0,
    padova_kept: 0,
    out_of_scope_rejected: 0,
    null_or_invalid_zone_rejected: 0,
    other_rejected: 0,
    writes: 0,
    out_of_scope_written: 0,
  };
}

export function bumpCounter(
  c: CivikoScopeCounters,
  key: keyof CivikoScopeCounters,
  by = 1,
): void {
  c[key] = bounded(c[key] + by);
}

export function normalizeCounters(c: CivikoScopeCounters): CivikoScopeCounters {
  const out = createScopeCounters();
  for (const k of Object.keys(out) as (keyof CivikoScopeCounters)[]) out[k] = bounded(c[k]);
  return out;
}

export interface CountersReconciliation {
  ok: boolean;
  scanned: number;
  accounted: number;
}

/** Invariante: scanned === kept + tutti i rifiuti. */
export function reconcileScopeCounters(c: CivikoScopeCounters): CountersReconciliation {
  const n = normalizeCounters(c);
  const accounted = n.padova_kept + n.out_of_scope_rejected +
    n.null_or_invalid_zone_rejected + n.other_rejected;
  return { ok: n.scanned === accounted, scanned: n.scanned, accounted };
}

// ---------------------------------------------------------------------------
// Release gate del perimetro (run corrente correlata).
// ---------------------------------------------------------------------------

export interface CivikoScopeGateInput {
  run_id: string;
  counters: CivikoScopeCounters;
  /** Righe effettivamente visibili/importate/categorizzate nella run corrente. */
  visible_rows: readonly { comune: unknown; commercial_zone_slug: unknown }[];
  /** Righe storiche non-Padova ancora presenti a DB ma escluse da ogni query Civiko. */
  historic_non_padova_rows: number;
  historic_non_padova_visible: number;
  /** Righe Padova con zona NULL ancora esposte (devono essere 0). */
  padova_null_zone_visible: number;
}

export interface CivikoScopeGateResult {
  ok: boolean;
  run_id: string;
  failures: string[];
  checks: Record<string, boolean>;
  metrics: {
    counters: CivikoScopeCounters;
    visible_rows: number;
    historic_non_padova_rows: number;
  };
}

export function evaluateCivikoScopeGate(input: CivikoScopeGateInput): CivikoScopeGateResult {
  const counters = normalizeCounters(input.counters);
  const rec = reconcileScopeCounters(counters);
  const visible = input.visible_rows ?? [];
  const allVisiblePadova = visible.every((r) => isComunePadova(r.comune));
  const allVisibleExact8 = visible.every((r) => evaluateZoneExposure(r.commercial_zone_slug).exposable);

  const checks: Record<string, boolean> = {
    run_correlated: typeof input.run_id === "string" && input.run_id.length > 0,
    counters_reconciled: rec.ok,
    no_out_of_scope_write: counters.out_of_scope_written === 0,
    visible_rows_comune_padova: allVisiblePadova,
    visible_rows_exact8_zone: allVisibleExact8,
    historic_non_padova_excluded: bounded(input.historic_non_padova_visible) === 0,
    padova_null_zone_excluded: bounded(input.padova_null_zone_visible) === 0,
  };
  const failures = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  return {
    ok: failures.length === 0,
    run_id: input.run_id,
    failures,
    checks,
    metrics: {
      counters,
      visible_rows: visible.length,
      historic_non_padova_rows: bounded(input.historic_non_padova_rows),
    },
  };
}
