// _shared/contendibiliAuctionGuard.ts
// Mirror TypeScript deterministico della funzione SQL
// public.padova_listing_has_auction_evidence(jsonb, text).
// Serve come contratto verificabile lato repo (test) e come guardia
// riutilizzabile dalle sole pipeline Contendibili.
// Il nome dell'agenzia NON è mai, da solo, prova sufficiente.

export interface AuctionCheckInput {
  title?: string | null;
  subject?: string | null;
  notes?: string | null;
  description?: string | null;
  body?: string | null;
  // campi strutturati
  rty?: string | null;
  auction?: string | boolean | null;
  contract?: string | null;
  typology?: string | null;
  saleType?: string | null;
  tipo_vendita?: string | null;
  // segnale accessorio
  agency?: string | null;
}

export function normalizeAuctionField(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

const TEXT_RULES: RegExp[] = [
  /(^|[^a-z0-9])(aste?|pre[- ]?aste?|auction)([^a-z0-9]|$)/,
  /giudiziar/,
  /esecuzion[ei] immobiliar/,
  /procedur[ae] esecutiv/,
  /(^|[^a-z0-9])tribunale([^a-z0-9]|$)/,
  /(^|[^a-z0-9])lott[oi]([^a-z0-9]|$)/,
  /base d.?asta/,
  /offerta minima/,
  /senza incanto/,
  /(^|[^a-z0-9])r\.?g\.?e\.?([^a-z0-9]|$)/,
  /custode giudiziario/,
  /delegato alla vendita/,
  /pignoram/,
  /fallimentar/,
  /concordato preventivo/,
];

const STRUCTURED_RULE = /(asta|auction|giudizia)/;
const AGENCY_RULE = /(^|[^a-z0-9])(aste?|asta)([^a-z0-9]|$)/;
const AGENCY_SUPPORT_RULE = /(procedur|giudizi|tribunal|esecutiv|incanto|perizia)/;

export function hasAuctionEvidence(input: AuctionCheckInput): boolean {
  const rty = normalizeAuctionField(input.rty);
  if (rty === "as") return true;

  const auctionField = normalizeAuctionField(input.auction);
  if (["true", "1", "yes", "si"].includes(auctionField)) return true;

  for (const f of [input.contract, input.typology, input.saleType, input.tipo_vendita]) {
    if (STRUCTURED_RULE.test(normalizeAuctionField(f))) return true;
  }

  const txt = normalizeAuctionField(
    [input.title, input.subject, input.notes, input.description, input.body]
      .filter(Boolean)
      .join(" "),
  );
  if (!txt) return false;

  for (const re of TEXT_RULES) {
    if (re.test(txt)) return true;
  }

  // Il nome agenzia vale SOLO se accompagnato da evidenza testuale di procedura.
  const agency = normalizeAuctionField(input.agency);
  if (AGENCY_RULE.test(agency) && AGENCY_SUPPORT_RULE.test(txt)) return true;

  return false;
}

/** Un gruppo di contendibili è escluso se ALMENO UN annuncio è un'asta. */
export function groupHasAuction(listings: AuctionCheckInput[]): boolean {
  return listings.some((l) => hasAuctionEvidence(l));
}
