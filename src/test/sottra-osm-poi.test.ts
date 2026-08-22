import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assembleOsmPoiResult,
  classifyOsmTags,
  namedOsmPlace,
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
      "OpenStreetMap / Overpass non disponibile — elenco servizi non pubblicato",
    );
    expect(failed.sourceType).toBe("unavailable");
    expect(failed.pois).toEqual([]);
    expect(failed.elencoServiziRilevati).toEqual([]);
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
