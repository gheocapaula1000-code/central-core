// Sottra — OSM / Overpass neighborhood POIs
//
// Named places only (name / name:it). Fail-closed: Overpass errors become
// unavailable — never invent names, scores, or distances.

export const OSM_POI_RADIUS_M = 800;
export const OSM_POI_SOURCE_LABEL = "OpenStreetMap / Overpass — servizi di prossimità";

export type OsmPoiTipo =
  | "scuole"
  | "asili"
  | "chiese"
  | "farmacie"
  | "supermercati"
  | "convenience";

export type OsmPoiSourceType = "official" | "unavailable";

export interface NearbyOsmPoi {
  name: string;
  category: string;
  categoryLabel: string;
  tipo: OsmPoiTipo;
  distance: number;
  lat: number;
  lng: number;
  provider: "overpass";
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
  sourceProvider: "overpass";
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

export function unavailableOsmPois(reason: string, radius = OSM_POI_RADIUS_M): OsmPoiResult {
  return {
    found: false,
    sourceType: "unavailable",
    sourceLabel: OSM_POI_SOURCE_LABEL,
    sourceProvider: "overpass",
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

function buildOverpassQuery(lat: number, lng: number, radius: number): string {
  const filters = TAG_RULES.flatMap((rule) => [
    `node(around:${radius},${lat},${lng})[${rule.key}=${rule.value}];`,
    `way(around:${radius},${lat},${lng})[${rule.key}=${rule.value}];`,
  ]).join("\n");
  return `[out:json][timeout:12];(\n${filters}\n);out center tags;`;
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

function buildNamedPois(
  elements: Record<string, unknown>[],
  lat: number,
  lng: number,
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
      provider: "overpass",
      osmId,
    });
  }
  return pois;
}

export function assembleOsmPoiResult(
  elements: Record<string, unknown>[],
  lat: number,
  lng: number,
  radius = OSM_POI_RADIUS_M,
): OsmPoiResult {
  const raw = buildNamedPois(elements, lat, lng)
    .filter((p) => p.distance <= radius)
    .sort((a, b) => a.distance - b.distance);

  const seen = new Set<string>();
  const unique = raw.filter((p) => {
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
    );
  }

  return {
    found: true,
    sourceType: "official",
    sourceLabel: OSM_POI_SOURCE_LABEL,
    sourceProvider: "overpass",
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
      `Luoghi con nome in OpenStreetMap entro ${radius} m — non è un elenco ufficiale comunale`,
      "Categorie: scuole, asili, chiese, farmacie, supermercati, alimentari/convenience",
    ],
  };
}

/** Query Overpass around a GPS point. Fail-closed on network / parser errors. */
export async function lookupOsmNeighborhoodPois(
  lat: number,
  lng: number,
  radius = OSM_POI_RADIUS_M,
): Promise<OsmPoiResult> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return unavailableOsmPois("Coordinate non valide — POI OSM non interrogati", radius);
  }
  try {
    const elements = await fetchOverpass(buildOverpassQuery(lat, lng, radius), 13_000);
    return assembleOsmPoiResult(elements, lat, lng, radius);
  } catch {
    return unavailableOsmPois(
      "OpenStreetMap / Overpass non disponibile — elenco servizi non pubblicato",
      radius,
    );
  }
}
