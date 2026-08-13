// Contratto pubblico Civiko One — categoria "Contesi 2+".
// Un immobile e' contendibile con almeno 2 agenzie distinte.
// Il matching resta prudente: spread prezzo massimo 15% (10-15% tollerato solo
// con prova, es. fotografie identiche certificate), canonical ID distinti per
// evitare falsi positivi (stesso annuncio ripubblicato non fa gruppo).
// I cluster con 3+ agenzie restano marcati HOT lato PWA.

export const MIN_AGENZIE_CONTESI = 2;
export const MAX_PREZZO_SPREAD = 1.15;
export const MAX_PREZZO_SPREAD_SENZA_PROVA = 1.10;

export interface ContesiGroupInput {
  /** agenzie normalizzate del gruppo (duplicati ammessi in input) */
  agencies: string[];
  /** canonical listing id per ogni annuncio del gruppo */
  canonicalIds: string[];
  prezzoMin: number;
  prezzoMax: number;
  /** coppie certificate con fotografie identiche (fingerprint gia' disponibile) */
  photoCertifiedPairs?: number;
  hasAsta?: boolean;
  hasMls?: boolean;
}

export type ContesiRejectReason =
  | "AGENZIE_INSUFFICIENTI"
  | "CANONICAL_COLLISION"
  | "PREZZO_OLTRE_15_PCT"
  | "PREZZO_OLTRE_10_PCT_SENZA_PROVA"
  | "PREZZO_NON_VALIDO"
  | "ASTA_O_MLS";

export interface ContesiGateResult {
  ok: boolean;
  nAgenzie: number;
  nCanonici: number;
  reasons: ContesiRejectReason[];
}

function normAgency(a: string): string {
  return a.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function contesi3PlusGate(g: ContesiGroupInput): ContesiGateResult {
  const reasons: ContesiRejectReason[] = [];
  const nAgenzie = new Set(
    (g.agencies ?? []).map(normAgency).filter((a) => a !== ""),
  ).size;
  const nCanonici = new Set(
    (g.canonicalIds ?? []).map((c) => String(c ?? "").trim()).filter((c) => c !== ""),
  ).size;
  const photo = g.photoCertifiedPairs ?? 0;

  if (nAgenzie < MIN_AGENZIE_CONTESI) reasons.push("AGENZIE_INSUFFICIENTI");
  if (nCanonici < MIN_AGENZIE_CONTESI) reasons.push("CANONICAL_COLLISION");
  if (g.hasAsta === true || g.hasMls === true) reasons.push("ASTA_O_MLS");

  if (!(g.prezzoMin > 0) || !(g.prezzoMax > 0)) {
    reasons.push("PREZZO_NON_VALIDO");
  } else {
    const ratio = g.prezzoMax / g.prezzoMin;
    if (ratio > MAX_PREZZO_SPREAD) {
      reasons.push("PREZZO_OLTRE_15_PCT");
    } else if (ratio > MAX_PREZZO_SPREAD_SENZA_PROVA && photo < 1) {
      reasons.push("PREZZO_OLTRE_10_PCT_SENZA_PROVA");
    }
  }

  return { ok: reasons.length === 0, nAgenzie, nCanonici, reasons };
}
