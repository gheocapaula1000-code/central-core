// Sottra — OSM neighborhood POIs
//
// Overpass is primary. When Overpass returns no named elements or the
// network fails, Nominatim search is the fail-closed fallback for the
// same six categories. Named places only (name / name:it). Never invent
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
  | "farmacie"
  | "supermercati"
  | "convenience";

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
];

const RULE_BY_TIPO: Record<OsmPoiTipo, OsmTagRule> = {
  scuole: TAG_RULES.find((r) => r.tipo === "scuole")!,
  asili: TAG_RULES.find((r) => r.tipo === "asili")!,
  chiese: TAG_RULES.find((r) => r.tipo === "chiese")!,
  farmacie: TAG_RULES.find((r) => r.tipo === "farmacie")!,
  supermercati: TAG_RULES.find((r) => r.tipo === "supermercati")!,
  convenience: TAG_RULES.find((r) => r.tipo === "convenience")!,
};

/** Extra Nominatim class/type values accepted per category (verified read API). */
const NOMINATIM_TYPE_ACCEPT: Record<OsmPoiTipo, ReadonlySet<string>> = {
  scuole: new Set(["school", "university", "college"]),
  asili: new Set(["kindergarten", "childcare"]),
  chiese: new Set(["place_of_worship", "church", "chapel", "cathedral", "basilica"]),
  farmacie: new Set(["pharmacy", "chemist"]),
  supermercati: new Set(["supermarket"]),
  convenience: new Set(["convenience"]),
};

const NOMINATIM_QUERIES: { tipo: OsmPoiTipo; q: string }[] = [
  { tipo: "chiese", q: "chiesa" },
  { tipo: "farmacie", q: "farmacia" },
  { tipo: "scuole", q: "scuola" },
  { tipo: "asili", q: "asilo" },
  { tipo: "supermercati", q: "supermercato" },
  { tipo: "convenience", q: "alimentari" },
];

const EMPTY_BY_TIPO = (): Record<OsmPoiTipo, NearbyOsmPoi[]> => ({
  scuole: [],
  asili: [],
  chiese: [],
  farmacie: [],
  supermercati: [],
  convenience: [],
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
  farmacie: "Farmacia",
  supermercati: "Supermercato",
  convenience: "Alimentari",
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
  return `[out:json][timeout:12];(\n${filters}\n);out center tags;`;
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

async function fetchOverpass(query: string, timeoutMs: number): Promise<Record<string, unknown>[]> {
  let lastErr: unknown = null;
  for (const url of OVERPASS_ENDPOINTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        lastErr = new Error(`overpass http ${res.status}`);
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, 350));
        }
        continue;
      }
      const json = await res.json();
      return Array.isArray(json?.elements) ? json.elements : [];
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("overpass failed");
}

async function fetchNominatimQuery(
  q: string,
  lat: number,
  lng: number,
  radius: number,
  timeoutMs: number,
): Promise<NominatimSearchHit[]> {
  const params = new URLSearchParams({
    q,
    format: "jsonv2",
    limit: "15",
    viewbox: nominatimViewbox(lat, lng, radius),
    bounded: "1",
    addressdetails: "0",
    "accept-language": "it",
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${NOMINATIM_SEARCH_URL}?${params.toString()}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": NOMINATIM_USER_AGENT,
        "Accept-Language": "it",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`nominatim http ${res.status}`);
    const json = await res.json();
    return Array.isArray(json) ? json : [];
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchNominatimPlaces(
  lat: number,
  lng: number,
  radius: number,
  sleepMs: (ms: number) => Promise<void> = defaultSleep,
): Promise<NominatimSearchHit[]> {
  const hits: NominatimSearchHit[] = [];
  let lastErr: unknown = null;
  let anyOk = false;
  for (let i = 0; i < NOMINATIM_QUERIES.length; i++) {
    if (i > 0) await sleepMs(NOMINATIM_GAP_MS);
    const { tipo, q } = NOMINATIM_QUERIES[i];
    try {
      const batch = await fetchNominatimQuery(q, lat, lng, radius, 8_000);
      anyOk = true;
      for (const hit of batch) {
        hits.push({ ...hit, hintedTipo: tipo });
      }
    } catch (e) {
      lastErr = e;
    }
  }
  if (!anyOk) throw lastErr instanceof Error ? lastErr : new Error("nominatim failed");
  return hits;
}

function buildNamedPois(
  elements: Record<string, unknown>[],
  lat: number,
  lng: number,
  provider: OsmPoiProvider,
): NearbyOsmPoi[] {
  const pois: NearbyOsmPoi[] = [];
  for (const el of elements) {
    const tags =
      el.tags && typeof el.tags === "object" && !Array.isArray(el.tags)
        ? (el.tags as Record<string, string>)
        : {};
    const rule = classifyOsmTags(tags);
    const name = namedOsmPlace(tags);
    if (!rule || !name) continue;

    const center =
      el.center && typeof el.center === "object" ? (el.center as Record<string, unknown>) : null;
    const elLat =
      typeof el.lat === "number" ? el.lat : typeof center?.lat === "number" ? center.lat : null;
    const elLng =
      typeof el.lon === "number" ? el.lon : typeof center?.lon === "number" ? center.lon : null;
    if (elLat == null || elLng == null) continue;

    const osmType = typeof el.type === "string" ? el.type : "node";
    const osmId = el.id != null ? `${osmType}/${el.id}` : `${name}:${elLat}:${elLng}`;
    pois.push({
      name,
      category: rule.category,
      categoryLabel: rule.categoryLabel,
      tipo: rule.tipo,
      distance: Math.round(haversineMeters(lat, lng, elLat, elLng)),
      lat: elLat,
      lng: elLng,
      provider,
      osmId,
    });
  }
  return pois;
}

export function parseNominatimHit(
  hit: NominatimSearchHit,
  originLat: number,
  originLng: number,
): NearbyOsmPoi | null {
  const name = typeof hit.name === "string" ? hit.name.trim() : "";
  if (!name) return null;

  const cls = typeof hit.class === "string" ? hit.class : "";
  const typ = typeof hit.type === "string" ? hit.type : "";
  const rule = classifyNominatimHit(cls, typ, hit.hintedTipo);
  if (!rule) return null;

  const elLat = parseCoord(hit.lat);
  const elLng = parseCoord(hit.lon);
  if (elLat == null || elLng == null) return null;

  const osmType = typeof hit.osm_type === "string" ? hit.osm_type : "node";
  const osmId =
    hit.osm_id != null
      ? `${osmType}/${hit.osm_id}`
      : hit.place_id != null
        ? `nominatim/${hit.place_id}`
        : `${name}:${elLat}:${elLng}`;

  return {
    name,
    category: rule.category,
    categoryLabel: rule.categoryLabel,
    tipo: rule.tipo,
    distance: Math.round(haversineMeters(originLat, originLng, elLat, elLng)),
    lat: elLat,
    lng: elLng,
    provider: "nominatim",
    osmId,
  };
}

function finalizeNamedPois(
  raw: NearbyOsmPoi[],
  radius: number,
  provider: OsmPoiProvider,
  extraLimitations: string[] = [],
): OsmPoiResult {
  const inRadius = raw.filter((p) => Number.isFinite(p.distance) && p.distance <= radius).sort((
    a,
    b,
  ) => a.distance - b.distance);

  const seen = new Set<string>();
  const unique = inRadius.filter((p) => {
    const key = `${p.tipo}:${p.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const byTipo = EMPTY_BY_TIPO();
  for (const p of unique) {
    if (byTipo[p.tipo].length < 12) byTipo[p.tipo].push(p);
  }

  const capped = Object.values(byTipo)
    .flat()
    .sort((a, b) => a.distance - b.distance);
  const catMap = new Map<string, NearbyOsmPoi[]>();
  for (const p of capped) {
    const list = catMap.get(p.category) ?? [];
    list.push(p);
    catMap.set(p.category, list);
  }
  const categories = Array.from(catMap.entries()).map(([category, items]) => ({
    category,
    categoryLabel: items[0].categoryLabel,
    tipo: items[0].tipo,
    count: items.length,
    nearest: items[0],
  }));

  const elencoServiziRilevati = capped.map((p) => `${TIPO_LABEL[p.tipo]}: ${p.name}`);

  if (capped.length === 0) {
    return unavailableOsmPois(
      "Nessun POI OSM con nome entro il raggio — non sono inventati nomi",
      radius,
      provider,
    );
  }

  const sourceLabel =
    provider === "nominatim" ? OSM_POI_SOURCE_LABEL_NOMINATIM : OSM_POI_SOURCE_LABEL;

  return {
    found: true,
    sourceType: "official",
    sourceLabel,
    sourceProvider: provider,
    sourceFreshness: new Date().toISOString().slice(0, 10),
    searchRadius: radius,
    totalPois: capped.length,
    categories,
    pois: capped.slice(0, 40),
    elencoServiziRilevati,
    byTipo,
    licensingNote: "© OpenStreetMap contributors — ODbL",
    attributionNote: "Dati cartografici © OpenStreetMap contributors",
    limitations: [
      ...extraLimitations,
      `Luoghi con nome in OpenStreetMap entro ${radius} m — non è un elenco ufficiale comunale`,
      "Categorie: scuole, asili, chiese, farmacie, supermercati, alimentari/convenience",
    ],
  };
}

export function assembleOsmPoiResult(
  elements: Record<string, unknown>[],
  lat: number,
  lng: number,
  radius = OSM_POI_RADIUS_M,
): OsmPoiResult {
  return finalizeNamedPois(buildNamedPois(elements, lat, lng, "overpass"), radius, "overpass");
}

export function assembleNominatimPoiResult(
  hits: NominatimSearchHit[],
  lat: number,
  lng: number,
  radius = OSM_POI_RADIUS_M,
): OsmPoiResult {
  const raw: NearbyOsmPoi[] = [];
  for (const hit of hits) {
    const poi = parseNominatimHit(hit, lat, lng);
    if (poi) raw.push(poi);
  }
  return finalizeNamedPois(raw, radius, "nominatim", [
    "Overpass non ha restituito POI nominati — fallback Nominatim (solo luoghi con nome)",
  ]);
}

/** Query Overpass around a GPS point. Nominatim search is the fail-closed fallback. */
export async function lookupOsmNeighborhoodPois(
  lat: number,
  lng: number,
  radius = OSM_POI_RADIUS_M,
  deps: OsmPoiLookupDeps = {},
): Promise<OsmPoiResult> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return unavailableOsmPois("Coordinate non valide — POI OSM non interrogati", radius);
  }

  const fetchOv = deps.fetchOverpassElements ?? fetchOverpass;
  const fetchNom =
    deps.fetchNominatimPlaces ??
    ((la: number, ln: number, r: number) => fetchNominatimPlaces(la, ln, r, deps.sleepMs ?? defaultSleep));

  try {
    const elements = await fetchOv(buildOverpassQuery(lat, lng, radius), 13_000);
    const assembled = assembleOsmPoiResult(elements, lat, lng, radius);
    if (assembled.found && assembled.pois.length > 0) return assembled;
  } catch {
    // Overpass network / parser failure — try Nominatim, do not invent names.
  }

  try {
    const hits = await fetchNom(lat, lng, radius);
    const assembled = assembleNominatimPoiResult(hits, lat, lng, radius);
    if (assembled.found && assembled.pois.length > 0) return assembled;
  } catch {
    // both failed
  }

  return unavailableOsmPois(BOTH_UNAVAILABLE, radius);
}
