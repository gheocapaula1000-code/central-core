// ═══════════════════════════════════════════════════════════════
// Padova microzone matcher — Central Core
//
// Mirrors the 20 microzone labels exposed by AcquisitionRadar.
// Matching strategy is keyword-based on the text fields we already
// have on zones/opportunities (comune, quartiere, zona, indirizzo,
// OMI zona, headline/whyNow/script text). When no signal is strong
// enough, we tag `microzone_match = "unknown"` and never invent a
// microzone label.
//
// Hard rules:
//   - never fake precision (no microzone unless real evidence)
//   - never expose internal keyword lists / provider details
//   - lat/lng are accepted but only used as a coarse hint, because
//     Central Core does NOT yet hold microzone polygons for Padova
// ═══════════════════════════════════════════════════════════════

export type PadovaMicrozoneId =
  | "centro_storico_santo"
  | "portello_universita"
  | "stazione_fiera"
  | "arcella"
  | "san_carlo_san_bellino"
  | "mortise_torre"
  | "forcellini_terranegra"
  | "citta_giardino_santa_croce"
  | "guizza"
  | "mandria_paltana"
  | "brentelle_chiesanuova"
  | "sacra_famiglia_palestro"
  | "brusegana"
  | "voltabrusegana"
  | "ponte_di_brenta"
  | "camin_granze"
  | "zona_industriale_interporto"
  | "salboro"
  | "pontevigodarzere"
  | "altichiero_monta";

export interface PadovaMicrozoneDef {
  id: PadovaMicrozoneId;
  /** Canonical label used by AcquisitionRadar (must match 1:1). */
  label: string;
  /** Lower-case keyword tokens used to detect this microzone in text. */
  keywords: string[];
  /** Common OMI zone codes seen for this microzone (optional hint). */
  omiZones?: string[];
}

export const PADOVA_MICROZONES: ReadonlyArray<PadovaMicrozoneDef> = [
  {
    id: "centro_storico_santo",
    label: "Centro Storico / Santo",
    keywords: ["centro storico", "il santo", "basilica del santo", "prato della valle", "duomo", "piazza delle erbe", "piazza dei signori", "via roma", "via vlacovich", "via belzoni"],
    omiZones: ["B1", "B2"],
  },
  {
    id: "portello_universita",
    label: "Portello / Università",
    keywords: ["portello", "università", "universita", "via venezia", "via marzolo", "via loredan", "via trieste", "ospedale", "via giustiniani"],
    omiZones: ["B3", "C1"],
  },
  {
    id: "stazione_fiera",
    label: "Stazione / Fiera",
    keywords: ["stazione", "fiera", "padovafiere", "via tommaseo", "via gozzi", "piazzale stazione", "via niccolò tommaseo"],
  },
  {
    id: "arcella",
    label: "Arcella",
    keywords: ["arcella", "via tiziano aspetti", "via reni", "via guido reni", "via curzola", "via vicenza"],
  },
  {
    id: "san_carlo_san_bellino",
    label: "San Carlo / San Bellino",
    keywords: ["san carlo", "san bellino", "san bellinoo", "via po", "via plebiscito"],
  },
  {
    id: "mortise_torre",
    label: "Mortise / Torre",
    keywords: ["mortise", "torre", "san lazzaro", "via san marco"],
  },
  {
    id: "forcellini_terranegra",
    label: "Forcellini / Terranegra",
    keywords: ["forcellini", "terranegra", "via forcellini", "via canestrini", "via guasti"],
  },
  {
    id: "citta_giardino_santa_croce",
    label: "Città Giardino / Santa Croce",
    keywords: ["città giardino", "citta giardino", "santa croce", "via tassoni", "via dei colli"],
  },
  {
    id: "guizza",
    label: "Guizza",
    keywords: ["guizza", "via guizza", "via romana aponense"],
  },
  {
    id: "mandria_paltana",
    label: "Mandria / Paltana",
    keywords: ["mandria", "paltana", "via mandria", "via paltana"],
  },
  {
    id: "brentelle_chiesanuova",
    label: "Brentelle / Chiesanuova",
    keywords: ["brentelle", "chiesanuova", "via chiesanuova", "via brentelle"],
  },
  {
    id: "sacra_famiglia_palestro",
    label: "Sacra Famiglia / Palestro",
    keywords: ["sacra famiglia", "palestro", "via palestro", "via boito"],
  },
  {
    id: "brusegana",
    label: "Brusegana",
    keywords: ["brusegana", "via sorio", "via dei colli brusegana"],
  },
  {
    id: "voltabrusegana",
    label: "Voltabrusegana",
    keywords: ["voltabrusegana", "volta brusegana"],
  },
  {
    id: "ponte_di_brenta",
    label: "Ponte di Brenta",
    keywords: ["ponte di brenta", "via bragni", "via pontevigodarzere brenta"],
  },
  {
    id: "camin_granze",
    label: "Camin / Granze",
    keywords: ["camin", "granze", "via vigonovese"],
  },
  {
    id: "zona_industriale_interporto",
    label: "Zona Industriale / Interporto",
    keywords: ["zona industriale", "interporto", "via uruguay", "via venezuela", "via argentina"],
  },
  {
    id: "salboro",
    label: "Salboro",
    keywords: ["salboro", "via salboro"],
  },
  {
    id: "pontevigodarzere",
    label: "Pontevigodarzere",
    keywords: ["pontevigodarzere", "ponte vigodarzere", "via pontevigodarzere"],
  },
  {
    id: "altichiero_monta",
    label: "Altichiero / Montà",
    keywords: ["altichiero", "montà", "monta", "via altichiero", "via monta"],
  },
];

const LABEL_TO_ID = new Map<string, PadovaMicrozoneId>(
  PADOVA_MICROZONES.map((m) => [m.label.toLowerCase().trim(), m.id]),
);
const ID_TO_DEF = new Map<PadovaMicrozoneId, PadovaMicrozoneDef>(
  PADOVA_MICROZONES.map((m) => [m.id, m]),
);

/** Normalize an incoming list of microzone labels (or ids) to canonical ids.
 *  Unknown values are dropped silently (no fake matches). */
export function normalizeRequestedMicrozones(input: unknown): PadovaMicrozoneId[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<PadovaMicrozoneId>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const key = raw.toLowerCase().trim();
    if (!key) continue;
    const byLabel = LABEL_TO_ID.get(key);
    if (byLabel) { out.add(byLabel); continue; }
    if (ID_TO_DEF.has(key as PadovaMicrozoneId)) out.add(key as PadovaMicrozoneId);
  }
  return [...out];
}

export type MicrozoneMatchMethod =
  | "label_explicit"
  | "indirizzo_keyword"
  | "omi_zone"
  | "text_keyword"
  | "none";

export type MicrozoneMatchConfidence = "high" | "medium" | "low" | "unknown";

export interface MicrozoneMatchResult {
  microzone: string | null;          // canonical label or null
  microzone_id: PadovaMicrozoneId | null;
  microzone_match: "matched" | "unknown";
  microzone_match_confidence: MicrozoneMatchConfidence;
  microzone_match_method: MicrozoneMatchMethod;
}

const UNKNOWN: MicrozoneMatchResult = {
  microzone: null, microzone_id: null,
  microzone_match: "unknown",
  microzone_match_confidence: "unknown",
  microzone_match_method: "none",
};

export interface MatchableItem {
  comune?: string | null;
  provincia?: string | null;
  quartiere?: string | null;
  zona?: string | null;
  indirizzo?: string | null;
  address?: string | null;
  omiZone?: string | null;
  /** Free-form text fields (headline/whyNow/script/title/reason). */
  text?: Array<string | null | undefined>;
  /** Optional explicit label sent by upstream (already canonical). */
  microzoneLabel?: string | null;
  lat?: number | null;
  lng?: number | null;
}

function isPadova(item: MatchableItem): boolean {
  const c = (item.comune ?? "").toLowerCase().trim();
  const p = (item.provincia ?? "").toLowerCase().trim();
  if (c === "padova") return true;
  // Coarse bbox for Padova città (defensive — never used to invent a microzone).
  if (typeof item.lat === "number" && typeof item.lng === "number") {
    if (item.lat >= 45.34 && item.lat <= 45.46 && item.lng >= 11.78 && item.lng <= 11.96 && (p === "pd" || p === "padova" || !p)) {
      return true;
    }
  }
  return false;
}

/** Pure matcher — does NOT mutate input. Returns UNKNOWN if no strong signal. */
export function matchPadovaMicrozone(item: MatchableItem): MicrozoneMatchResult {
  if (!isPadova(item)) return UNKNOWN;

  // 1) Upstream already gave us a canonical label → trust it (high).
  if (item.microzoneLabel) {
    const id = LABEL_TO_ID.get(item.microzoneLabel.toLowerCase().trim());
    if (id) {
      const def = ID_TO_DEF.get(id)!;
      return { microzone: def.label, microzone_id: id, microzone_match: "matched", microzone_match_confidence: "high", microzone_match_method: "label_explicit" };
    }
  }

  const indirizzo = `${item.indirizzo ?? ""} ${item.address ?? ""} ${item.quartiere ?? ""} ${item.zona ?? ""}`.toLowerCase();
  const text = (item.text ?? []).filter(Boolean).join(" ").toLowerCase();
  const omi = (item.omiZone ?? "").toUpperCase().trim();

  // 2) Indirizzo / quartiere / zona keyword hit → high.
  for (const def of PADOVA_MICROZONES) {
    if (def.keywords.some((kw) => indirizzo.includes(kw))) {
      return { microzone: def.label, microzone_id: def.id, microzone_match: "matched", microzone_match_confidence: "high", microzone_match_method: "indirizzo_keyword" };
    }
  }

  // 3) OMI zone exact match → medium (zone codes cover multiple toponyms).
  if (omi) {
    const hits = PADOVA_MICROZONES.filter((m) => m.omiZones?.includes(omi));
    if (hits.length === 1) {
      return { microzone: hits[0].label, microzone_id: hits[0].id, microzone_match: "matched", microzone_match_confidence: "medium", microzone_match_method: "omi_zone" };
    }
  }

  // 4) Free-text keyword hit → low (commercial copy is noisy).
  if (text) {
    for (const def of PADOVA_MICROZONES) {
      if (def.keywords.some((kw) => text.includes(kw))) {
        return { microzone: def.label, microzone_id: def.id, microzone_match: "matched", microzone_match_confidence: "low", microzone_match_method: "text_keyword" };
      }
    }
  }

  return UNKNOWN;
}

export interface MicrozoneAnnotated<T> {
  item: T;
  match: MicrozoneMatchResult;
}

/** Annotate + filter. If `selectedIds` empty → annotate only (no filter).
 *  If non-empty → keep only items matched to one of the selected microzones
 *  (unknowns are dropped from the kept set, but returned in `droppedUnknown`). */
export function applyPadovaMicrozoneFilter<T extends MatchableItem>(
  items: T[],
  selectedIds: PadovaMicrozoneId[],
): {
  kept: Array<T & MicrozoneMatchResult>;
  droppedUnknown: number;
  droppedNonMatching: number;
  matchedCounts: Record<string, number>;
} {
  const matchedCounts: Record<string, number> = {};
  let droppedUnknown = 0;
  let droppedNonMatching = 0;
  const kept: Array<T & MicrozoneMatchResult> = [];

  const selectedSet = new Set(selectedIds);
  for (const it of items) {
    const m = matchPadovaMicrozone(it);
    if (m.microzone_id) matchedCounts[m.microzone_id] = (matchedCounts[m.microzone_id] ?? 0) + 1;

    if (selectedSet.size === 0) {
      kept.push({ ...it, ...m });
      continue;
    }
    if (m.microzone_id && selectedSet.has(m.microzone_id)) {
      kept.push({ ...it, ...m });
    } else if (m.microzone_match === "unknown") {
      droppedUnknown++;
    } else {
      droppedNonMatching++;
    }
  }
  return { kept, droppedUnknown, droppedNonMatching, matchedCounts };
}
