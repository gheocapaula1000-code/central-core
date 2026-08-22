import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const sottraIndex = read("supabase/functions/sottra/index.ts");
const photoWow = read("supabase/functions/sottra/photo-wow.ts");
const omiLookup = read("supabase/functions/sottra/omi-lookup.ts");
const scan = read("supabase/functions/sottra/scan.ts");
const proxy = read("supabase/functions/core-proxy/index.ts");
const sottraInternal = read("supabase/functions/civiko-property-from-photo/sottraInternal.ts");
const civikoPhoto = read("supabase/functions/civiko-property-from-photo/index.ts");
const shared = read("supabase/functions/sottra/shared.ts");

describe("Sottra photoWow — route registration", () => {
  it("registers scan/photo-wow and aliases on the sottra function", () => {
    expect(sottraIndex).toMatch(/"scan\/photo-wow"\s*:\s*handlePhotoWow/);
    expect(sottraIndex).toMatch(/"photo-wow"\s*:\s*handlePhotoWow/);
    expect(sottraIndex).toMatch(/"photoWow"\s*:\s*handlePhotoWow/);
    expect(sottraIndex).toMatch(/from "\.\/photo-wow\.ts"/);
  });

  it("keeps existing scan/identify and scan/pricing handlers", () => {
    expect(sottraIndex).toMatch(/"scan\/identify"\s*:\s*handleScanIdentify/);
    expect(sottraIndex).toMatch(/"scan\/pricing"\s*:\s*handleScanPricing/);
  });
});

describe("Sottra photoWow — official OMI contract", () => {
  it("parses both PWA geo payload and scan lat/lng/photo", () => {
    expect(photoWow).toContain("parsePhotoWowInput");
    expect(photoWow).toContain("geo?.latitude");
    expect(photoWow).toContain("dataUrl");
    expect(photoWow).toMatch(/body\.lat/);
    expect(photoWow).toMatch(/body\.lng/);
  });

  it("runs identify + pricing engines, not Civiko marketing leftovers", () => {
    expect(photoWow).toContain("handleScanIdentify");
    expect(photoWow).toContain("handleScanPricing");
    expect(photoWow).not.toContain("property-marketing-pack");
    expect(photoWow).not.toContain("civiko-property-piano-esclusiva");
    expect(photoWow).not.toContain("runApifyPhotoEnrichment");
    expect(photoWow).not.toContain("padova");
  });

  it("labels OMI official/elaborated/unavailable and never invents scores or sold comps", () => {
    expect(photoWow).toContain('vendibilita: null');
    expect(photoWow).toContain("vendutoRecente: []");
    expect(photoWow).toContain("pianoEsclusiva: null");
    expect(photoWow).toContain("Nessun punteggio inventato");
    expect(photoWow).toMatch(/sourceType/);
    expect(photoWow).toContain("Agenzia delle Entrate — OMI");
  });

  it("keeps energy/catasto/listings unavailable and never official", () => {
    expect(photoWow).toContain("APE / prestazione energetica");
    expect(photoWow).toContain("Catasto / ANNCSU");
    expect(photoWow).toContain("Annunci immobiliari");
    expect(photoWow).toMatch(/resta estimated\/unavailable, mai official/);
    expect(photoWow).toContain("non sono inventati");
  });

  it("does not lock comune_aggregate as the product when a zone match exists", () => {
    expect(photoWow).toContain("omi_zone_geometry");
    expect(omiLookup).toContain("remapPolygonToOfficialZone");
    expect(omiLookup).toContain("presentPadovaSellableArea");
    expect(read("supabase/functions/sottra/padova-omi-areas.ts")).toContain("PADOVA_SELLABLE_AREAS");
    expect(omiLookup).toContain("comune_aggregate");
    expect(omiLookup).toContain("lookupOMIByComune");
    expect(omiLookup).toContain("resolveOMIPricing");
    expect(omiLookup).toMatch(/Never prefers city min\/max when a real zone match exists/);
  });

  it("includes ISTAT and OSM as official-or-unavailable, never invented", () => {
    expect(photoWow).toContain("istat_comuni");
    expect(photoWow).toContain("OpenStreetMap / Nominatim");
    expect(photoWow).toContain('sourceType: osmAvailable ? "official" : "unavailable"');
  });
});

describe("scan/pricing — comune fallback without fake zone", () => {
  it("uses resolveOMIPricing instead of AI-first leftover", () => {
    expect(scan).toContain("resolveOMIPricing");
    expect(scan).not.toContain("lookupOMIByCoordinates");
    expect(scan).toContain("comune_aggregate");
    expect(scan).toContain("range comunale da tabelle OMI ufficiali");
  });

  it("does not reference an undefined FONTE in the unavailable path", () => {
    expect(scan).toContain("fonte: omi.fonte");
    expect(scan).not.toMatch(/fonte:\s*FONTE/);
  });
});

describe("publication policy — comune_aggregate is elaborated, never official", () => {
  const PUBLICATION_POLICY = {
    OMI_PUBLISH_THRESHOLD: 0.50,
    OMI_OFFICIAL_THRESHOLD: 0.85,
    OFFICIAL_MATCH_METHODS: ["single_zone", "polygon_match"],
    UNPUBLISHABLE_MATCH_METHODS: ["ai_fallback", "first_zone_fallback", "none"],
  };
  function classifyOMIPricing(matchConfidence: number, matchMethod: string) {
    if (PUBLICATION_POLICY.UNPUBLISHABLE_MATCH_METHODS.includes(matchMethod)) return "unavailable";
    if (matchConfidence < PUBLICATION_POLICY.OMI_PUBLISH_THRESHOLD) return "unavailable";
    if (
      PUBLICATION_POLICY.OFFICIAL_MATCH_METHODS.includes(matchMethod) &&
      matchConfidence >= PUBLICATION_POLICY.OMI_OFFICIAL_THRESHOLD
    ) return "official";
    return "elaborated";
  }

  it("mirrors shared.ts elaborated methods", () => {
    expect(shared).toContain("comune_aggregate");
    expect(shared).toMatch(/ELABORATED_MATCH_METHODS:\s*\["ai_matched", "comune_aggregate"\]/);
  });

  it("comune_aggregate stays elaborated even at high confidence", () => {
    expect(classifyOMIPricing(0.99, "comune_aggregate")).toBe("elaborated");
    expect(classifyOMIPricing(0.72, "comune_aggregate")).toBe("elaborated");
    expect(classifyOMIPricing(0.49, "comune_aggregate")).toBe("unavailable");
  });

  it("polygon and single_zone remain the only official methods", () => {
    expect(classifyOMIPricing(0.95, "polygon_match")).toBe("official");
    expect(classifyOMIPricing(0.95, "single_zone")).toBe("official");
    expect(classifyOMIPricing(0.95, "ai_matched")).toBe("elaborated");
  });
});

describe("core-proxy — Sottra photoWow path", () => {
  it("whitelists the live PWA endpoint and canonical Sottra routes", () => {
    expect(proxy).toContain('"civiko-property-from-photo": "scan/photo-wow"');
    expect(proxy).toContain('"sottra/photo-wow": "scan/photo-wow"');
    expect(proxy).toContain('"sottra/scan/photo-wow": "scan/photo-wow"');
    expect(proxy).toContain('"sottra/scan/identify": "scan/identify"');
    expect(proxy).toContain('"sottra/scan/pricing": "scan/pricing"');
    expect(proxy).toContain('"sottra/health": "health"');
  });

  it("injects sottra identity, not civiko, on those routes", () => {
    expect(proxy).toMatch(/upstreamHeaders\["x-source-app"\]\s*=\s*"sottra"/);
    expect(proxy).toMatch(/Deno\.env\.get\("AI_CORE_SECRET_SOTTRA"\)/);
    expect(proxy).toMatch(/SOTTRA_DIRECT_ROUTES/);
  });

  it("does not send the live wow alias through civiko-property-from-photo", () => {
    expect(proxy).not.toMatch(/"civiko-property-from-photo"\s*:\s*"civiko-property-from-photo"/);
  });

  it("still never forwards a client-supplied x-internal-secret", () => {
    expect(proxy).not.toMatch(/req\.headers\.get\(\s*["']x-internal-secret["']/i);
  });
});

describe("Civiko One — existing callers stay on their own function", () => {
  it("civiko-property-from-photo still uses requireCivikoCostSecret", () => {
    expect(civikoPhoto).toContain("requireCivikoCostSecret");
    expect(civikoPhoto).toMatch(/if \(authFailure\) return withIdentity\(authFailure, "unauthorized"\)/);
  });

  it("internal Sottra fan-out uses x-source-app sottra and real omiMatchMethod fields", () => {
    expect(sottraInternal).toMatch(/"x-source-app": "sottra"/);
    expect(sottraInternal).not.toMatch(/"x-source-app": "civiko"/);
    expect(sottraInternal).toContain("omiMatchMethod");
    expect(sottraInternal).toContain("sourcePeriod");
    expect(sottraInternal).toContain("sourceType");
  });
});
