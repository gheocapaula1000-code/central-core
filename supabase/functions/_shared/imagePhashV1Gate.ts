// _shared/imagePhashV1Gate.ts — SECONDA via di certificazione forte per i
// contendibili, accanto (mai al posto) delle regole strutturali v3.
//
// Un gruppo senza civico può essere certificato SOLO se ogni coppia di
// agenzie distinte condivide almeno 2 fotografie reali e distinte della
// stessa unità. Vietata la transitività A-B-C: ogni coppia deve reggere.

import {
  GENERIC_REUSE_THRESHOLD,
  isPhotoMatch,
  hammingDistance,
  rejectFingerprint,
  PHASH_ALGO,
  PHASH_MATCH_MAX_DISTANCE,
} from "./imagePhash.ts";

export const MATCH_VERSION = "v3-unit-certified+image-phash-v1";
export const EVIDENCE_KIND = "IMAGE_PHASH_V1";
export const MIN_SHARED_PHOTOS_PER_PAIR = 2;

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
  zone: string;
  tipologia: string | null;
  locali: number;
  mq: number;
  prezzo: number;
  civico: string | null;
  piano: string | null;
  asta?: boolean;
  mls?: boolean;
  photos: PhotoFp[];
}

export interface PairEvidence {
  a: string;
  b: string;
  agencyA: string;
  agencyB: string;
  confronti: number;
  corrispondenze: number;
  distanze: number[];
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
  motivi: string[];
  motivazione: string;
}

const usable = (p: PhotoFp): boolean => rejectFingerprint(p, p.reuseCount ?? 1) === null;

function structuralMotivi(rows: ListingForImageGate[]): string[] {
  const m: string[] = [];
  const n = rows.length;
  if (n < 2 || n > 4) m.push("CARDINALITA_NON_VALIDA");
  if (new Set(rows.map((r) => r.zone)).size !== 1) m.push("ZONE_DIVERSE");
  if (new Set(rows.map((r) => r.locali)).size !== 1) m.push("LOCALI_DISCORDANTI");
  if (new Set(rows.map((r) => r.tipologia).filter(Boolean)).size > 1)
    m.push("TIPOLOGIA_INCOMPATIBILE");

  const civici = new Set(rows.map((r) => r.civico).filter(Boolean));
  if (civici.size > 1) m.push("CIVICO_DISCORDANTE");
  const piani = new Set(rows.map((r) => r.piano).filter(Boolean));
  if (piani.size > 1) m.push("PIANO_DISCORDANTE");

  const mqMin = Math.min(...rows.map((r) => r.mq));
  const mqMax = Math.max(...rows.map((r) => r.mq));
  if (mqMin <= 0 || mqMax > mqMin * 1.05) m.push("MQ_INCOMPATIBILI");

  const pzMin = Math.min(...rows.map((r) => r.prezzo));
  const pzMax = Math.max(...rows.map((r) => r.prezzo));
  if (pzMin <= 0 || pzMax > pzMin * 1.35) m.push("PREZZO_OLTRE_35_PCT");

  if (rows.some((r) => r.asta)) m.push("ASTA_O_PROCEDURA");
  if (rows.some((r) => r.mls)) m.push("MLS_ESCLUSIVA");

  const agenzie = new Set(rows.map((r) => r.agencyKey).filter((a) => a !== ""));
  if (agenzie.size < 2) m.push("AGENZIE_INSUFFICIENTI");
  return m;
}

/** Coppie di annunci appartenenti ad agenzie diverse. */
function crossAgencyPairs(rows: ListingForImageGate[]): Array<[ListingForImageGate, ListingForImageGate]> {
  const out: Array<[ListingForImageGate, ListingForImageGate]> = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[i].agencyKey && rows[j].agencyKey && rows[i].agencyKey !== rows[j].agencyKey) {
        out.push([rows[i], rows[j]]);
      }
    }
  }
  return out;
}

export function evaluateImagePhashV1(rows: ListingForImageGate[]): ImageGateResult {
  const motivi = structuralMotivi(rows);

  let confrontate = 0;
  let scartate = 0;
  const coppie: PairEvidence[] = [];

  for (const r of rows) {
    for (const p of r.photos) {
      if (usable(p)) confrontate++;
      else scartate++;
    }
  }

  for (const [a, b] of crossAgencyPairs(rows)) {
    const pa = a.photos.filter(usable);
    const pb = b.photos.filter(usable);
    const distanze: number[] = [];
    const usedB = new Set<string>();
    const usedA = new Set<string>();
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
    coppie.push({
      a: a.url,
      b: b.url,
      agencyA: a.agencyKey,
      agencyB: b.agencyKey,
      confronti: pa.length * pb.length,
      corrispondenze: distanze.length,
      distanze,
    });
  }

  if (coppie.length === 0) motivi.push("NESSUNA_COPPIA_CROSS_AGENZIA");
  // Vietata la transitività: ogni coppia cross-agenzia deve reggere da sola.
  if (coppie.some((c) => c.corrispondenze < MIN_SHARED_PHOTOS_PER_PAIR))
    motivi.push("FOTO_CONDIVISE_INSUFFICIENTI");

  const certificato = motivi.length === 0;
  return {
    certificato,
    match_version: MATCH_VERSION,
    evidence_kind: EVIDENCE_KIND,
    algo: PHASH_ALGO,
    soglia: PHASH_MATCH_MAX_DISTANCE,
    immagini_confrontate: confrontate,
    immagini_scartate: scartate,
    coppie,
    motivi,
    motivazione: certificato
      ? `Ogni coppia di agenzie distinte condivide almeno ${MIN_SHARED_PHOTOS_PER_PAIR} fotografie reali entro distanza ${PHASH_MATCH_MAX_DISTANCE}; nessuna incompatibilità strutturale, asta o esclusiva.`
      : `Certificazione per immagini negata: ${motivi.join(", ")}.`,
  };
}

export { GENERIC_REUSE_THRESHOLD };
