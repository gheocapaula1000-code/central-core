// _shared/listingVelocity.ts
// Pure-logic distress computation per active listing from listing_price_snapshots.
// No DB / Deno imports here — must remain vitest-importable.
//
// Output: per-listing DistressMetrics + two evidence rows on the SAME
// entity_key "op:<comune>:<listing_id>":
//   1. deal_listing  (refreshes price/url so the listing surfaces as a deal)
//   2. listing_velocity (carries distress signals + explanation_bullets)
//
// All textual output passes through sanitizeCopy (forbidden vocabulary guard).
// No personal data, no fabrication — only joins real snapshot rows.

// Local copy of the forbidden-vocabulary sanitizer. Mirrors FORBIDDEN_WORDS in
// _shared/civiko.ts; duplicated here so this module stays vitest-importable
// (civiko.ts pulls Deno/esm.sh imports that break under node).
const FORBIDDEN_WORDS = [
  "ai", "ia", "intelligenza", "intelligence", "machine learning",
  "smart", "intelligent", "intelligente",
  "stima", "perizia", "valutazione ufficiale", "valutazioni ufficiali",
  "prezzo giusto", "prezzo corretto", "valore reale",
  "garantito", "garantita",
];
const FORBIDDEN_RE = new RegExp(
  "(?<![\\p{L}\\p{N}])(" +
    FORBIDDEN_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
    ")(?![\\p{L}\\p{N}])",
  "giu",
);
function sanitizeCopy(value: string): string {
  if (!value) return value;
  return value.replace(FORBIDDEN_RE, "").replace(/\s{2,}/g, " ").trim();
}

import type { EvidenceInput } from "./evidenceLedger.ts";

export interface SnapshotRow {
  listing_id: string | null;
  identity_hash: string | null;
  source: string | null;
  url: string | null;
  price_eur: number | null;
  municipality: string | null;
  province: string | null;
  property_type: string | null;
  raw_title: string | null;
  raw_address: string | null;
  surface_sqm: number | null;
  rooms: number | null;
  captured_at: string | null;
  first_seen_at: string | null;
}

export type Confidenza = "alta" | "media" | "bassa";
export type DistressStrength = "nessuno" | "lieve" | "medio" | "forte";

export interface DistressMetrics {
  giorni_online: number;
  prezzo_corrente: number | null;
  prezzo_iniziale: number | null;
  /** Fractional, 0–1. Only set when both prezzi present and corrente ≤ iniziale. */
  ribasso_pct: number | null;
  numero_ribassi: number;
  ripubblicato: boolean;
  /** Max consecutive offline gap (days) detected in the identity history. */
  offline_gap_days: number;
  confidenza: Confidenza;
  snapshot_count: number;
  arc_days: number;
  fermo: boolean;
  molto_fermo: boolean;
  ribasso: boolean;
  ribasso_forte: boolean;
  distress_strength: DistressStrength;
  explanation_bullets: string[];
  price_gap_label: string | null;
  prezzo_iniziale_date: string | null;
  prezzo_corrente_date: string | null;
}

const MONTHS_IT = [
  "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
  "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
];

function fmtMonth(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${MONTHS_IT[d.getMonth()]} ${d.getFullYear()}`;
}

function tsOf(r: SnapshotRow): number {
  const t = r.captured_at ?? r.first_seen_at;
  if (!t) return 0;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Compute distress metrics for ONE listing.
 *
 * @param snaps         Snapshots of this listing_id (ribassi counted here, same listing_id only).
 * @param now           Reference clock.
 * @param identitySnaps Optional: all snapshots that share this listing's identity_hash
 *                     across multiple listing_ids. Used for repost detection ONLY.
 *                     If omitted, falls back to `snaps`.
 */
export function computeListingDistress(
  snaps: SnapshotRow[],
  now: Date = new Date(),
  identitySnaps?: SnapshotRow[],
): DistressMetrics | null {
  const valid = snaps.filter((s) => s.captured_at || s.first_seen_at);
  if (valid.length === 0) return null;

  const sortedByTime = [...valid].sort((a, b) => tsOf(a) - tsOf(b));

  // first_seen_at preferred; fall back to captured_at
  const firstSeenList = valid
    .map((s) => s.first_seen_at ?? s.captured_at ?? null)
    .filter((t): t is string => !!t)
    .map((t) => new Date(t).getTime())
    .filter((n) => Number.isFinite(n) && n > 0);
  const earliest = firstSeenList.length ? Math.min(...firstSeenList) : tsOf(sortedByTime[0]);
  const giorni_online = Math.max(0, Math.floor((now.getTime() - earliest) / 86_400_000));

  // ── Repost detection (identity-level, offline-gap based) ───────────────
  // Rule: ripubblicato iff there's a real offline gap ≥14 days between
  // consecutive captured_at observations of the SAME identity, OR a gap ≥7d
  // with a price change at reappearance. Ingest-churn (multiple listing_ids
  // in <14d with same price) is NOT counted.
  const identityPool = (identitySnaps && identitySnaps.length > 0) ? identitySnaps : valid;
  const identitySorted = [...identityPool]
    .filter((s) => s.captured_at || s.first_seen_at)
    .sort((a, b) => tsOf(a) - tsOf(b));
  let offline_gap_days = 0;
  let priceChangeAtGap = false;
  for (let i = 1; i < identitySorted.length; i++) {
    const gapDays = Math.floor((tsOf(identitySorted[i]) - tsOf(identitySorted[i - 1])) / 86_400_000);
    if (gapDays > offline_gap_days) offline_gap_days = gapDays;
    if (gapDays >= 7) {
      const p0 = identitySorted[i - 1].price_eur;
      const p1 = identitySorted[i].price_eur;
      if (typeof p0 === "number" && typeof p1 === "number" && p0 > 0 && p1 > 0 && p0 !== p1) {
        priceChangeAtGap = true;
      }
    }
  }
  const ripubblicato = offline_gap_days >= 14 || priceChangeAtGap;

  // Price history — SAME listing_id, SAME identity_hash, surface coherent (±15%).
  // Same casa.it listing_id can serve multiple distinct adverts (scraper conflation);
  // only snapshots that pin to the dominant identity_hash AND a stable surface_sqm
  // represent the same property and can be compared for price drops.
  const allPriced = sortedByTime.filter((s) => typeof s.price_eur === "number" && (s.price_eur as number) > 0);
  const identityCounts = new Map<string, number>();
  for (const s of allPriced) {
    const h = s.identity_hash ?? "";
    identityCounts.set(h, (identityCounts.get(h) ?? 0) + 1);
  }
  let dominantHash: string | null = null;
  let dominantCount = -1;
  for (const [h, c] of identityCounts) {
    if (c > dominantCount && h) { dominantCount = c; dominantHash = h; }
  }
  const dominantSurfaces = allPriced
    .filter((s) => s.identity_hash === dominantHash && typeof s.surface_sqm === "number" && (s.surface_sqm as number) > 0)
    .map((s) => s.surface_sqm as number);
  const refSurface = dominantSurfaces.length > 0 ? dominantSurfaces[0] : null;
  const surfaceCoherent = (s: SnapshotRow): boolean => {
    if (refSurface == null) return true;
    if (typeof s.surface_sqm !== "number" || (s.surface_sqm as number) <= 0) return true;
    const diff = Math.abs((s.surface_sqm as number) - refSurface) / refSurface;
    return diff <= 0.15;
  };
  const priced = allPriced.filter((s) =>
    (dominantHash == null || s.identity_hash === dominantHash) && surfaceCoherent(s)
  );
  let prezzo_iniziale: number | null = null;
  let prezzo_corrente: number | null = null;
  let prezzo_iniziale_date: string | null = null;
  let prezzo_corrente_date: string | null = null;
  let ribasso_pct: number | null = null;
  let numero_ribassi = 0;
  /** Raw drop ≥25% — declassed to "verify" with prudent copy. */
  let ribasso_implausibile = false;
  if (priced.length > 0) {
    prezzo_iniziale = priced[0].price_eur as number;
    prezzo_iniziale_date = priced[0].captured_at ?? priced[0].first_seen_at ?? null;
    prezzo_corrente = priced[priced.length - 1].price_eur as number;
    prezzo_corrente_date = priced[priced.length - 1].captured_at ?? priced[priced.length - 1].first_seen_at ?? null;
    for (let i = 1; i < priced.length; i++) {
      if ((priced[i].price_eur as number) < (priced[i - 1].price_eur as number)) numero_ribassi++;
    }
    if (prezzo_iniziale > 0 && (prezzo_corrente as number) <= prezzo_iniziale) {
      const rawPct = (prezzo_iniziale - (prezzo_corrente as number)) / prezzo_iniziale;
      // Require ≥2 distinct prices on a ≥7-day span.
      const distinctPrices = new Set(priced.map((p) => p.price_eur as number)).size;
      const spanDays = Math.floor(
        ((new Date(prezzo_corrente_date ?? 0).getTime()) - (new Date(prezzo_iniziale_date ?? 0).getTime())) / 86_400_000,
      );
      const enoughEvidence = distinctPrices >= 2 && spanDays >= 7;
      if (rawPct >= 0.25) {
        ribasso_implausibile = true;
        ribasso_pct = rawPct;
      } else if (enoughEvidence) {
        ribasso_pct = rawPct;
      }
    }
  }

  const latestMs = tsOf(sortedByTime[sortedByTime.length - 1]);
  const arc_days = Math.max(0, Math.floor((latestMs - earliest) / 86_400_000));

  // Confidence (use raw snapshot count, before low-confidence suppression)
  let confidenza: Confidenza = "bassa";
  if (sortedByTime.length >= 3 && arc_days >= 60) confidenza = "alta";
  else if (sortedByTime.length >= 2) confidenza = "media";

  // Low-confidence: suppress price-derived signals (single snapshot ≠ trend)
  if (confidenza === "bassa") {
    ribasso_pct = null;
    numero_ribassi = 0;
    prezzo_iniziale = priced.length > 0 ? prezzo_iniziale : null;
  }

  const fermo = giorni_online >= 90 && giorni_online < 180;
  const molto_fermo = giorni_online >= 180;
  const ribassoFlag = ribasso_pct != null && ribasso_pct >= 0.03;
  const ribasso_forte = ribasso_pct != null && ribasso_pct >= 0.08;

  // Strength tiers (conservative):
  //   forte  → "Da lavorare oggi" eligible
  //   medio  → repost-only (no fermo / no ribasso); NOT work_today
  //   lieve  → fermo OR ribasso ≥3% alone
  //   nessuno
  let distress_strength: DistressStrength = "nessuno";
  const reposted_plus_drop = ripubblicato && ribasso_pct != null && ribasso_pct >= 0.03;
  const reposted_plus_fermo = ripubblicato && (fermo || molto_fermo);
  if (molto_fermo || ribasso_forte || reposted_plus_drop || reposted_plus_fermo) {
    distress_strength = "forte";
  } else if (ripubblicato) {
    distress_strength = "medio";
  } else if (fermo || ribassoFlag) {
    distress_strength = "lieve";
  }

  const bullets: string[] = [];
  if (molto_fermo) {
    const months = Math.max(1, Math.round(giorni_online / 30));
    bullets.push(`Online da ${months} mes${months === 1 ? "e" : "i"}`);
  } else if (giorni_online > 0) {
    bullets.push(`Online da ${giorni_online} giorni`);
  }

  let price_gap_label: string | null = null;
  if (ribasso_pct != null && ribasso_pct >= 0.03) {
    const pct = Math.round(ribasso_pct * 100);
    const monthLabel = fmtMonth(prezzo_iniziale_date);
    bullets.push(monthLabel ? `Ribasso del ${pct}% da ${monthLabel}` : `Ribasso del ${pct}%`);
    price_gap_label = monthLabel ? `−${pct}% da ${monthLabel}` : `−${pct}%`;
  }
  if (ripubblicato) {
    // Verified repost only — no count of artifact first_seen dates.
    bullets.push(
      offline_gap_days >= 14
        ? `Ripubblicato dopo ${offline_gap_days} giorni offline`
        : `Ripubblicato con prezzo aggiornato`,
    );
  }
  if (numero_ribassi >= 2) {
    bullets.push(`${numero_ribassi} ribassi consecutivi`);
  }

  // Sanitize every bullet through the forbidden-vocabulary guard.
  const explanation_bullets = bullets
    .map((b) => sanitizeCopy(b))
    .filter((b) => b.length > 0);

  return {
    giorni_online,
    prezzo_corrente,
    prezzo_iniziale,
    ribasso_pct,
    numero_ribassi,
    ripubblicato,
    offline_gap_days,
    confidenza,
    snapshot_count: sortedByTime.length,
    arc_days,
    fermo,
    molto_fermo,
    ribasso: ribassoFlag,
    ribasso_forte,
    distress_strength,
    explanation_bullets,
    price_gap_label,
    prezzo_iniziale_date,
    prezzo_corrente_date,
  };
}

// ─── aggregation + evidence row builders ──────────────────────────────

const slug = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function sourceCodeForListing(source: string | null | undefined): string {
  const s = String(source ?? "").toLowerCase();
  if (s.includes("idealista")) return "F21";
  return "F13"; // immobiliare.it, casa.it and other portals
}

export interface ListingAggregate {
  listing_id: string;
  identity_hash: string | null;
  comune: string;
  representative: SnapshotRow;
  snapshots: SnapshotRow[];
  /** All snapshots that share this listing's identity_hash (across listing_ids). */
  identity_snapshots: SnapshotRow[];
}

/** Group snapshots by (comune, listing_id). Skips rows without both. */
export function aggregateSnapshots(rows: SnapshotRow[]): Map<string, ListingAggregate> {
  // Pre-index by identity_hash so we can attach the full identity history.
  const byIdentity = new Map<string, SnapshotRow[]>();
  for (const r of rows) {
    const h = r.identity_hash?.trim();
    if (!h) continue;
    const a = byIdentity.get(h) ?? [];
    a.push(r);
    byIdentity.set(h, a);
  }

  const out = new Map<string, ListingAggregate>();
  for (const r of rows) {
    const id = r.listing_id?.trim();
    const com = r.municipality?.trim();
    if (!id || !com) continue;
    // Skip known seed/demo data so we never surface fabricated listings as opportunities.
    if ((r.source ?? "").toLowerCase().includes("seed_demo")) continue;
    const key = `${slug(com)}|${id}`;
    const ex = out.get(key);
    if (ex) { ex.snapshots.push(r); continue; }
    const identity_hash = r.identity_hash?.trim() ?? null;
    const identity_snapshots = identity_hash ? (byIdentity.get(identity_hash) ?? []) : [];
    out.set(key, {
      listing_id: id, identity_hash, comune: com,
      representative: r, snapshots: [r], identity_snapshots,
    });
  }
  // Pick representative as the latest snapshot that has a URL (fallback: latest).
  for (const agg of out.values()) {
    const withUrl = agg.snapshots.filter((s) => s.url);
    const pool = withUrl.length > 0 ? withUrl : agg.snapshots;
    const sorted = pool.slice().sort((a, b) => tsOf(b) - tsOf(a));
    agg.representative = sorted[0];
  }
  return out;
}

/** Build the two evidence rows for one listing (deal_listing + listing_velocity). */
export function buildListingEvidence(agg: ListingAggregate, m: DistressMetrics): EvidenceInput[] {
  const code = sourceCodeForListing(agg.representative.source);
  const entity_key = `op:${slug(agg.comune)}:${agg.listing_id}`;
  const conf: "low" | "medium" | "high" =
    m.confidenza === "alta" ? "high" : m.confidenza === "media" ? "medium" : "low";

  const dealExplanation = sanitizeCopy(
    `Annuncio "${agg.representative.raw_title ?? agg.listing_id}" da ${agg.representative.source ?? "portale"}`,
  );
  const velExplanation = sanitizeCopy(
    m.explanation_bullets.length > 0
      ? m.explanation_bullets.join(" · ")
      : `Annuncio attivo a ${agg.comune}`,
  );

  const askPrice = m.prezzo_corrente ?? (typeof agg.representative.price_eur === "number" ? agg.representative.price_eur : null);

  const dealRow: EvidenceInput = {
    entity_type: "opportunity",
    entity_key,
    source_code: code,
    evidence_type: "deal_listing",
    evidence_value: {
      listing_id: agg.listing_id,
      title: sanitizeCopy(agg.representative.raw_title ?? `Annuncio ${agg.listing_id}`),
      listing_url: agg.representative.url ?? null,
      address: sanitizeCopy(agg.representative.raw_address ?? ""),
      ask_price: askPrice,
      surface_mq: agg.representative.surface_sqm ?? null,
      municipality: agg.comune,
      source_name: agg.representative.source ?? null,
      property_type: agg.representative.property_type ?? null,
      last_seen_at: m.prezzo_corrente_date ?? null,
    },
    confidence: conf,
    raw_ref_id: agg.listing_id,
    explanation: dealExplanation,
  };

  const urgencyHint: "low" | "medium" | "high" =
    m.distress_strength === "forte" ? "high"
    : (m.distress_strength === "medio" || m.distress_strength === "lieve") ? "medium"
    : "low";

  const velRow: EvidenceInput = {
    entity_type: "opportunity",
    entity_key,
    source_code: code,
    evidence_type: "listing_velocity",
    evidence_value: {
      giorni_online: m.giorni_online,
      prezzo_corrente: m.prezzo_corrente,
      prezzo_iniziale: m.prezzo_iniziale,
      ribasso_pct: m.ribasso_pct,
      numero_ribassi: m.numero_ribassi,
      ripubblicato: m.ripubblicato,
      offline_gap_days: m.offline_gap_days,
      confidenza: m.confidenza,
      distress_strength: m.distress_strength,
      explanation_bullets: m.explanation_bullets,
      price_gap_label: m.price_gap_label,
      urgency_hint: urgencyHint,
      ask_price: askPrice,
    },
    confidence: conf,
    raw_ref_id: agg.listing_id,
    explanation: velExplanation,
  };

  return [dealRow, velRow];
}
