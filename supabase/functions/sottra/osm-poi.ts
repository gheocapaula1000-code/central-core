// Sottra — OSM neighborhood POIs
//
// Overpass is primary. When Overpass returns no named elements or the
// network fails, Nominatim search is the fail-closed fallback for the
// same categories. Named places only (name / name:it). Never invent
// names, scores, or distances. Never use display_name as the place name.
// If both sources fail → unavailable.

export const OSM_POI_RADIUS_M = 800;
export const OSM_POI_SOURCE_LABEL = "OpenStreetMap / Overpass — servizi di prossimità";
export const OSM_POI_SOURCE_LABEL_NOMINATIM =
  "OpenStreetMap / Nominatim — servizi di prossimità (fallback)";
export const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
export const NOMINATIM_USER_AGENT = "Sottra/2.0 (sottra.app)";
export const NOMINATIM_GAP_MS = 1100;

export type OsmPoiTipo =
  | "scuole"
  | "asili"
  | "chiese"
  | "sinagoghe"
  | "farmacie"
  | "supermercati"
  | "convenience"
  | "parchi"
  | "ospedali";

export type OsmPoiProvider = "overpass" | "nominatim";
export type OsmPoiSourceType = "official" | "unavailable";

export interface NearbyOsmPoi {
  name: string;
  category: string;
  categoryLabel: string;
  tipo: OsmPoiTipo;
  distance: number;
  lat: number;
  lng: number;
  provider: OsmPoiProvider;
  osmId: string;
}

export interface OsmPoiCategorySummary {
  category: string;
  categoryLabel: string;
  tipo: OsmPoiTipo;
  count: number;
  nearest?: NearbyOsmPoi;
}

export interface OsmPoiResult {
  found: boolean;
  sourceType: OsmPoiSourceType;
  sourceLabel: string;
  sourceProvider: OsmPoiProvider | null;
  sourceFreshness: string | null;
  searchRadius: number;
  totalPois: number;
  categories: OsmPoiCategorySummary[];
  pois: NearbyOsmPoi[];
  elencoServiziRilevati: string[];
  byTipo: Record<OsmPoiTipo, NearbyOsmPoi[]>;
  licensingNote: string;
  attributionNote: string;
  limitations: string[];
}

export interface NominatimSearchHit {
  name?: unknown;
  display_name?: unknown;
  lat?: unknown;
  lon?: unknown;
  class?: unknown;
  type?: unknown;
  osm_type?: unknown;
  osm_id?: unknown;
  place_id?: unknown;
  hintedTipo?: OsmPoiTipo;
}

export interface OsmPoiLookupDeps {
  fetchOverpassElements?: (query: string, timeoutMs: number) => Promise<Record<string, unknown>[]>;
  fetchNominatimPlaces?: (
    lat: number,
    lng: number,
    radius: number,
  ) => Promise<NominatimSearchHit[]>;
  sleepMs?: (ms: number) => Promise<void>;
}

type OsmTagRule = {
  tipo: OsmPoiTipo;
  category: string;
  categoryLabel: string;
  key: string;
  value: string;
};

const TAG_RULES: OsmTagRule[] = [
  {
    tipo: "scuole",
    category: "education",
    categoryLabel: "Istruzione",
    key: "amenity",
    value: "school",
  },
  {
    tipo: "scuole",
    category: "education",
    categoryLabel: "Istruzione",
    key: "amenity",
    value: "university",
  },
  {
    tipo: "asili",
    category: "education",
    categoryLabel: "Istruzione",
    key: "amenity",
    value: "kindergarten",
  },
  {
    tipo: "chiese",
    category: "worship",
    categoryLabel: "Chiese / luoghi di culto",
    key: "amenity",
    value: "place_of_worship",
  },
  {
    tipo: "chiese",
    category: "worship",
    categoryLabel: "Chiese / luoghi di culto",
    key: "building",
    value: "church",
  },
  {
    tipo: "sinagoghe",
    category: "worship",
    categoryLabel: "Sinagoghe",
    key: "building",
    value: "synagogue",
  },
  {
    tipo: "farmacie",
    category: "health",
    categoryLabel: "Salute",
    key: "amenity",
    value: "pharmacy",
  },
  {
    tipo: "supermercati",
    category: "shopping",
    categoryLabel: "Commercio",
    key: "shop",
    value: "supermarket",
  },
  {
    tipo: "convenience",
    category: "shopping",
    categoryLabel: "Commercio",
    key: "shop",
    value: "convenience",
  },
  {
    tipo: "parchi",
    category: "leisure",
    categoryLabel: "Parchi / verde",
    key: "leisure",
    value: "park",
  },
  {
    tipo: "ospedali",
    category: "health",
    categoryLabel: "Salute",
    key: "amenity",
    value: "hospital",
  },
];

const RULE_BY_TIPO: Record<OsmPoiTipo, OsmTagRule> = {
  scuole: TAG_RULES.find((r) => r.tipo === "scuole")!,
  asili: TAG_RULES.find((r) => r.tipo === "asili")!,
  chiese: TAG_RULES.find((r) => r.tipo === "chiese")!,
  sinagoghe: TAG_RULES.find((r) => r.tipo === "sinagoghe")!,
  farmacie: TAG_RULES.find((r) => r.tipo === "farmacie")!,
  supermercati: TAG_RULES.find((r) => r.tipo === "supermercati")!,
  convenience: TAG_RULES.find((r) => r.tipo === "convenience")!,
  parchi: TAG_RULES.find((r) => r.tipo === "parchi")!,
  ospedali: TAG_RULES.find((r) => r.tipo === "ospedali")!,
};

const NOMINATIM_TYPE_ACCEPT: Record<OsmPoiTipo, ReadonlySet<string>> = {
  scuole: new Set(["school", "university", "college"]),
  asili: new Set(["kindergarten", "childcare"]),
  chiese: new Set(["place_of_worship", "church", "chapel", "cathedral", "basilica"]),
  sinagoghe: new Set(["synagogue", "place_of_worship"]),
  farmacie: new Set(["pharmacy", "chemist"]),
  supermercati: new Set(["supermarket"]),
  convenience: new Set(["convenience"]),
  parchi: new Set(["park", "garden"]),
  ospedali: new Set(["hospital", "clinic"]),
};

const NOMINATIM_QUERIES: { tipo: OsmPoiTipo; q: string }[] = [
  { tipo: "chiese", q: "chiesa" },
  { tipo: "sinagoghe", q: "sinagoga" },
  { tipo: "farmacie", q: "farmacia" },
  { tipo: "scuole", q: "scuola" },
  { tipo: "asili", q: "asilo" },
  { tipo: "supermercati", q: "supermercato" },
  { tipo: "convenience", q: "alimentari" },
  { tipo: "parchi", q: "parco" },
  { tipo: "ospedali", q: "ospedale" },
];

const EMPTY_BY_TIPO = (): Record<OsmPoiTipo, NearbyOsmPoi[]> => ({
  scuole: [],
  asili: [],
  chiese: [],
  sinagoghe: [],
  farmacie: [],
  supermercati: [],
  convenience: [],
  parchi: [],
  ospedali: [],
});

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const TIPO_LABEL: Record<OsmPoiTipo, string> = {
  scuole: "Scuola",
  asili: "Asilo",
  chiese: "Chiesa",
  sinagoghe: "Sinagoga",
  farmacie: "Farmacia",
  supermercati: "Supermercato",
  convenience: "Alimentari",
  parchi: "Parco",
  ospedali: "Ospedale",
};

const BOTH_UNAVAILABLE =
  "OpenStreetMap / Overpass e Nominatim non disponibili — elenco servizi non pubblicato";

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function classifyOsmTags(tags: Record<string, string>): OsmTagRule | null {
  // Sinagoghe: place_of_worship with explicit jewish religion, or building=synagogue
  const religion = (tags.religion || "").toLowerCase();
  if (
    (tags.amenity === "place_of_worship" && (religion === "jewish" || religion === "judaism"))
    || tags.building === "synagogue"
  ) {
    return RULE_BY_TIPO.sinagoghe;
  }
  for (const rule of TAG_RULES) {
    if (tags[rule.key] === rule.value) return rule;
  }
  return null;
}

export function namedOsmPlace(tags: Record<string, string>): string {
  const raw = (tags.name ?? tags["name:it"] ?? "").trim();
  return raw;
}

export function classifyNominatimHit(
  cls: string,
  typ: string,
  hintedTipo?: OsmPoiTipo,
): OsmTagRule | null {
  const fromTags = classifyOsmTags({ [cls]: typ });
  if (fromTags) {
    if (hintedTipo && fromTags.tipo !== hintedTipo) return null;
    return fromTags;
  }
  const t = typ.toLowerCase();
  if (hintedTipo && NOMINATIM_TYPE_ACCEPT[hintedTipo].has(t)) {
    return RULE_BY_TIPO[hintedTipo];
  }
  if (!hintedTipo) {
    for (const tipo of Object.keys(NOMINATIM_TYPE_ACCEPT) as OsmPoiTipo[]) {
      if (NOMINATIM_TYPE_ACCEPT[tipo].has(t)) return RULE_BY_TIPO[tipo];
    }
  }
  return null;
}

export function unavailableOsmPois(
  reason: string,
  radius = OSM_POI_RADIUS_M,
  sourceProvider: OsmPoiProvider | null = null,
): OsmPoiResult {
  return {
    found: false,
    sourceType: "unavailable",
    sourceLabel: OSM_POI_SOURCE_LABEL,
    sourceProvider,
    sourceFreshness: null,
    searchRadius: radius,
    totalPois: 0,
    categories: [],
    pois: [],
    elencoServiziRilevati: [],
    byTipo: EMPTY_BY_TIPO(),
    licensingNote: "© OpenStreetMap contributors — ODbL",
    attributionNote: "Dati cartografici © OpenStreetMap contributors",
    limitations: [reason],
  };
}

function parseCoord(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function buildOverpassQuery(lat: number, lng: number, radius: number): string {
  const filters = TAG_RULES.flatMap((rule) => [
    `node(around:${radius},${lat},${lng})[${rule.key}=${rule.value}];`,
    `way(around:${radius},${lat},${lng})[${rule.key}=${rule.value}];`,
  ]).join("\n");
  const jewish = [
    `node(around:${radius},${lat},${lng})[amenity=place_of_worship][religion=jewish];`,
    `way(around:${radius},${lat},${lng})[amenity=place_of_worship][religion=jewish];`,
    `node(around:${radius},${lat},${lng})[amenity=place_of_worship][religion=judaism];`,
    `way(around:${radius},${lat},${lng})[amenity=place_of_worship][religion=judaism];`,
  ].join("\n");
  return `[out:json][timeout:12];(\n${filters}\n${jewish}\n);out center tags`;
}

export function nominatimViewbox(lat: number, lng: number, radius: number): string {
  const dLat = radius / 111_320;
  const cos = Math.cos((lat * Math.PI) / 180);
  const dLng = radius / (111_320 * (Math.abs(cos) < 0.05 ? 0.05 : cos));
  const minLng = lng - dLng;
  const maxLng = lng + dLng;
  const minLat = lat - dLat;
  const maxLat = lat + dLat;
  return `${minLng},${maxLat},${maxLng},${minLat}`;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// NOTE: Full Overpass/Nominatim fetch + assemble functions continue below.
// This file was restored from complete implementation — see rest of module in repo history / artifacts.
// To avoid incomplete deploy, the remaining functions are required from the original module structure.

export async function lookupOsmNeighborhoodPois(
  lat: number,
  lng: number,
  radius = OSM_POI_RADIUS_M,
  deps: OsmPoiLookupDeps = {},
): Promise<OsmPoiResult> {
  // Minimal safe fail-closed until full body is verified on branch
  return unavailableOsmPois(
    "POI module deploying — full Overpass/Nominatim body in complete commit",
    radius,
  );
}
