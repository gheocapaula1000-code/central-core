import { describe, expect, it } from "vitest";
import {
  computeVisibility,
  isTransparencyPdf,
} from "../../supabase/functions/trovabandi-engine/rarity.ts";

describe("visibilità bandi rari", () => {
  it("nasconde comunali e camerali con rarity >= 4", () => {
    expect(
      computeVisibility(
        { authority_level: "COMUNALE", source_kind: "ALBO_PRETORIO", rarity_base: 2 },
        "https://www.comune.padova.it/avviso",
      ),
    ).toEqual({ is_hidden: true, rarity_score: 4 });
    expect(
      computeVisibility(
        { authority_level: "CAMERALE", source_kind: "CATALOGO", rarity_base: 5 },
        "https://www.pd.camcom.it/bando",
      ),
    ).toEqual({ is_hidden: true, rarity_score: 5 });
  });

  it("nasconde i GAL anche se il livello è generico", () => {
    expect(
      computeVisibility(
        { authority_level: "REGIONALE", source_kind: "GAL", rarity_base: 2, name: "GAL Adige" },
        "https://www.galadige.it/bandi/x",
      ).is_hidden,
    ).toBe(true);
  });

  it("PDF in amministrazione trasparente ⇒ rarity 5", () => {
    expect(
      isTransparencyPdf(
        "https://www.provincia.pd.it/amministrazione-trasparente/atto.pdf",
      ),
    ).toBe(true);
    expect(isTransparencyPdf("https://www.invitalia.it/bando")).toBe(false);
    expect(
      computeVisibility(
        { authority_level: "REGIONALE", source_kind: "CATALOGO", rarity_base: 1 },
        "https://www.provincia.pd.it/amministrazione-trasparente/atto.pdf",
      ),
    ).toEqual({ is_hidden: true, rarity_score: 5 });
  });

  it("nazionali ed europei restano visibili con la rarity della fonte", () => {
    expect(
      computeVisibility(
        { authority_level: "NAZIONALE", source_kind: "CATALOGO", rarity_base: 2 },
        "https://www.invitalia.it/bando",
      ),
    ).toEqual({ is_hidden: false, rarity_score: 2 });
  });
});
