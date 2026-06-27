// _shared/b2b/geo.ts
// Risoluzione geografica per b2b-finder: quartieri Padova + comuni PD limitrofi.
//
// Bbox format: [south, west, north, east] (compatibile con queryOverpass).
//
// IMPORTANTE: le bbox sono volutamente CONSERVATIVE (strette).
// Meglio pochi risultati corretti che molti fuori zona.

export type Bbox = [number, number, number, number];

const norm = (s: unknown): string =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// ── Padova: bbox quartieri ─────────────────────────────────────────────────
// Approssimazioni conservative, sufficienti per filtro POI Overpass.
export const PADOVA_QUARTIERI: Record<string, { bbox: Bbox; label: string; aliases: string[] }> = {
  "centro storico": {
    label: "Centro Storico",
    bbox: [45.397, 11.860, 45.420, 11.890],
    aliases: ["centro", "centro storico", "centro padova", "riviere", "xx settembre"],
  },
  "arcella": {
    label: "Arcella",
    bbox: [45.420, 11.870, 45.450, 11.905],
    aliases: ["arcella", "arcella nord", "arcella sud", "borgomagno", "mortise"],
  },
  "guizza": {
    label: "Guizza",
    bbox: [45.370, 11.870, 45.398, 11.910],
    aliases: ["guizza", "bassanello guizza", "voltabarozzo"],
  },
  "zona industriale": {
    label: "Zona Industriale",
    bbox: [45.380, 11.910, 45.425, 11.975],
    aliases: ["zona industriale", "zip", "camin", "padova est"],
  },
  "forcellini": {
    label: "Forcellini",
    bbox: [45.385, 11.900, 45.412, 11.945],
    aliases: ["forcellini", "san gregorio", "terranegra", "forcellini est"],
  },
  "stazione": {
    label: "Stazione",
    bbox: [45.408, 11.870, 45.428, 11.898],
    aliases: ["stazione", "scrovegni", "fiera", "cittadella", "corso del popolo"],
  },
  "bassanello": {
    label: "Bassanello",
    bbox: [45.385, 11.855, 45.408, 11.892],
    aliases: ["bassanello", "voltabrusegana", "paltana"],
  },
  "chiesanuova": {
    label: "Chiesanuova",
    bbox: [45.395, 11.820, 45.425, 11.870],
    aliases: ["chiesanuova", "brusegana"],
  },
  "sacra famiglia": {
    label: "Sacra Famiglia",
    bbox: [45.395, 11.840, 45.420, 11.880],
    aliases: ["sacra famiglia", "palestro", "san giuseppe"],
  },
  "madonna pellegrina": {
    label: "Madonna Pellegrina",
    bbox: [45.388, 11.890, 45.410, 11.925],
    aliases: ["madonna pellegrina", "santa rita", "nazareth", "sant osvaldo"],
  },
  "portello": {
    label: "Portello",
    bbox: [45.408, 11.890, 45.425, 11.918],
    aliases: ["portello"],
  },
  "altichiero": {
    label: "Altichiero",
    bbox: [45.435, 11.850, 45.465, 11.895],
    aliases: ["altichiero", "sant ignazio", "monta"],
  },
  "pontevigodarzere": {
    label: "Pontevigodarzere",
    bbox: [45.440, 11.870, 45.470, 11.910],
    aliases: ["pontevigodarzere", "torre", "sacro cuore"],
  },
  "ponte di brenta": {
    label: "Ponte di Brenta",
    bbox: [45.420, 11.935, 45.450, 11.975],
    aliases: ["ponte di brenta", "san lazzaro"],
  },
};

// ── Padova: bbox comune intero (fallback) ──────────────────────────────────
export const PADOVA_BBOX_FULL: Bbox = [45.36, 11.80, 45.45, 11.95];

// ── Supplier scope bbox (province / region / italy) ────────────────────────
export type SupplierScope = "province" | "region" | "italy";

export const SUPPLIER_SCOPE_BBOX: Record<SupplierScope, Bbox> = {
  // Provincia di Padova (approx)
  province: [45.05, 11.30, 45.85, 12.20],
  // Veneto (approx)
  region: [44.79, 10.62, 46.68, 13.10],
  // Italia (approx, mainland + Sicilia/Sardegna)
  italy: [35.49, 6.60, 47.10, 18.55],
};

export const SUPPLIER_SCOPE_LABEL: Record<SupplierScope, string> = {
  province: "Provincia di Padova",
  region: "Veneto",
  italy: "Italia",
};

export function resolveSupplierScope(
  raw: string | null | undefined,
  fallback: SupplierScope = "region",
): SupplierScope {
  const s = String(raw ?? "").toLowerCase().trim();
  if (s === "province" || s === "provincia" || s === "pd") return "province";
  if (s === "region" || s === "regione" || s === "veneto") return "region";
  if (s === "italy" || s === "italia" || s === "national" || s === "it") return "italy";
  return fallback;
}


// ── Comuni PD limitrofi ────────────────────────────────────────────────────
export const PD_COMUNI: Record<string, { bbox: Bbox; label: string }> = {
  "padova": { label: "Padova", bbox: PADOVA_BBOX_FULL },
  "rubano": { label: "Rubano", bbox: [45.395, 11.740, 45.435, 11.800] },
  "selvazzano dentro": { label: "Selvazzano Dentro", bbox: [45.360, 11.730, 45.405, 11.815] },
  "albignasego": { label: "Albignasego", bbox: [45.345, 11.840, 45.385, 11.905] },
  "cadoneghe": { label: "Cadoneghe", bbox: [45.450, 11.870, 45.490, 11.920] },
  "ponte san nicolo": { label: "Ponte San Nicolò", bbox: [45.350, 11.890, 45.385, 11.950] },
  "abano terme": { label: "Abano Terme", bbox: [45.330, 11.760, 45.380, 11.825] },
  "noventa padovana": { label: "Noventa Padovana", bbox: [45.395, 11.940, 45.425, 11.985] },
  "vigodarzere": { label: "Vigodarzere", bbox: [45.450, 11.840, 45.490, 11.890] },
  "limena": { label: "Limena", bbox: [45.460, 11.830, 45.500, 11.890] },
  "saonara": { label: "Saonara", bbox: [45.380, 11.965, 45.420, 12.020] },
  "vigonza": { label: "Vigonza", bbox: [45.395, 11.945, 45.445, 12.015] },
};

export const PD_COMUNI_KEYS = Object.keys(PD_COMUNI);

export interface ResolvedScope {
  /** "quarter" | "city" | "province" */
  geographic_scope: "quarter" | "city" | "province";
  comune: string;            // canonical, es. "Padova"
  province: string;          // "PD"
  region: string;            // "Veneto"
  quarter: string | null;    // canonical label se quartiere, altrimenti null
  quarter_key: string | null;
  bbox: Bbox;
  geocode_query: string;
  requested_zone: string | null;
}

/**
 * Estrae quartiere da una stringa "zone" tipo "Padova Centro Storico".
 * Se il quartiere è riconosciuto restituisce la chiave canonica.
 */
function extractPadovaQuarter(zoneRaw: string | null | undefined): { key: string; label: string } | null {
  if (!zoneRaw) return null;
  let z = norm(zoneRaw);
  // strip leading "padova "
  z = z.replace(/^padova\s+/, "").trim();
  if (!z) return null;
  // direct key
  if (PADOVA_QUARTIERI[z]) return { key: z, label: PADOVA_QUARTIERI[z].label };
  // alias match
  for (const [key, q] of Object.entries(PADOVA_QUARTIERI)) {
    if (q.aliases.some((a) => norm(a) === z)) return { key, label: q.label };
  }
  // partial: any alias contained in z or viceversa
  for (const [key, q] of Object.entries(PADOVA_QUARTIERI)) {
    if (q.aliases.some((a) => z.includes(norm(a)) || norm(a).includes(z))) {
      return { key, label: q.label };
    }
  }
  return null;
}

export function resolveSearchScope(input: {
  city?: string | null;
  province?: string | null;
  region?: string | null;
  zone?: string | null;
}): ResolvedScope {
  const province = (input.province ?? "PD").toUpperCase();
  const region = input.region ?? "Veneto";
  const cityRaw = (input.city ?? "Padova").trim();
  const cityKey = norm(cityRaw);
  const zone = input.zone ?? null;

  // Padova + zona → tenta quartiere
  if (cityKey === "padova") {
    const q = extractPadovaQuarter(zone);
    if (q) {
      const meta = PADOVA_QUARTIERI[q.key];
      return {
        geographic_scope: "quarter",
        comune: "Padova",
        province,
        region,
        quarter: meta.label,
        quarter_key: q.key,
        bbox: meta.bbox,
        geocode_query: `${meta.label}, Padova, Provincia di Padova, Veneto, Italia`,
        requested_zone: zone,
      };
    }
    return {
      geographic_scope: "city",
      comune: "Padova",
      province,
      region,
      quarter: null,
      quarter_key: null,
      bbox: PADOVA_BBOX_FULL,
      geocode_query: `Padova, Provincia di Padova, Veneto, Italia`,
      requested_zone: zone,
    };
  }

  // Altri comuni PD noti
  const comuneMeta = PD_COMUNI[cityKey];
  if (comuneMeta) {
    return {
      geographic_scope: "city",
      comune: comuneMeta.label,
      province,
      region,
      quarter: null,
      quarter_key: null,
      bbox: comuneMeta.bbox,
      geocode_query: `${comuneMeta.label}, Provincia di Padova, Veneto, Italia`,
      requested_zone: zone,
    };
  }

  // Fallback: provincia PD, bbox Padova city (conservativo).
  return {
    geographic_scope: "province",
    comune: cityRaw,
    province,
    region,
    quarter: null,
    quarter_key: null,
    bbox: PADOVA_BBOX_FULL,
    geocode_query: `${cityRaw}, Provincia di Padova, Veneto, Italia`,
    requested_zone: zone,
  };
}

export function isInBbox(lat: number | null | undefined, lng: number | null | undefined, bbox: Bbox): boolean {
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const [s, w, n, e] = bbox;
  return lat >= s && lat <= n && lng >= w && lng <= e;
}

export function bboxCenter(bbox: Bbox): { lat: number; lng: number } {
  const [s, w, n, e] = bbox;
  return { lat: (s + n) / 2, lng: (w + e) / 2 };
}

export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function normalizeComune(s: string | null | undefined): string {
  return norm(s);
}

/**
 * True se il POI è coerente con lo scope:
 *  - se ha addr:city o comune dichiarato, deve corrispondere a scope.comune (o essere assente);
 *  - se non ha city ma ha coordinate, devono cadere nella bbox dello scope.
 *  - se non ha né city né coordinate, scartato (non possiamo verificarlo).
 */
export function isPoiInScope(
  poi: { lat: number | null; lng: number | null; tags?: Record<string, string> },
  scope: ResolvedScope,
): { ok: boolean; reason: string } {
  const tagCity = norm(poi.tags?.["addr:city"]);
  const expectedComune = norm(scope.comune);
  const inside = isInBbox(poi.lat, poi.lng, scope.bbox);

  if (tagCity) {
    if (tagCity !== expectedComune) {
      // addr:city dice esplicitamente un altro comune → fuori zona, sempre
      return { ok: false, reason: `wrong_comune:${tagCity}` };
    }
    // città corretta: se ci sono coordinate, devono comunque rientrare nella bbox quartiere
    if (scope.geographic_scope === "quarter") {
      if (typeof poi.lat === "number" && !inside) {
        return { ok: false, reason: "out_of_quarter_bbox" };
      }
    }
    return { ok: true, reason: "city_match" };
  }

  // Nessun addr:city dichiarato → richiediamo le coordinate dentro bbox
  if (typeof poi.lat !== "number" || typeof poi.lng !== "number") {
    return { ok: false, reason: "no_city_no_coords" };
  }
  if (!inside) return { ok: false, reason: "out_of_bbox" };
  return { ok: true, reason: "bbox_match" };
}
