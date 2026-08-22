import { describe, expect, it } from "vitest";
import {
  isSameDomainHttpsUrl,
  seedListingUrls,
} from "../../../supabase/functions/trovabandi-engine/seed.ts";
import {
  TROVABANDI_VENETO_ADDED,
  TROVABANDI_VENETO_ALREADY_PRESENT,
  VENETO_PROVINCES_STILL_WITHOUT_PROVINCIA_PAGE,
  VENETO_PROVINCES_WITH_PROVINCIA_OR_CM,
  type VenetoProvinceCode,
} from "./trovabandi-veneto-sources.fixture.ts";

const ALL_SEVEN: VenetoProvinceCode[] = [
  "PD",
  "VR",
  "VI",
  "TV",
  "VE",
  "RO",
  "BL",
];

describe("trovabandi Veneto-only province sources", () => {
  it("aggiunge esattamente due listing provincia venete nuove", () => {
    expect(TROVABANDI_VENETO_ADDED).toHaveLength(2);
    expect(TROVABANDI_VENETO_ADDED.map((row) => row.official_domain)).toEqual([
      "provincia.vicenza.it",
      "web.provincia.vr.it",
    ]);
  });

  it("espone ogni nuova riga con listing https sullo stesso dominio ufficiale", () => {
    for (const row of TROVABANDI_VENETO_ADDED) {
      expect(seedListingUrls(row.official_domain)).toContain(row.listing);
      expect(isSameDomainHttpsUrl(row.listing, row.official_domain)).toBe(true);
    }
  });

  it("accetta il listing Vicenza sul sottodominio ufficiale www2", () => {
    const vicenza = TROVABANDI_VENETO_ADDED.find(
      (row) => row.official_domain === "provincia.vicenza.it",
    );
    expect(vicenza).toBeDefined();
    expect(vicenza!.listing.startsWith("https://www2.provincia.vicenza.it/")).toBe(
      true,
    );
    expect(isSameDomainHttpsUrl(vicenza!.listing, "provincia.vicenza.it")).toBe(
      true,
    );
  });

  it("non duplica i domini veneti già in catalogo", () => {
    const added = new Set(
      TROVABANDI_VENETO_ADDED.map((row) => row.official_domain),
    );
    for (const row of TROVABANDI_VENETO_ALREADY_PRESENT) {
      expect(added.has(row.official_domain)).toBe(false);
      expect(seedListingUrls(row.official_domain)).toContain(row.listing);
      expect(isSameDomainHttpsUrl(row.listing, row.official_domain)).toBe(true);
    }
  });

  it("lascia l'albo di Padova e non introduce BUR FVG", () => {
    expect(seedListingUrls("padovanet.it")).toEqual([
      "https://www.padovanet.it",
    ]);
    expect(
      TROVABANDI_VENETO_ADDED.some(
        (row) => row.official_domain === "bur.regione.fvg.it",
      ),
    ).toBe(false);
  });

  it("dopo questa PR 5 province hanno pagina provincia/CM e 2 no", () => {
    expect(VENETO_PROVINCES_WITH_PROVINCIA_OR_CM).toEqual([
      "PD",
      "VR",
      "VI",
      "TV",
      "VE",
    ]);
    expect(VENETO_PROVINCES_STILL_WITHOUT_PROVINCIA_PAGE).toEqual(["RO", "BL"]);
    expect([
      ...VENETO_PROVINCES_WITH_PROVINCIA_OR_CM,
      ...VENETO_PROVINCES_STILL_WITHOUT_PROVINCIA_PAGE,
    ].sort()).toEqual([...ALL_SEVEN].sort());
  });
});
