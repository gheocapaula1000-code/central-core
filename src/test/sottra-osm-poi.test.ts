import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assembleNominatimPoiResult,
  assembleOsmPoiResult,
  classifyNominatimHit,
  classifyOsmTags,
  lookupOsmNeighborhoodPois,
  namedOsmPlace,
  parseNominatimHit,
  unavailableOsmPois,
} from "../../supabase/functions/sottra/osm-poi.ts";

const src = readFileSync(join(process.cwd(), "supabase/functions/sottra/osm-poi.ts"), "utf8");
const scan = readFileSync(join(process.cwd(), "supabase/functions/sottra/scan.ts"), "utf8");
const proxy = readFileSync(join(process.cwd(), "supabase/functions/core-proxy/index.ts"), "utf8");

describe("OSM neighborhood POI — tag classification", () => {
  it("maps schools, kindergartens, worship, pharmacies, shops", () => {
    expect(classifyOsmTags({ amenity: "school" })?.tipo).toBe("scuole");
    expect(classifyOsmTags({ amenity: "kindergarten" })?.tipo).toBe("asili");
    expect(classifyOsmTags({ amenity: "place_of_worship" })?.tipo).toBe("chiese");
    expect(classifyOsmTags({ building: "church" })?.tipo).toBe("chiese");
    expect(classifyOsmTags({ amenity: "pharmacy" })?.tipo).toBe("farmacie");
    expect(classifyOsmTags({ shop: "supermarket" })?.tipo).toBe("supermercati");
    expect(classifyOsmTags({ shop: "convenience" })?.tipo).toBe("convenience");
  });

  it("does not invent a category for unrelated tags", () => {
    expect(classifyOsmTags({ amenity: "bench" })).toBeNull();
    expect(classifyOsmTags({})).toBeNull();
  });

  it("requires a real OSM name — never falls back to the category label", () => {
    expect(namedOsmPlace({ amenity: "school" })).toBe("");
    expect(namedOsmPlace({ name: "Chiesa di San Francesco" })).toBe("Chiesa di San Francesco");
    expect(namedOsmPlace({ "name:it": "Coop" })).toBe("Coop");
    expect(src).not.toContain("|| cat.categoryLabel");
    expect(src).not.toContain('|| "Unnamed"');
  });
});

describe("OSM neighborhood POI — assemble fail-closed", () => {
  const origin = { lat: 45.4064, lng: 11.8768 };

  it("keeps only named places and lists them after OMI-style categories", () => {
    const result = assembleOsmPoiResult(
      [
        {
          type: "way",
          id: 1,
          lat: 45.4065,
          lon: 11.8769,
          tags: { amenity: "place_of_worship", name: "Chiesa di San Francesco" },
        },
        {
          type: "node",
          id: 2,
          lat: 45.407,
          lon: 11.877,
          tags: { amenity: "school" },
        },
        {
          type: "node",
          id: 3,
          lat: 45.4066,
          lon: 11.8772,
          tags: { shop: "supermarket", name: "Coop" },
        },
      ],
      origin.lat,
      origin.lng,
    );

    expect(result.sourceType).toBe("official");
    expect(result.found).toBe(true);
    expect(result.elencoServiziRilevati.some((n) => n.includes("Chiesa di San Francesco"))).toBe(
      true,
    );
    expect(result.elencoServiziRilevati.some((n) => n.includes("Coop"))).toBe(true);
    expect(result.pois.some((p) => !p.name)).toBe(false);
    expect(result.byTipo.chiese.map((p) => p.name)).toContain("Chiesa di San Francesco");
    expect(result.byTipo.supermercati.map((p) => p.name)).toContain("Coop");
    expect(result.byTipo.scuole).toHaveLength(0);
  });

  it("returns unavailable with empty lists when Overpass has no named hits", () => {
    const empty = assembleOsmPoiResult([], 45.4064, 11.8768);
    expect(empty.sourceType).toBe("unavailable");
    expect(empty.elencoServiziRilevati).toEqual([]);
    expect(empty.totalPois).toBe(0);
    expect(empty.limitations.join(" ")).toMatch(/non sono inventati/i);

    const failed = unavailableOsmPois(
      "OpenStreetMap / Overpass e Nominatim non disponibili — elenco servizi non pubblicato",
    );
    expect(failed.sourceType).toBe("unavailable");
    expect(failed.pois).toEqual([]);
    expect(failed.elencoServiziRilevati).toEqual([]);
  });
});

describe("OSM neighborhood POI — Nominatim fallback mapper", () => {
  const origin = { lat: 45.4064, lng: 11.8768 };

  it("keeps named churches and pharmacies with a computable distance", () => {
    const result = assembleNominatimPoiResult(
      [
        {
          name: "Chiesa di San Canziano",
          lat: "45.40675",
          lon: "11.87705",
          class: "amenity",
          type: "place_of_worship",
          osm_type: "way",
          osm_id: 101,
          hintedTipo: "chiese",
        },
        {
          name: "Farmacia all'Angelo",
          lat: 45.4067,
          lon: 11.8775,
          class: "amenity",
          type: "pharmacy",
          osm_type: "node",
          osm_id: 102,
          hintedTipo: "farmacie",
        },
        {
          name: "Chiesa di San Francesco",
          lat: "45.4078",
          lon: "11.8802",
          class: "amenity",
          type: "place_of_worship",
          osm_type: "way",
          osm_id: 103,
          hintedTipo: "chiese",
        },
      ],
      origin.lat,
      origin.lng,
    );

    expect(result.sourceType).toBe("official");
    expect(result.sourceProvider).toBe("nominatim");
    expect(result.found).toBe(true);
    expect(result.byTipo.chiese.map((p) => p.name)).toContain("Chiesa di San Canziano");
    expect(result.byTipo.chiese.map((p) => p.name)).toContain("Chiesa di San Francesco");
    expect(result.byTipo.farmacie.map((p) => p.name)).toContain("Farmacia all'Angelo");
    expect(result.pois.every((p) => p.name && Number.isFinite(p.distance) && p.distance <= 800)).toBe(
      true,
    );
    expect(result.elencoServiziRilevati.some((n) => n.includes("Farmacia all'Angelo"))).toBe(true);
  });

  it("drops unnamed hits, streets, and places without coordinates", () => {
    expect(
      parseNominatimHit(
        {
          name: "",
          display_name: "farmacia, Via San Francesco, Padova",
          lat: "45.4067",
          lon: "11.8775",
          class: "amenity",
          type: "pharmacy",
        },
        origin.lat,
        origin.lng,
      ),
    ).toBeNull();

    expect(
      parseNominatimHit(
        {
          name: "Via Chiesa",
          lat: "45.4065",
          lon: "11.8769",
          class: "highway",
          type: "residential",
          hintedTipo: "chiese",
        },
        origin.lat,
        origin.lng,
      ),
    ).toBeNull();

    expect(
      parseNominatimHit(
        {
          name: "Farmacia senza GPS",
          class: "amenity",
          type: "pharmacy",
        },
        origin.lat,
        origin.lng,
      ),
    ).toBeNull();

    expect(classifyNominatimHit("highway", "residential", "chiese")).toBeNull();
    expect(classifyNominatimHit("amenity", "pharmacy")?.tipo).toBe("farmacie");
  });

  it("accepts live Nominatim jsonv2 hits with null class when type matches", () => {
    const pharmacy = parseNominatimHit(
      {
        name: "Farmacia all'Angelo",
        lat: "45.4066913",
        lon: "11.8760827",
        class: null,
        type: "pharmacy",
        osm_type: "node",
        osm_id: 300,
        hintedTipo: "farmacie",
      },
      origin.lat,
      origin.lng,
    );
    const church = parseNominatimHit(
      {
        name: "Chiesa di San Francesco",
        lat: "45.4048334",
        lon: "11.8806128",
        class: null,
        type: "place_of_worship",
        osm_type: "way",
        osm_id: 301,
        hintedTipo: "chiese",
      },
      origin.lat,
      origin.lng,
    );
    expect(pharmacy?.name).toBe("Farmacia all'Angelo");
    expect(pharmacy?.tipo).toBe("farmacie");
    expect(pharmacy?.distance).toBeGreaterThan(0);
    expect(pharmacy?.distance).toBeLessThanOrEqual(800);
    expect(church?.name).toBe("Chiesa di San Francesco");
    expect(church?.tipo).toBe("chiese");
    expect(church?.distance).toBeLessThanOrEqual(800);
  });

  it("never uses display_name as the place name", () => {
    expect(src).not.toMatch(/name\s*=\s*.*display_name/);
    expect(src).not.toContain('|| cat.categoryLabel');
    expect(src).not.toContain("api.perplexity.ai");
  });
});

describe("OSM neighborhood POI — lookup fallback", () => {
  const origin = { lat: 45.4064, lng: 11.8768 };

  const nominatimHits = [
    {
      name: "Farmacia all'Angelo",
      lat: 45.4067,
      lon: 11.8775,
      class: "amenity",
      type: "pharmacy",
      osm_type: "node",
      osm_id: 200,
      hintedTipo: "farmacie" as const,
    },
    {
      name: "Chiesa di San Canziano",
      lat: 45.40675,
      lon: 11.87705,
      class: "amenity",
      type: "place_of_worship",
      osm_type: "way",
      osm_id: 201,
      hintedTipo: "chiese" as const,
    },
  ];

  it("falls back to Nominatim when Overpass throws", async () => {
    let nominatimCalled = false;
    const result = await lookupOsmNeighborhoodPois(origin.lat, origin.lng, 800, {
      fetchOverpassElements: async () => {
        throw new Error("overpass down");
      },
      fetchNominatimPlaces: async () => {
        nominatimCalled = true;
        return nominatimHits;
      },
    });
    expect(nominatimCalled).toBe(true);
    expect(result.sourceType).toBe("official");
    expect(result.sourceProvider).toBe("nominatim");
    expect(result.byTipo.farmacie[0]?.name).toBe("Farmacia all'Angelo");
    expect(result.byTipo.chiese[0]?.name).toBe("Chiesa di San Canziano");
  });

  it("falls back to Nominatim when Overpass returns no named elements", async () => {
    const result = await lookupOsmNeighborhoodPois(origin.lat, origin.lng, 800, {
      fetchOverpassElements: async () => [],
      fetchNominatimPlaces: async () => nominatimHits,
    });
    expect(result.sourceProvider).toBe("nominatim");
    expect(result.found).toBe(true);
    expect(result.pois.some((p) => p.tipo === "farmacie" || p.tipo === "chiese")).toBe(true);
  });

  it("keeps Overpass as primary when it returns named places", async () => {
    let nominatimCalled = false;
    const result = await lookupOsmNeighborhoodPois(origin.lat, origin.lng, 800, {
      fetchOverpassElements: async () => [
        {
          type: "node",
          id: 9,
          lat: 45.4065,
          lon: 11.8769,
          tags: { amenity: "place_of_worship", name: "Chiesa di San Francesco" },
        },
      ],
      fetchNominatimPlaces: async () => {
        nominatimCalled = true;
        return nominatimHits;
      },
    });
    expect(nominatimCalled).toBe(false);
    expect(result.sourceProvider).toBe("overpass");
    expect(result.byTipo.chiese[0]?.name).toBe("Chiesa di San Francesco");
  });

  it("stays unavailable when both Overpass and Nominatim fail", async () => {
    const result = await lookupOsmNeighborhoodPois(origin.lat, origin.lng, 800, {
      fetchOverpassElements: async () => {
        throw new Error("overpass down");
      },
      fetchNominatimPlaces: async () => {
        throw new Error("nominatim down");
      },
    });
    expect(result.sourceType).toBe("unavailable");
    expect(result.found).toBe(false);
    expect(result.pois).toEqual([]);
    expect(result.elencoServiziRilevati).toEqual([]);
    expect(result.limitations.join(" ")).toMatch(/Overpass e Nominatim/i);
  });
});

describe("OSM neighborhood POI — wiring", () => {
  it("queries Overpass with the six neighborhood categories and 800 m radius", () => {
    expect(src).toContain("OSM_POI_RADIUS_M = 800");
    expect(src).toContain("amenity");
    expect(src).toContain("place_of_worship");
    expect(src).toContain("kindergarten");
    expect(src).toContain("pharmacy");
    expect(src).toContain("supermarket");
    expect(src).toContain("convenience");
    expect(src).toContain("overpass-api.de/api/interpreter");
    expect(src).toContain("nominatim.openstreetmap.org/search");
    expect(src).toContain('q: "chiesa"');
    expect(src).toContain('q: "farmacia"');
  });

  it("scan/poi-enrichment uses Overpass, not Perplexity invented names", () => {
    expect(scan).toContain("lookupOsmNeighborhoodPois");
    expect(scan).toContain("handleScanPoiEnrichment");
    expect(scan).not.toContain("Perplexity — analisi POI zona");
    const poiHandler = scan.slice(scan.indexOf("handleScanPoiEnrichment"));
    expect(poiHandler.slice(0, 1800)).not.toContain("api.perplexity.ai");
  });

  it("core-proxy forwards poi-enrichment and neighborhood as sottra", () => {
    expect(proxy).toContain('"sottra/scan/poi-enrichment": "scan/poi-enrichment"');
    expect(proxy).toContain('"sottra/forecast/neighborhood": "forecast/neighborhood"');
  });
});
