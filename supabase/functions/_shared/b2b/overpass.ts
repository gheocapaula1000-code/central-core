// Overpass / OpenStreetMap provider for b2b-finder.
// Free, no API key. Strict timeout + 1 retry.

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

// Safe bbox for the city of Padova (south, west, north, east).
// Tight enough to avoid the whole province in v1.
export const PADOVA_BBOX: [number, number, number, number] = [
  45.36, 11.80, 45.45, 11.95,
];

const CATEGORIES = [
  "restaurant",
  "cafe",
  "bar",
  "fast_food",
  "pub",
  "food_court",
] as const;

export type OverpassCategory = typeof CATEGORIES[number];

export interface OverpassPoi {
  osm_id: string;
  type: "node" | "way" | "relation";
  category: OverpassCategory | string;
  name: string | null;
  lat: number | null;
  lng: number | null;
  tags: Record<string, string>;
}

function buildQuery(bbox: [number, number, number, number]): string {
  const [s, w, n, e] = bbox;
  const parts = CATEGORIES.map(
    (c) =>
      `  node["amenity"="${c}"](${s},${w},${n},${e});\n  way["amenity"="${c}"](${s},${w},${n},${e});\n  relation["amenity"="${c}"](${s},${w},${n},${e});`,
  ).join("\n");
  return `[out:json][timeout:20];\n(\n${parts}\n);\nout center tags;`;
}

async function fetchWithTimeout(
  url: string,
  body: string,
  ms: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

export async function queryOverpass(
  bbox: [number, number, number, number],
  timeoutMs = 25000,
): Promise<OverpassPoi[]> {
  const q = buildQuery(bbox);
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < ENDPOINTS.length; attempt++) {
    const url = ENDPOINTS[attempt];
    try {
      const res = await fetchWithTimeout(url, q, timeoutMs);
      if (!res.ok) {
        await res.text().catch(() => "");
        lastErr = new Error(`overpass http ${res.status}`);
        // brief backoff on rate-limit / server errors before next endpoint
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, 400));
        }
        continue;
      }
      const json = await res.json();
      const elements: any[] = Array.isArray(json?.elements) ? json.elements : [];
      return elements
        .map((el): OverpassPoi | null => {
          const tags = (el?.tags ?? {}) as Record<string, string>;
          const cat = tags.amenity ?? "unknown";
          const lat = el?.lat ?? el?.center?.lat ?? null;
          const lng = el?.lon ?? el?.center?.lon ?? null;
          return {
            osm_id: `${el.type}/${el.id}`,
            type: el.type,
            category: cat,
            name: tags.name ?? null,
            lat: typeof lat === "number" ? lat : null,
            lng: typeof lng === "number" ? lng : null,
            tags,
          };
        })
        .filter((x): x is OverpassPoi => !!x && !!x.name);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("overpass failed");
}
