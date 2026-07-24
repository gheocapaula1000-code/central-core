// casaParser — estrae annunci da una list-page casa.it salvata in Markdown.
// Approccio rule-based su pattern stabile presente nel testo:
//   [Titolo](https://www.casa.it/immobili/<id>/ "Titolo")
//   <zona>
//   € <prezzo>
//   <mq> m²<rooms> locali<bathrooms> bagni<floor><energy>
//   <descrizione>...
//   Espandi
//   [Agenzia](https://www.casa.it/agenzie/<slug>/...)   <-- assente se privato
//
// Niente AI, niente invenzioni. Solo regex sul testo già raccolto.

export interface ParsedCasaListing {
  listing_id: string;
  source_url: string;
  title: string | null;
  zone: string | null;
  price_eur: number | null;
  surface_sqm: number | null;
  rooms: number | null;
  bathrooms: number | null;
  floor: string | null;
  energy_class: string | null;
  description: string | null;
  agency_name: string | null;
  agency_slug: string | null;
  agency_url: string | null;
  is_privato: boolean;
  badge: string | null;
  tier: string | null;
  raw_block: string;
}

// Match SOLO il link "titolo card": esclude link immagine (![) e link "Immagine N di M".
// La regex cattura: prefisso (per escludere `!`), id, titolo (group 2).
const TITLE_LINK_RE =
  /(^|[^!])\[([^\]\n]+?)\]\(https:\/\/www\.casa\.it\/immobili\/(\d+)\/[^)]*\)/g;

// Match the /agenzie/<slug>/ URL anchor. Nested link text like
//   [![alt](img)Nome Agenzia](https://www.casa.it/agenzie/<slug>/...)
// breaks a naive `[text](url)` regex because the inner `![alt](img)` contains
// `]` and `)`. We anchor on the URL and walk back to recover the visible name.
const AGENCY_URL_RE =
  /\]\((https:\/\/www\.casa\.it\/agenzie\/([a-z0-9-]+)\/?[^)]*)\)/i;
const AGENCY_NAME_BEFORE_RE = /(?:\)|\[)([^\[\]\n()]{2,120})$/;

// Cattura SOLO il primo importo nel formato "€ X.XXX[.XXX]" con separatore
// punto delle migliaia (o un intero 4-7 cifre senza separatori). Si ferma al
// primo carattere non compatibile — evita di concatenare mq/rate/locali quando
// il markdown Firecrawl non ha un separatore (es. "€ 92.500tua" o "€ 92.500105 m²").
const PRICE_RE = /€\s*(\d{1,3}(?:\.\d{3})+|\d{4,7})(?!\d|\.\d)/;
const SURFACE_RE = /(\d{2,5})\s*m²/;
const ROOMS_RE = /(\d{1,2})\s*local/i;
const BATH_RE = /(\d{1,2})\s*bagn/i;
const ENERGY_RE = /\b(A4|A3|A2|A1|A\+|A|B|C|D|E|F|G)\b\s*$/m;
const FLOOR_RE =
  /(piano\s+terra|piano\s+rialzato|seminterrato|interrato|attico|mansarda|\d{1,2}°\s*piano)/i;
const TIER_RE = /\b(Platinum|Gold|Premium|Plus|Silver|Top)\b/;
const BADGE_RE = /\b(OCCASIONE|NUOVO|IN ESCLUSIVA|ASTA|NUOVA COSTRUZIONE)\b/;

function parsePriceEur(raw: string): number | null {
  // "290.000" -> 290000 ; "1.250.000" -> 1250000
  const digits = raw.replace(/\./g, "");
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  if (n < 1000) return null;
  // Guardia di sanità: scarta valori corrotti (concatenazione prezzo+mq/rata).
  // Nessun immobile residenziale casa.it Padova supera i 5M€.
  if (n > 5_000_000) return null;
  return Math.round(n);
}

function isImageAltLink(title: string): boolean {
  return /Immagine\s+\d+\s+di\s+\d+/i.test(title);
}

/**
 * Trova gli offset di inizio di ogni card titolo (link `/immobili/<id>/`)
 * scartando i link immagine. Restituisce array di {offset, id, title}.
 */
function findCardAnchors(md: string): Array<{ offset: number; id: string; title: string }> {
  const anchors: Array<{ offset: number; id: string; title: string }> = [];
  TITLE_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TITLE_LINK_RE.exec(md)) !== null) {
    const prefix = m[1] ?? "";
    const title = m[2];
    const id = m[3];
    if (isImageAltLink(title)) continue;
    // offset del `[` reale (dopo eventuale prefix di 1 char)
    const offset = m.index + prefix.length;
    anchors.push({ offset, id, title });
  }
  return anchors;
}

export function parseCasaListPage(
  markdown: string,
  sourceUrlFallback: string,
): ParsedCasaListing[] {
  if (!markdown || markdown.length < 200) return [];

  const anchors = findCardAnchors(markdown);
  if (anchors.length === 0) return [];

  // Dedup per listing_id mantenendo PRIMA occorrenza con campi ricchi.
  // Spesso lo stesso id appare 2-3 volte (galleria collassata). Teniamo
  // il blocco con più campi popolati.
  const byId = new Map<string, ParsedCasaListing>();

  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const next = anchors[i + 1]?.offset ?? Math.min(markdown.length, a.offset + 4000);
    const block = markdown.slice(a.offset, next);

    // skip blocchi troppo corti (sono micro-link interni, non card vere)
    if (block.length < 80) continue;

    // I primi ~12 char dopo `[` contengono il titolo già catturato.
    // La zona è la prima riga non vuota DOPO la riga del titolo e PRIMA del prezzo.
    const lines = block.split(/\n+/).map((l) => l.trim()).filter(Boolean);

    // line[0] è la riga col link titolo
    const priceLineIdx = lines.findIndex((l) => PRICE_RE.test(l));
    const zone =
      priceLineIdx > 1
        ? lines.slice(1, priceLineIdx).filter((l) => !l.startsWith("[") && !l.startsWith("!")).slice(-1)[0] ?? null
        : null;

    const priceMatch = priceLineIdx >= 0 ? lines[priceLineIdx].match(PRICE_RE) : null;
    const price_eur = priceMatch ? parsePriceEur(priceMatch[1]) : null;

    // riga tecnica: contiene "m²" - di solito subito dopo la riga prezzo
    const techLine = lines.find((l) => SURFACE_RE.test(l)) ?? "";
    const surfM = techLine.match(SURFACE_RE);
    const roomsM = techLine.match(ROOMS_RE);
    const bathM = techLine.match(BATH_RE);
    const floorM = techLine.match(FLOOR_RE);
    const energyM = techLine.match(/(A4|A3|A2|A1|A\+|A|B|C|D|E|F|G)(?:\d{0,2})?\s*$/);

    // descrizione: tra techLine e "Espandi"
    let description: string | null = null;
    const techIdx = lines.indexOf(techLine);
    const espandiIdx = lines.findIndex((l) => /^Espandi$/i.test(l));
    if (techIdx >= 0 && espandiIdx > techIdx) {
      const descLines = lines.slice(techIdx + 1, espandiIdx)
        .filter((l) => !l.startsWith("[") && !l.startsWith("!") && l !== "Espandi");
      if (descLines.length) description = descLines.join(" ").slice(0, 1500);
    }

    // agenzia: ancora sull'URL /agenzie/<slug>/ e ricava il nome dal testo
    // immediatamente prima del `](url)` (gestisce link annidato con immagine).
    const agencyM = block.match(AGENCY_URL_RE);
    let agency_name: string | null = null;
    let agency_slug: string | null = null;
    let agency_url: string | null = null;
    if (agencyM) {
      // Il gruppo 1 può includere ` "title"` — canonicalizza a `/agenzie/<slug>/`.
      agency_slug = agencyM[2];
      agency_url = `https://www.casa.it/agenzie/${agency_slug}/`;
      const before = block.slice(0, agencyM.index!);
      const nameM = before.match(AGENCY_NAME_BEFORE_RE);
      if (nameM) {
        agency_name = nameM[1].trim();
      } else {
        // fallback: slug -> nome (strip trailing -\d+ id, title case)
        agency_name = agency_slug
          .replace(/-\d+$/, "")
          .split("-")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");
      }
    }
    const is_privato = !agencyM;

    // badge: cerca in linee prima del titolo (max 3 linee indietro nel md globale)
    const beforeStart = Math.max(0, a.offset - 200);
    const before = markdown.slice(beforeStart, a.offset);
    const badgeM = before.match(BADGE_RE);
    const badge = badgeM ? badgeM[1] : null;

    const tierM = block.match(TIER_RE);
    const tier = tierM ? tierM[1] : null;

    const parsed: ParsedCasaListing = {
      listing_id: a.id,
      source_url: `https://www.casa.it/immobili/${a.id}/`,
      title: a.title.trim() || null,
      zone: zone ?? null,
      price_eur,
      surface_sqm: surfM ? Number(surfM[1]) : null,
      rooms: roomsM ? Number(roomsM[1]) : null,
      bathrooms: bathM ? Number(bathM[1]) : null,
      floor: floorM ? floorM[1] : null,
      energy_class: energyM ? energyM[1] : null,
      description,
      agency_name,
      agency_slug,
      agency_url,
      is_privato,
      badge,
      tier,
      raw_block: block.slice(0, 2000),
    };

    // dedup: tieni quello con più campi popolati
    const existing = byId.get(a.id);
    if (!existing) {
      byId.set(a.id, parsed);
    } else {
      const score = (p: ParsedCasaListing) =>
        (p.price_eur ? 2 : 0) +
        (p.surface_sqm ? 1 : 0) +
        (p.agency_slug ? 2 : 0) +
        (p.description ? 1 : 0);
      if (score(parsed) > score(existing)) byId.set(a.id, parsed);
    }
  }

  // touch sourceUrlFallback to keep param semantics if needed in future
  void sourceUrlFallback;

  return Array.from(byId.values());
}
