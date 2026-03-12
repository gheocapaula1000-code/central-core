// ═══════════════════════════════════════════════════════════════
// Sottra — Street Evidence Layer (Phase 2)
// Extracts and merges visual evidence from building photos
// to strengthen or weaken geo identification confidence.
// ═══════════════════════════════════════════════════════════════

import { callAIVision, parseJSON, withAbort } from "./shared.ts";

// ── Types & Interfaces ────────────────────────────────────────

export type FacadeConsistencyLevel = "strong" | "good" | "partial" | "weak" | "none";
export type IdentityVerificationLevel = "strong" | "good" | "partial" | "weak" | "insufficient";

/** Normalized photo evidence extracted from a building photo */
export interface PhotoEvidenceNormalized {
  visibleHouseNumber: string | null;
  visibleStreetName: string | null;
  buildingType: "residenziale" | "commerciale" | "misto" | "industriale" | null;
  visibleFloors: number | null;
  facadeConfidence: number; // 0-1
  photoReadability: "clear" | "partial" | "poor";
  occlusionLevel: "none" | "partial" | "heavy" | null;
  daylightQuality: "good" | "fair" | "poor" | null;
  /** Raw AI confidence for the extraction */
  extractionConfidence: number;
}

/** Result from a street-level evidence provider */
export interface StreetEvidenceSignal {
  provider: string;
  available: boolean;
  streetVisible: boolean;
  visibleStreetName: string | null;
  visibleHouseNumber: string | null;
  facadeType: string | null;
  buildingEntranceDetected: boolean;
  consistencyWithResolvedStreet: "match" | "partial" | "mismatch" | "unknown";
  consistencyWithHouseNumber: "match" | "partial" | "mismatch" | "unknown";
  consistencyWithGeo: "match" | "partial" | "mismatch" | "unknown";
  confidence: number;
  limitations: string[];
  sourceClass: "photo_ai" | "street_provider" | "unavailable";
}

/** Abstract adapter for street-level evidence providers */
export interface StreetEvidenceAdapter {
  readonly name: string;
  readonly priority: number;
  isAvailable(): boolean;
  extractEvidence(
    lat: number,
    lng: number,
    resolvedStreet: string | null,
    resolvedHouseNumber: string | null,
  ): Promise<StreetEvidenceSignal | null>;
}

/** Final merged result of all street evidence sources */
export interface StreetEvidenceMergeResult {
  streetEvidenceConfidence: number;
  streetEvidenceReason: string;
  houseNumberConfirmed: boolean;
  streetConfirmed: boolean;
  facadeConsistencyLevel: FacadeConsistencyLevel;
  finalIdentityConfidence: number;
  finalIdentityReason: string;
  identityVerificationLevel: IdentityVerificationLevel;
  photoEvidence: PhotoEvidenceNormalized | null;
  streetSignals: StreetEvidenceSignal[];
}

// ── Constants ─────────────────────────────────────────────────

export const STREET_EVIDENCE_POLICY = {
  /** Bonus when photo civico matches geocoded civico */
  HOUSE_NUMBER_MATCH_BONUS: 0.08,
  /** Bonus when photo street name matches geocoded street */
  STREET_MATCH_BONUS: 0.05,
  /** Penalty when photo and geocoding clearly conflict */
  CONFLICT_PENALTY: 0.12,
  /** Minimum photo extraction confidence to consider evidence */
  MIN_PHOTO_CONFIDENCE: 0.30,
  /** Maximum bonus from all street evidence combined */
  MAX_TOTAL_BONUS: 0.15,
  /** Maximum penalty from all street evidence combined */
  MAX_TOTAL_PENALTY: 0.20,
} as const;

// ── Photo Evidence Extraction ─────────────────────────────────

/**
 * Extract normalized photo evidence from a building photo using AI vision.
 * Returns null if photo is absent, unreadable, or AI extraction fails.
 * Never invents data — signals absent when not extractable.
 */
export async function extractPhotoEvidence(
  photoBase64: string,
): Promise<PhotoEvidenceNormalized | null> {
  if (!photoBase64 || !photoBase64.startsWith("data:image")) return null;

  try {
    const output = await callAIVision(
      `Stai guardando la foto di un edificio dall'esterno. Analizza la foto e rispondi SOLO in JSON valido con questa struttura esatta:
{
  "confidence": numero_da_0_a_1,
  "visibleFloors": numero_piani_visibili_o_null,
  "buildingType": "residenziale"|"commerciale"|"misto"|"industriale"|null,
  "visibleHouseNumber": civico_visibile_sulla_facciata_o_null,
  "visibleStreetName": nome_via_visibile_su_targa_o_insegna_o_null,
  "photoReadability": "clear"|"partial"|"poor",
  "occlusionLevel": "none"|"partial"|"heavy"|null,
  "daylightQuality": "good"|"fair"|"poor"|null
}

REGOLE:
- visibleHouseNumber: SOLO se chiaramente leggibile sulla facciata/portone. Se dubbio, null.
- visibleStreetName: SOLO se c'è una targa stradale o insegna leggibile. Se dubbio, null.
- photoReadability: "clear" se la foto è nitida e ben esposta, "partial" se accettabile, "poor" se sfocata/buia.
- occlusionLevel: "none" se l'edificio è completamente visibile, "partial" se parzialmente ostruito, "heavy" se molto ostruito.
- confidence: la tua sicurezza complessiva nell'analisi (0=nessuna, 1=massima).
- Non inventare numeri civici o nomi di vie che non sono chiaramente visibili.`,
      photoBase64, 200, 0.1
    );

    const parsed = parseJSON(output);
    if (!parsed) return null;

    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    if (confidence < STREET_EVIDENCE_POLICY.MIN_PHOTO_CONFIDENCE) return null;

    const readability = (["clear", "partial", "poor"] as const).includes(
      parsed.photoReadability as "clear" | "partial" | "poor"
    ) ? (parsed.photoReadability as "clear" | "partial" | "poor") : "partial";

    return {
      visibleHouseNumber: typeof parsed.visibleHouseNumber === "string" ? parsed.visibleHouseNumber : null,
      visibleStreetName: typeof parsed.visibleStreetName === "string" ? parsed.visibleStreetName : null,
      buildingType: (["residenziale", "commerciale", "misto", "industriale"] as const).includes(
        parsed.buildingType as "residenziale"
      ) ? (parsed.buildingType as PhotoEvidenceNormalized["buildingType"]) : null,
      visibleFloors: typeof parsed.visibleFloors === "number" ? parsed.visibleFloors : null,
      facadeConfidence: confidence,
      photoReadability: readability,
      occlusionLevel: (["none", "partial", "heavy"] as const).includes(
        parsed.occlusionLevel as "none"
      ) ? (parsed.occlusionLevel as PhotoEvidenceNormalized["occlusionLevel"]) : null,
      daylightQuality: (["good", "fair", "poor"] as const).includes(
        parsed.daylightQuality as "good"
      ) ? (parsed.daylightQuality as PhotoEvidenceNormalized["daylightQuality"]) : null,
      extractionConfidence: confidence,
    };
  } catch (e) {
    console.warn(`[street-evidence:photo] Extraction failed: ${String(e).slice(0, 80)}`);
    return null;
  }
}

// ── Street-Level Provider: Mapillary (optional) ───────────────

export class MapillaryProvider implements StreetEvidenceAdapter {
  readonly name = "mapillary";
  readonly priority = 1;

  isAvailable(): boolean {
    const enabled = Deno.env.get("STREET_EVIDENCE_ENABLED") !== "false";
    return enabled && !!(Deno.env.get("MAPILLARY_API_KEY"));
  }

  async extractEvidence(
    lat: number,
    lng: number,
    resolvedStreet: string | null,
    resolvedHouseNumber: string | null,
  ): Promise<StreetEvidenceSignal | null> {
    const key = Deno.env.get("MAPILLARY_API_KEY");
    if (!key) return null;

    const { signal, clear } = withAbort(10_000);
    try {
      // Search for nearby street-level images
      const res = await fetch(
        `https://graph.mapillary.com/images?access_token=${key}&fields=id,captured_at,geometry,detections.value&bbox=${lng - 0.001},${lat - 0.001},${lng + 0.001},${lat + 0.001}&limit=5`,
        { signal }
      );

      if (!res.ok) {
        return {
          provider: this.name,
          available: false,
          streetVisible: false,
          visibleStreetName: null,
          visibleHouseNumber: null,
          facadeType: null,
          buildingEntranceDetected: false,
          consistencyWithResolvedStreet: "unknown",
          consistencyWithHouseNumber: "unknown",
          consistencyWithGeo: "unknown",
          confidence: 0,
          limitations: [`Mapillary API returned ${res.status}`],
          sourceClass: "street_provider",
        };
      }

      const data = await res.json();
      const images = data?.data ?? [];

      if (images.length === 0) {
        return {
          provider: this.name,
          available: true,
          streetVisible: false,
          visibleStreetName: null,
          visibleHouseNumber: null,
          facadeType: null,
          buildingEntranceDetected: false,
          consistencyWithResolvedStreet: "unknown",
          consistencyWithHouseNumber: "unknown",
          consistencyWithGeo: "unknown",
          confidence: 0.20,
          limitations: ["Nessuna immagine street-level disponibile in prossimità"],
          sourceClass: "street_provider",
        };
      }

      // Images found nearby — basic availability signal
      return {
        provider: this.name,
        available: true,
        streetVisible: true,
        visibleStreetName: null, // Mapillary doesn't directly provide OCR street names
        visibleHouseNumber: null,
        facadeType: null,
        buildingEntranceDetected: false,
        consistencyWithResolvedStreet: "unknown",
        consistencyWithHouseNumber: "unknown",
        consistencyWithGeo: "partial",
        confidence: 0.35,
        limitations: [
          "Mapillary fornisce solo copertura street-level, non OCR su targhe stradali",
          "La presenza di immagini conferma l'accessibilità della zona ma non il civico",
        ],
        sourceClass: "street_provider",
      };
    } catch (e) {
      console.warn(`[street-evidence:mapillary] Error: ${String(e).slice(0, 80)}`);
      return null;
    } finally {
      clear();
    }
  }
}

// ── Provider Chain ────────────────────────────────────────────

function getStreetEvidenceProviders(): StreetEvidenceAdapter[] {
  const envOrder = Deno.env.get("STREET_PROVIDER_ORDER");
  const providers: StreetEvidenceAdapter[] = [new MapillaryProvider()];

  if (envOrder) {
    const order = envOrder.split(",").map(s => s.trim().toLowerCase());
    return providers
      .filter(p => order.includes(p.name))
      .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }

  return providers;
}

// ── Consistency Helpers ───────────────────────────────────────

function normalizeForComparison(s: string | null): string {
  if (!s) return "";
  return s.toUpperCase().trim()
    .replace(/\s+/g, " ")
    .replace(/[.,;:']/g, "")
    .replace(/^VIA\s+/i, "")
    .replace(/^VIALE\s+/i, "")
    .replace(/^CORSO\s+/i, "")
    .replace(/^PIAZZA\s+/i, "")
    .replace(/^PIAZZALE\s+/i, "")
    .replace(/^LARGO\s+/i, "")
    .replace(/^VICOLO\s+/i, "");
}

function compareHouseNumbers(a: string | null, b: string | null): "match" | "partial" | "mismatch" | "unknown" {
  if (!a || !b) return "unknown";
  const numA = a.replace(/\D/g, "");
  const numB = b.replace(/\D/g, "");
  if (!numA || !numB) return "unknown";
  if (numA === numB) return "match";
  // Close numbers could be same building (e.g. 10 vs 10/A)
  if (Math.abs(parseInt(numA) - parseInt(numB)) <= 2) return "partial";
  return "mismatch";
}

function compareStreetNames(a: string | null, b: string | null): "match" | "partial" | "mismatch" | "unknown" {
  if (!a || !b) return "unknown";
  const normA = normalizeForComparison(a);
  const normB = normalizeForComparison(b);
  if (!normA || !normB) return "unknown";
  if (normA === normB) return "match";
  if (normA.includes(normB) || normB.includes(normA)) return "partial";
  return "mismatch";
}

// ── Evidence Merge ────────────────────────────────────────────

/**
 * Merge photo evidence and street-level provider signals with geo resolution
 * to produce a final identity confidence assessment.
 *
 * Algorithm (explainable):
 * 1. Start from geoConfidence as baseline
 * 2. Apply house number match/mismatch bonus/penalty
 * 3. Apply street name match/mismatch bonus/penalty
 * 4. Apply photo readability quality factor
 * 5. Cap total bonus/penalty within policy limits
 * 6. Classify final identity verification level
 */
export function mergeStreetEvidence(
  geoConfidence: number,
  geoMatchLevel: string,
  resolvedStreet: string | null,
  resolvedHouseNumber: string | null,
  photoEvidence: PhotoEvidenceNormalized | null,
  streetSignals: StreetEvidenceSignal[],
): StreetEvidenceMergeResult {
  const reasons: string[] = [];
  let totalAdjustment = 0;

  // --- House number comparison ---
  let houseNumberConfirmed = false;
  if (photoEvidence?.visibleHouseNumber && resolvedHouseNumber) {
    const hnCompare = compareHouseNumbers(photoEvidence.visibleHouseNumber, resolvedHouseNumber);
    if (hnCompare === "match") {
      const bonus = STREET_EVIDENCE_POLICY.HOUSE_NUMBER_MATCH_BONUS * photoEvidence.facadeConfidence;
      totalAdjustment += bonus;
      houseNumberConfirmed = true;
      reasons.push(`Civico confermato: foto "${photoEvidence.visibleHouseNumber}" = geocodifica "${resolvedHouseNumber}" (+${(bonus * 100).toFixed(1)}%)`);
    } else if (hnCompare === "mismatch") {
      const penalty = STREET_EVIDENCE_POLICY.CONFLICT_PENALTY * photoEvidence.facadeConfidence;
      totalAdjustment -= penalty;
      reasons.push(`Conflitto civico: foto "${photoEvidence.visibleHouseNumber}" ≠ geocodifica "${resolvedHouseNumber}" (-${(penalty * 100).toFixed(1)}%)`);
    } else if (hnCompare === "partial") {
      const microBonus = STREET_EVIDENCE_POLICY.HOUSE_NUMBER_MATCH_BONUS * 0.3 * photoEvidence.facadeConfidence;
      totalAdjustment += microBonus;
      reasons.push(`Civico parzialmente coerente: foto "${photoEvidence.visibleHouseNumber}" ~ geocodifica "${resolvedHouseNumber}"`);
    }
  }

  // --- Street name comparison ---
  let streetConfirmed = false;
  if (photoEvidence?.visibleStreetName && resolvedStreet) {
    const streetCompare = compareStreetNames(photoEvidence.visibleStreetName, resolvedStreet);
    if (streetCompare === "match") {
      const bonus = STREET_EVIDENCE_POLICY.STREET_MATCH_BONUS * photoEvidence.facadeConfidence;
      totalAdjustment += bonus;
      streetConfirmed = true;
      reasons.push(`Via confermata: foto "${photoEvidence.visibleStreetName}" = geocodifica "${resolvedStreet}" (+${(bonus * 100).toFixed(1)}%)`);
    } else if (streetCompare === "mismatch") {
      const penalty = STREET_EVIDENCE_POLICY.CONFLICT_PENALTY * 0.7 * photoEvidence.facadeConfidence;
      totalAdjustment -= penalty;
      reasons.push(`Conflitto via: foto "${photoEvidence.visibleStreetName}" ≠ geocodifica "${resolvedStreet}" (-${(penalty * 100).toFixed(1)}%)`);
    } else if (streetCompare === "partial") {
      const microBonus = STREET_EVIDENCE_POLICY.STREET_MATCH_BONUS * 0.4 * photoEvidence.facadeConfidence;
      totalAdjustment += microBonus;
      streetConfirmed = true; // partial street match still counts
      reasons.push(`Via parzialmente coerente: foto "${photoEvidence.visibleStreetName}" ~ geocodifica "${resolvedStreet}"`);
    }
  }

  // --- Street-level provider signals ---
  for (const signal of streetSignals) {
    if (!signal.available || signal.confidence < 0.20) continue;

    if (signal.consistencyWithHouseNumber === "match") {
      const provBonus = 0.03 * signal.confidence;
      totalAdjustment += provBonus;
      reasons.push(`${signal.provider}: civico confermato (+${(provBonus * 100).toFixed(1)}%)`);
    }
    if (signal.consistencyWithGeo === "mismatch") {
      const provPenalty = 0.05 * signal.confidence;
      totalAdjustment -= provPenalty;
      reasons.push(`${signal.provider}: inconsistenza geo (-${(provPenalty * 100).toFixed(1)}%)`);
    }
  }

  // --- Photo quality factor ---
  if (photoEvidence) {
    if (photoEvidence.photoReadability === "poor") {
      // Reduce the weight of any positive adjustments from poor photos
      if (totalAdjustment > 0) {
        totalAdjustment *= 0.5;
        reasons.push("Foto di bassa qualità: bonus dimezzato");
      }
    }
    if (photoEvidence.occlusionLevel === "heavy") {
      if (totalAdjustment > 0) {
        totalAdjustment *= 0.6;
        reasons.push("Edificio molto ostruito: bonus ridotto");
      }
    }
  }

  // --- Cap adjustments ---
  totalAdjustment = Math.max(-STREET_EVIDENCE_POLICY.MAX_TOTAL_PENALTY,
    Math.min(STREET_EVIDENCE_POLICY.MAX_TOTAL_BONUS, totalAdjustment));

  // --- Compute street evidence confidence ---
  const streetEvidenceConfidence = photoEvidence
    ? Math.max(0, Math.min(1, photoEvidence.facadeConfidence * (houseNumberConfirmed ? 1.0 : streetConfirmed ? 0.7 : 0.4)))
    : 0;

  // --- Final identity confidence ---
  const finalIdentityConfidence = Math.max(0, Math.min(1,
    parseFloat((geoConfidence + totalAdjustment).toFixed(3))
  ));

  // --- Facade consistency ---
  let facadeConsistencyLevel: FacadeConsistencyLevel = "none";
  if (houseNumberConfirmed && streetConfirmed) facadeConsistencyLevel = "strong";
  else if (houseNumberConfirmed || (streetConfirmed && photoEvidence && photoEvidence.facadeConfidence >= 0.6)) facadeConsistencyLevel = "good";
  else if (streetConfirmed || (photoEvidence && photoEvidence.facadeConfidence >= 0.4)) facadeConsistencyLevel = "partial";
  else if (photoEvidence && photoEvidence.facadeConfidence > 0) facadeConsistencyLevel = "weak";

  // --- Identity verification level ---
  let identityVerificationLevel: IdentityVerificationLevel;
  if (finalIdentityConfidence >= 0.85 && houseNumberConfirmed) identityVerificationLevel = "strong";
  else if (finalIdentityConfidence >= 0.70 && (houseNumberConfirmed || streetConfirmed)) identityVerificationLevel = "good";
  else if (finalIdentityConfidence >= 0.50) identityVerificationLevel = "partial";
  else if (finalIdentityConfidence >= 0.30) identityVerificationLevel = "weak";
  else identityVerificationLevel = "insufficient";

  // --- No photo at all ---
  if (!photoEvidence && streetSignals.length === 0) {
    reasons.push("Nessuna evidenza visiva o street-level disponibile — confidence basata solo su geocoding");
  }

  return {
    streetEvidenceConfidence,
    streetEvidenceReason: reasons.length > 0 ? reasons.join(". ") : "Nessuna evidenza visiva analizzata",
    houseNumberConfirmed,
    streetConfirmed,
    facadeConsistencyLevel,
    finalIdentityConfidence,
    finalIdentityReason: `Confidence geo: ${(geoConfidence * 100).toFixed(0)}%, ` +
      `aggiustamento street evidence: ${totalAdjustment >= 0 ? "+" : ""}${(totalAdjustment * 100).toFixed(1)}%, ` +
      `finale: ${(finalIdentityConfidence * 100).toFixed(0)}%`,
    identityVerificationLevel,
    photoEvidence,
    streetSignals,
  };
}

// ── Main Entry Point ──────────────────────────────────────────

/**
 * Collect all street evidence for a location.
 * - Extract photo evidence (AI vision)
 * - Query street-level providers (if configured)
 * - Merge everything into a single result
 *
 * Safe to call without any providers configured — returns clean empty result.
 */
export async function collectStreetEvidence(
  lat: number,
  lng: number,
  photoBase64: string | null,
  geoConfidence: number,
  geoMatchLevel: string,
  resolvedStreet: string | null,
  resolvedHouseNumber: string | null,
): Promise<StreetEvidenceMergeResult> {
  // 1. Extract photo evidence
  const photoEvidence = photoBase64
    ? await extractPhotoEvidence(photoBase64)
    : null;

  // 2. Query street-level providers
  const providers = getStreetEvidenceProviders().filter(p => p.isAvailable());
  const streetSignals: StreetEvidenceSignal[] = [];

  if (providers.length > 0) {
    const promises = providers.map(async (provider) => {
      try {
        return await provider.extractEvidence(lat, lng, resolvedStreet, resolvedHouseNumber);
      } catch (e) {
        console.warn(`[street-evidence:${provider.name}] Failed: ${String(e).slice(0, 80)}`);
        return null;
      }
    });
    const results = await Promise.all(promises);
    for (const r of results) {
      if (r) streetSignals.push(r);
    }
  }

  // 3. Merge all evidence
  return mergeStreetEvidence(
    geoConfidence, geoMatchLevel,
    resolvedStreet, resolvedHouseNumber,
    photoEvidence, streetSignals,
  );
}

// ── Market Data Adapter is now in market-data.ts ──────────────
// See: supabase/functions/sottra/market-data.ts
