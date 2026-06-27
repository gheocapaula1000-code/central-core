// Overpass / OpenStreetMap provider for b2b-finder.
// Free, no API key. Strict timeout + 1 retry.
// Supports two search_mode:
//   - "clients"   → food/horeca amenity categories (existing behaviour)
//   - "resellers" → shop/wholesale categories + name regex per ingrosso/horeca

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

// Safe bbox for the city of Padova (south, west, north, east).
export const PADOVA_BBOX: [number, number, number, number] = [
  45.36, 11.80, 45.45, 11.95,
];

// ── Clients (food/horeca end-users) ────────────────────────────────────────
const CLIENT_CATEGORIES = [
  "restaurant",
  "cafe",
  "bar",
  "fast_food",
  "pub",
  "food_court",
] as const;

// ── Resellers (B2B distribution, wholesale, retail of houseware) ───────────
const RESELLER_SHOPS = [
  "wholesale",
  "houseware",
  "hardware",
  "department_store",
  "supermarket",
  "trade",
  "doityourself",
  "variety_store",
  "party",
  "interior_decoration",
  "convenience",
] as const;

// OSM name regex to catch businesses like "Ingrosso ...", "Cash and Carry ...",
// "Forniture Horeca ...", "Articoli per Ristorazione ..." etc.
const RESELLER_NAME_REGEX =
  "ingrosso|cash and carry|cash & carry|c&c|forniture|horeca|grossist|" +
  "distribut|monouso|packaging|casaling|articoli per ristorant|" +
  "articoli per bar|articoli per pizzer|catering|tovagliato|biancheria";

// ── Suppliers (produttori / importatori / grossisti / distributori) ────────
// Tag OSM tipici: industrial=*, office=company, craft=*, shop=wholesale, man_made=works
const SUPPLIER_SHOPS = ["wholesale", "trade"] as const;
const SUPPLIER_INDUSTRIAL = ["paper", "packaging", "manufacturing", "factory", "warehouse"] as const;
const SUPPLIER_OFFICES = ["company", "wholesale", "logistics", "it"] as const;

// Regex molto orientata al mondo carta/tovagliato/monouso/horeca distribuzione.
const SUPPLIER_NAME_REGEX =
  "produttor|produzione|manifattur|fabbric|stabilimento|" +
  "import|importator|importatori|" +
  "grossist|ingrosso|cash and carry|cash & carry|c&c|" +
  "distribut|distribuzione|logistic|" +
  "carta|paper|tissue|airlaid|tnt|tessuto non tessuto|monouso|" +
  "tovagli|portaposate|packaging|imballagg|" +
  "horeca|fornitur|forniture";

export type OverpassCategory = (typeof CLIENT_CATEGORIES)[number] | string;
export type SearchMode = "clients" | "resellers" | "suppliers";

export interface OverpassPoi {
  osm_id: string;
  type: "node" | "way" | "relation";
  category: OverpassCategory; // amenity if clients, shop if resellers, else "unknown"
  name: string | null;
  lat: number | null;
  lng: number | null;
  tags: Record<string, string>;
}

function buildClientQuery(bbox: [number, number, number, number]): string {
  const [s, w, n, e] = bbox;
  const parts = CLIENT_CATEGORIES.map(
    (c) =>
      `  node["amenity"="${c}"](${s},${w},${n},${e});\n  way["amenity"="${c}"](${s},${w},${n},${e});\n  relation["amenity"="${c}"](${s},${w},${n},${e});`,
  ).join("\n");
  return `[out:json][timeout:20];\n(\n${parts}\n);\nout center tags;`;
}

function buildResellerQuery(bbox: [number, number, number, number]): string {
  const [s, w, n, e] = bbox;
  const shopParts = RESELLER_SHOPS.map(
    (c) =>
      `  node["shop"="${c}"](${s},${w},${n},${e});\n  way["shop"="${c}"](${s},${w},${n},${e});\n  relation["shop"="${c}"](${s},${w},${n},${e});`,
  ).join("\n");
  // Any node tagged as shop/office/craft/industrial with a name that screams "wholesale/horeca"
  const re = RESELLER_NAME_REGEX;
  const namedParts = [
    `  node["name"~"${re}",i]["shop"](${s},${w},${n},${e});`,
    `  way["name"~"${re}",i]["shop"](${s},${w},${n},${e});`,
    `  node["name"~"${re}",i]["office"](${s},${w},${n},${e});`,
    `  way["name"~"${re}",i]["office"](${s},${w},${n},${e});`,
    `  node["name"~"${re}",i]["craft"](${s},${w},${n},${e});`,
    `  way["name"~"${re}",i]["craft"](${s},${w},${n},${e});`,
    `  node["name"~"${re}",i]["industrial"](${s},${w},${n},${e});`,
    `  way["name"~"${re}",i]["industrial"](${s},${w},${n},${e});`,
  ].join("\n");
  return `[out:json][timeout:25];\n(\n${shopParts}\n${namedParts}\n);\nout center tags;`;
}

function buildSupplierQuery(bbox: [number, number, number, number]): string {
  const [s, w, n, e] = bbox;
  const shopParts = SUPPLIER_SHOPS.map(
    (c) =>
      `  node["shop"="${c}"](${s},${w},${n},${e});\n  way["shop"="${c}"](${s},${w},${n},${e});\n  relation["shop"="${c}"](${s},${w},${n},${e});`,
  ).join("\n");
  const industrialParts = SUPPLIER_INDUSTRIAL.map(
    (c) =>
      `  node["industrial"="${c}"](${s},${w},${n},${e});\n  way["industrial"="${c}"](${s},${w},${n},${e});\n  relation["industrial"="${c}"](${s},${w},${n},${e});`,
  ).join("\n");
  const officeParts = SUPPLIER_OFFICES.map(
    (c) =>
      `  node["office"="${c}"](${s},${w},${n},${e});\n  way["office"="${c}"](${s},${w},${n},${e});`,
  ).join("\n");
  // Catch-all by name regex su qualunque attività con shop/office/industrial/craft.
  const re = SUPPLIER_NAME_REGEX;
  const namedParts = [
    `  node["name"~"${re}",i]["shop"](${s},${w},${n},${e});`,
    `  way["name"~"${re}",i]["shop"](${s},${w},${n},${e});`,
    `  node["name"~"${re}",i]["office"](${s},${w},${n},${e});`,
    `  way["name"~"${re}",i]["office"](${s},${w},${n},${e});`,
    `  node["name"~"${re}",i]["craft"](${s},${w},${n},${e});`,
    `  way["name"~"${re}",i]["craft"](${s},${w},${n},${e});`,
    `  node["name"~"${re}",i]["industrial"](${s},${w},${n},${e});`,
    `  way["name"~"${re}",i]["industrial"](${s},${w},${n},${e});`,
    `  node["name"~"${re}",i]["man_made"="works"](${s},${w},${n},${e});`,
    `  way["name"~"${re}",i]["man_made"="works"](${s},${w},${n},${e});`,
    `  node["name"~"${re}",i]["landuse"="industrial"](${s},${w},${n},${e});`,
    `  way["name"~"${re}",i]["landuse"="industrial"](${s},${w},${n},${e});`,
  ].join("\n");
  return `[out:json][timeout:25];\n(\n${shopParts}\n${industrialParts}\n${officeParts}\n${namedParts}\n);\nout center tags;`;
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
  searchMode: SearchMode = "clients",
): Promise<OverpassPoi[]> {
  const q = searchMode === "suppliers"
    ? buildSupplierQuery(bbox)
    : searchMode === "resellers"
      ? buildResellerQuery(bbox)
      : buildClientQuery(bbox);
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < ENDPOINTS.length; attempt++) {
    const url = ENDPOINTS[attempt];
    try {
      const res = await fetchWithTimeout(url, q, timeoutMs);
      if (!res.ok) {
        await res.text().catch(() => "");
        lastErr = new Error(`overpass http ${res.status}`);
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
          // Category preference per mode: shop>amenity>office>craft for resellers,
          // amenity>shop for clients.
          let cat = "unknown";
          if (searchMode === "resellers") {
            cat = tags.shop ?? tags.office ?? tags.craft ?? tags.industrial ?? tags.amenity ?? "unknown";
          } else {
            cat = tags.amenity ?? tags.shop ?? "unknown";
          }
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
