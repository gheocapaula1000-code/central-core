// _shared/imagePhashV1Gate.ts — Civiko One / Padova, certificazione fotografica
// v5 dei contendibili. Valutatore PER COPPIA, allineato al matcher v5:
//
//  * identita' = foto (pHash) + mq compatibile + prezzo compatibile + stessa zona;
//  * via/civico NON sono un gate: le agenzie li nascondono di proposito;
//  * prezzo: >15% = reject; 10-15% richiede >=2 foto condivise;
//  * mq: max <= max(min+5, min*1.05); mq assente = reject;
//  * nessun ramo STRUCTURAL/geo-text: zero foto = non contendibile;
//  * reject comuni: stessa canonical, stessa agenzia, asta, MLS, zona diversa;
//  * complete-link: ogni coppia del gruppo deve reggere da sola.

import {
  GENERIC_REUSE_THRESHOLD,
  isPhotoMatch,
  hammingDistance,
  rejectFingerprint,
  PHASH_ALGO,
  PHASH_MATCH_MAX_DISTANCE,
} from "./imagePhash.ts";

/** Versione ESATTA richiesta dal matcher v4: le prove v3 non certificano mai. */
export const MATCH_VERSION = "v4-padova-photo-pair";
export const EVIDENCE_KIND = "IMAGE_PHASH_V1";
export const EXPECTED_ALGO = PHASH_ALGO;

/** Bande di prezzo del contratto v4: nessuna soglia legacy piu' permissiva. */
export const PRICE_RATIO_PHOTO_1 = 1.10;
export const PRICE_RATIO_MAX = 1.15;
/** Foto minime per la fascia 10-15%. */
export const MIN_SHARED_PHOTOS_BAND_2 = 2;
/** Foto minime per la fascia <=10%. */
export const MIN_SHARED_PHOTOS_BAND_1 = 1;
/** Compatibilita' storica del nome esportato. */
export const MIN_SHARED_PHOTOS_PER_PAIR = MIN_SHARED_PHOTOS_BAND_2;
/** Ramo strutturale: distanza massima e tolleranza mq. */
export const STRUCTURAL_MAX_DIST_M = 30;
export const STRUCTURAL_MQ_TOLERANCE = 1.05;
/** Segnale di plausibilita' geografico della fascia <=10%. */
export const PLAUSIBILITY_MAX_DIST_M = 150;
export const PLAUSIBILITY_MQ_TOLERANCE = 1.15;

export interface PhotoFp {
  sha256: string;
  phash: string;
  width: number;
  height: number;
  entropy: number;
  /** In quanti annunci NON collegati compare la stessa immagine. */
  reuseCount?: number;
}

export interface ListingForImageGate {
  url: string;
  fonte: string;
  agencyKey: string; // agenzia normalizzata ("" = ignota/non provante)
  canonicalListingId?: string | null;
  zone: string;
  tipologia: string | null;
  locali: number | null;
  mq: number | null;
  prezzo: number;
  civico: string | null;
  piano: string | null;
  via?: string | null;
  descrFp?: string | null;
  lat?: number | null;
  lng?: number | null;
  bagni?: number | null;
  asta?: boolean;
  mls?: boolean;
  photos: PhotoFp[];
}

export type PairBranch = "PHOTO" | "STRUCTURAL" | null;

export interface PairEvidence {
  a: string;
  b: string;
  agencyA: string;
  agencyB: string;
  confronti: number;
  corrispondenze: number;
  distanze: number[];
  prezzo_ratio: number | null;
  dist_m: number | null;
  branch: PairBranch;
  photo_strong: boolean;
  valida: boolean;
  motivi: string[];
}

export interface ImageGateResult {
  certificato: boolean;
  match_version: string;
  evidence_kind: string;
  algo: string;
  soglia: number;
  immagini_confrontate: number;
  immagini_scartate: number;
  coppie: PairEvidence[];
  n_pairs_attese: number;
  n_pairs_photo: number;
  motivi: string[];
  motivazione: string;
}

const usable = (p: PhotoFp): boolean => rejectFingerprint(p, p.reuseCount ?? 1) === null;

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;
export function haversineM(
  aLat?: number | null,
  aLng?: number | null,
  bLat?: number | null,
  bLng?: number | null,
): number | null {
  if (aLat == null || aLng == null || bLat == null || bLng == null) return null;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function priceRatio(a: ListingForImageGate, b: ListingForImageGate): number | null {
  const lo = Math.min(a.prezzo, b.prezzo);
  const hi = Math.max(a.prezzo, b.prezzo);
  if (!(lo > 0) || !(hi > 0)) return null;
  return hi / lo;
}

function mqRatio(a: ListingForImageGate, b: ListingForImageGate): number | null {
  if (!a.mq || !b.mq || a.mq <= 0 || b.mq <= 0) return null;
  return Math.max(a.mq, b.mq) / Math.min(a.mq, b.mq);
}

/** Banda mq del matcher v5: +5 mq oppure 5%. Via/civico non contano. */
export function mqCompatible(a: ListingForImageGate, b: ListingForImageGate): boolean {
  if (!a.mq || !b.mq || a.mq <= 0 || b.mq <= 0) return false;
  const lo = Math.min(a.mq, b.mq);
  return Math.max(a.mq, b.mq) <= Math.max(lo + 5, lo * STRUCTURAL_MQ_TOLERANCE);
}

/** Almeno UN segnale non fotografico compatibile — mai il set completo. */
export function plausibilitySignal(
  a: ListingForImageGate,
  b: ListingForImageGate,
  distM: number | null,
): boolean {
  if (mqCompatible(a, b)) return true;
  if (a.locali != null && b.locali != null && a.locali === b.locali) return true;
  const mr = mqRatio(a, b);
  if (mr !== null && mr <= PLAUSIBILITY_MQ_TOLERANCE) return true;
  if (distM !== null && distM <= PLAUSIBILITY_MAX_DIST_M) return true;
  if (a.via && b.via && a.via === b.via) return true;
  if (a.civico && b.civico && a.civico === b.civico) return true;
  if (a.descrFp && b.descrFp && a.descrFp === b.descrFp) return true;
  if (a.tipologia && b.tipologia && a.tipologia === b.tipologia) return true;
  return false;
}

/** Ramo strutturale: unita' compatibile + geo <= 30 m + testo forte. */
export function structuralBranchOk(
  a: ListingForImageGate,
  b: ListingForImageGate,
  distM: number | null,
): boolean {
  if (a.locali == null || b.locali == null || a.locali !== b.locali) return false;
  if (!a.tipologia || !b.tipologia || a.tipologia !== b.tipologia) return false;
  if (!a.piano || !b.piano || a.piano !== b.piano) return false;
  if (!a.mq || !b.mq || a.mq <= 0 || b.mq <= 0) return false;
  const lo = Math.min(a.mq, b.mq);
  if (Math.max(a.mq, b.mq) > Math.max(lo + 5, lo * STRUCTURAL_MQ_TOLERANCE)) return false;
  if (a.bagni != null && b.bagni != null && a.bagni !== b.bagni) return false;
  if (distM === null || distM > STRUCTURAL_MAX_DIST_M) return false;
  if (!a.descrFp || !b.descrFp || a.descrFp !== b.descrFp) return false;
  return true;
}

function sharedPhotos(a: ListingForImageGate, b: ListingForImageGate): number[] {
  const pa = a.photos.filter(usable);
  const pb = b.photos.filter(usable);
  const distanze: number[] = [];
  const usedA = new Set<string>();
  const usedB = new Set<string>();
  for (const x of pa) {
    for (const y of pb) {
      if (usedA.has(x.phash) || usedB.has(y.phash)) continue;
      if (x.sha256 === y.sha256 || isPhotoMatch(x.phash, y.phash)) {
        distanze.push(hammingDistance(x.phash, y.phash));
        usedA.add(x.phash);
        usedB.add(y.phash);
        break;
      }
    }
  }
  return distanze;
}

/** Reject comuni a OGNI ramo, valutati sulla singola coppia. */
function commonRejects(a: ListingForImageGate, b: ListingForImageGate): string[] {
  const m: string[] = [];
  if (a.zone !== b.zone) m.push("ZONE_DIVERSE");
  if (!a.agencyKey || !b.agencyKey) m.push("AGENZIA_IGNOTA");
  else if (a.agencyKey === b.agencyKey) m.push("STESSA_AGENZIA");
  if (
    a.canonicalListingId && b.canonicalListingId &&
    a.canonicalListingId === b.canonicalListingId
  ) m.push("CANONICAL_DUPLICATA");
  if (a.asta || b.asta) m.push("ASTA_O_PROCEDURA");
  if (a.mls || b.mls) m.push("MLS_ESCLUSIVA");
  return m;
}

export function evaluatePair(
  a: ListingForImageGate,
  b: ListingForImageGate,
): PairEvidence {
  const motivi = commonRejects(a, b);
  const distanze = sharedPhotos(a, b);
  const ratio = priceRatio(a, b);
  const distM = haversineM(a.lat, a.lng, b.lat, b.lng);
  let branch: PairBranch = null;
  let photoStrong = false;

  if (ratio === null) {
    motivi.push("PREZZO_ASSENTE");
  } else if (ratio > PRICE_RATIO_MAX) {
    motivi.push("PREZZO_OLTRE_15_PCT");
  } else if (!mqCompatible(a, b)) {
    motivi.push("MQ_INCOMPATIBILI");
  } else if (ratio <= PRICE_RATIO_PHOTO_1) {
    if (distanze.length >= MIN_SHARED_PHOTOS_BAND_1) {
      branch = "PHOTO";
      photoStrong = true;
    } else {
      motivi.push("PROVA_INSUFFICIENTE");
    }
  } else if (distanze.length >= MIN_SHARED_PHOTOS_BAND_2) {
    branch = "PHOTO";
    photoStrong = true;
  } else {
    motivi.push("PROVA_INSUFFICIENTE");
  }

  return {
    a: a.url,
    b: b.url,
    agencyA: a.agencyKey,
    agencyB: b.agencyKey,
    confronti: a.photos.filter(usable).length * b.photos.filter(usable).length,
    corrispondenze: distanze.length,
    distanze,
    prezzo_ratio: ratio === null ? null : Math.round(ratio * 10000) / 10000,
    dist_m: distM,
    branch,
    photo_strong: photoStrong,
    valida: motivi.length === 0 && branch !== null,
    motivi,
  };
}

export function evaluateImagePhashV1(rows: ListingForImageGate[]): ImageGateResult {
  const motivi: string[] = [];
  const n = rows.length;
  if (n < 2 || n > 4) motivi.push("CARDINALITA_NON_VALIDA");
  if (new Set(rows.map((r) => r.zone)).size !== 1) motivi.push("ZONE_DIVERSE");
  if (rows.some((r) => r.asta)) motivi.push("ASTA_O_PROCEDURA");
  if (rows.some((r) => r.mls)) motivi.push("MLS_ESCLUSIVA");
  if (new Set(rows.map((r) => r.agencyKey).filter((x) => x !== "")).size < 2) {
    motivi.push("AGENZIE_INSUFFICIENTI");
  }
  const prezzi = rows.map((r) => r.prezzo);
  const pzMin = Math.min(...prezzi);
  const pzMax = Math.max(...prezzi);
  if (!(pzMin > 0) || pzMax > pzMin * PRICE_RATIO_MAX) motivi.push("PREZZO_OLTRE_15_PCT");

  let confrontate = 0;
  let scartate = 0;
  for (const r of rows) {
    for (const p of r.photos) {
      if (usable(p)) confrontate++;
      else scartate++;
    }
  }

  // COMPLETE-LINK: tutte le coppie del gruppo, non solo quelle cross-agency.
  const coppie: PairEvidence[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) coppie.push(evaluatePair(rows[i], rows[j]));
  }
  const attese = (n * (n - 1)) / 2;
  if (coppie.length !== attese || coppie.some((c) => !c.valida)) {
    motivi.push("CLIQUE_INCOMPLETA");
  }

  const nPhoto = coppie.filter((c) => c.valida && c.branch === "PHOTO").length;
  if (nPhoto === 0) motivi.push("PROVA_INSUFFICIENTE");
  for (const extra of ["MQ_INCOMPATIBILI", "PREZZO_OLTRE_15_PCT", "ZONE_DIVERSE"]) {
    if (coppie.some((c) => c.motivi.includes(extra)) && !motivi.includes(extra)) {
      motivi.push(extra);
    }
  }

  const certificato = motivi.length === 0;
  return {
    certificato,
    match_version: MATCH_VERSION,
    evidence_kind: EVIDENCE_KIND,
    algo: EXPECTED_ALGO,
    soglia: PHASH_MATCH_MAX_DISTANCE,
    immagini_confrontate: confrontate,
    immagini_scartate: scartate,
    coppie,
    n_pairs_attese: attese,
    n_pairs_photo: nPhoto,
    motivi,
    motivazione: certificato
      ? `Ogni coppia del gruppo regge da sola entro il 15% di scarto prezzo (${MATCH_VERSION}, ${EXPECTED_ALGO}, distanza <= ${PHASH_MATCH_MAX_DISTANCE}); nessuna asta, esclusiva o agenzia coincidente.`
      : `Certificazione negata: ${motivi.join(", ")}.`,
  };
}

export { GENERIC_REUSE_THRESHOLD };
