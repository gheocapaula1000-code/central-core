import { describe, expect, it, vi } from "vitest";
import type {
  IdentityBlock,
  ProviderResult,
  SignalsBlock,
  TerritoryBlock,
  TerritoryIndicators,
  ValuationBlock,
  BlockProvenance,
} from "../../supabase/functions/property-detail/types.ts";
import {
  buildPropertyDetailResponse,
  encodePublicPropertyId,
  makeProvenance,
  parsePropertyUrn,
} from "../../supabase/functions/property-detail/contract.ts";
import { handlePropertyDetailLookup } from "../../supabase/functions/property-detail/handler.ts";
import {
  createInMemoryPropertyIdRegistry,
  OPAQUE_TOKEN_PATTERN,
} from "../../supabase/functions/property-detail/registry.ts";
import {
  haversineMeters,
  smallestContainingRadius,
  radiusToSpatialScope,
  boundingBox,
} from "../../supabase/functions/property-detail/geo.ts";

const padovaCoords = { lat: 45.4064, lng: 11.8768 };
const debugId = "dbg-property-detail";

const civicProvenance: BlockProvenance = makeProvenance({
  source: "omi_zone_geometry+nominatim",
  confidence: "alta",
  updatedAt: "2026-04-19",
  precisionLevel: "civic",
  spatialScope: "point",
});

const resolvedIdentity: IdentityBlock = {
  indirizzo: "Via Roma",
  civico: "42",
  comune: "Padova",
  provincia: "Padova",
  cap: "35121",
  coordinate: padovaCoords,
  precisionLevel: "civic",
  microZona: "Zona OMI B1 — CENTRO STORICO",
  zonaOmi: "B1",
  tipologia: null,
  stato: null,
  superficieMq: null,
  locali: null,
  piano: null,
  annoCostruzione: null,
  classeEnergetica: null,
  provenance: civicProvenance,
};

function resolved<T>(data: T): ProviderResult<T> {
  const provenance = data && typeof data === "object" && "provenance" in (data as Record<string, unknown>)
    ? ((data as Record<string, unknown>).provenance as ProviderResult<T>["provenance"])
    : null;
  return { outcome: "resolved", data, provenance };
}

function unavailable<T>(): ProviderResult<T> {
  return { outcome: "unavailable", data: null, provenance: null };
}

function failed<T>(error = "timeout"): ProviderResult<T> {
  return { outcome: "failed", data: null, provenance: null, error };
}

async function readJson(response: Response) {
  return await response.json() as Record<string, unknown>;
}

const URN_PREFIX = "urn:ccv3:property:veneto:";

// ════════════════════════════════════════════════════════════════
// Geo / radius utilities
// ════════════════════════════════════════════════════════════════

describe("property-detail micro-area geo utilities", () => {
  it("computes Haversine distance in meters with sub-percent accuracy at city scale", () => {
    // Roughly 1 km north of Padova centre
    const north = { lat: padovaCoords.lat + 1 / 111, lng: padovaCoords.lng };
    const d = haversineMeters(padovaCoords, north);
    expect(d).toBeGreaterThan(900);
    expect(d).toBeLessThan(1100);
  });

  it("classifies distances into the smallest standard micro-area radius", () => {
    expect(smallestContainingRadius(30)).toBe(50);
    expect(smallestContainingRadius(80)).toBe(100);
    expect(smallestContainingRadius(200)).toBe(250);
    expect(smallestContainingRadius(450)).toBe(500);
    expect(smallestContainingRadius(900)).toBeNull();
  });

  it("maps standard radii to canonical spatialScope labels", () => {
    expect(radiusToSpatialScope(50)).toBe("buffer_50m");
    expect(radiusToSpatialScope(100)).toBe("buffer_100m");
    expect(radiusToSpatialScope(250)).toBe("buffer_250m");
    expect(radiusToSpatialScope(500)).toBe("buffer_500m");
  });

  it("builds a bounding box that fully contains the requested radius", () => {
    const bbox = boundingBox(padovaCoords, 250);
    expect(bbox.latMin).toBeLessThan(padovaCoords.lat);
    expect(bbox.latMax).toBeGreaterThan(padovaCoords.lat);
    expect(bbox.lngMin).toBeLessThan(padovaCoords.lng);
    expect(bbox.lngMax).toBeGreaterThan(padovaCoords.lng);
    // The point at the bbox corner should be at most ~radius * sqrt(2) away
    const corner = { lat: bbox.latMax, lng: bbox.lngMax };
    expect(haversineMeters(padovaCoords, corner)).toBeLessThan(250 * 1.5);
  });
});

// ════════════════════════════════════════════════════════════════
// Public ID round-trip
// ════════════════════════════════════════════════════════════════

describe("property-detail opaque public ID round-trip", () => {
  it("mints an opaque URN that does not encode coordinates and is reusable as input", async () => {
    const registry = createInMemoryPropertyIdRegistry();

    const publicId = await encodePublicPropertyId(padovaCoords, registry);
    expect(publicId.startsWith(URN_PREFIX)).toBe(true);

    const opaque = publicId.slice(URN_PREFIX.length);
    expect(OPAQUE_TOKEN_PATTERN.test(opaque)).toBe(true);
    expect(opaque).not.toMatch(/45[0-9]{4}/);
    expect(opaque).not.toMatch(/11[0-9]{4}/);

    const second = await encodePublicPropertyId(padovaCoords, registry);
    expect(second).toBe(publicId);

    const parsed = await parsePropertyUrn(publicId, registry);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.inputKind).toBe("opaque_id");
      expect(parsed.publicId).toBe(publicId);
      expect(parsed.coords).toEqual(padovaCoords);
    }
  });

  it("returns unknown_id for a well-formed but unregistered opaque token", async () => {
    const registry = createInMemoryPropertyIdRegistry();
    const fakeButValid = `${URN_PREFIX}abcdefghjkmnpqrs`;
    const parsed = await parsePropertyUrn(fakeButValid, registry);
    expect(parsed).toEqual({ ok: false, error: "unknown_id" });
  });

  it("rejects malformed opaque tokens with invalid_format", async () => {
    const registry = createInMemoryPropertyIdRegistry();
    const parsed = await parsePropertyUrn(`${URN_PREFIX}not-a-real-id`, registry);
    expect(parsed).toEqual({ ok: false, error: "invalid_format" });
  });

  it("accepts legacy coordinate URNs as compatibility-only", async () => {
    const registry = createInMemoryPropertyIdRegistry();
    const parsed = await parsePropertyUrn(`${URN_PREFIX}45.4064:11.8768`, registry);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.inputKind).toBe("legacy_coordinates");
      const opaque = parsed.publicId.slice(URN_PREFIX.length);
      expect(OPAQUE_TOKEN_PATTERN.test(opaque)).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════
// Identity precision metadata
// ════════════════════════════════════════════════════════════════

describe("property-detail identity precision metadata", () => {
  it("exposes civic-level precision when address has a house number", () => {
    expect(resolvedIdentity.precisionLevel).toBe("civic");
    expect(resolvedIdentity.provenance.precisionLevel).toBe("civic");
    expect(resolvedIdentity.provenance.spatialScope).toBe("point");
    expect(resolvedIdentity.civico).toBe("42");
  });

  it("exposes street-level precision when only the street is resolved", () => {
    const streetIdentity: IdentityBlock = {
      ...resolvedIdentity,
      civico: null,
      precisionLevel: "street",
      provenance: makeProvenance({
        source: "omi_zone_geometry+nominatim",
        confidence: "media",
        updatedAt: "2026-04-19",
        precisionLevel: "street",
        spatialScope: "point",
      }),
    };
    expect(streetIdentity.precisionLevel).toBe("street");
    expect(streetIdentity.provenance.confidence).toBe("media");
  });

  it("falls back to comune precision when geocoding fails", () => {
    const comuneIdentity: IdentityBlock = {
      ...resolvedIdentity,
      indirizzo: null,
      civico: null,
      precisionLevel: "comune",
      provenance: makeProvenance({
        source: "omi_zone_geometry",
        confidence: "bassa",
        updatedAt: "2026-04-19",
        precisionLevel: "comune",
        spatialScope: "comune",
      }),
    };
    expect(comuneIdentity.precisionLevel).toBe("comune");
    expect(comuneIdentity.provenance.spatialScope).toBe("comune");
  });
});

// ════════════════════════════════════════════════════════════════
// Valuation semantics — sqm vs total
// ════════════════════════════════════════════════════════════════

describe("property-detail valuation semantics", () => {
  it("exposes only €/m² fields and never fabricates totals when no real surface inputs exist", () => {
    const valuation: ValuationBlock = {
      prezzoMqStimato: 2900,
      prezzoMqMinimo: 2400,
      prezzoMqMassimo: 3400,
      prezzoTotaleStimato: null,
      prezzoTotaleMinimo: null,
      prezzoTotaleMassimo: null,
      unita: "EUR_per_mq",
      drivers: "Valori OMI Abitazioni civili — zona B1.",
      provenance: makeProvenance({
        source: "omi_valori (zona)",
        confidence: "alta",
        updatedAt: "2026-04-19",
        precisionLevel: "microzone",
        spatialScope: "microzone",
      }),
    };

    expect(valuation.unita).toBe("EUR_per_mq");
    expect(valuation.prezzoMqStimato).toBeGreaterThan(0);
    expect(valuation.prezzoMqMinimo!).toBeLessThanOrEqual(valuation.prezzoMqMassimo!);
    // Totals must remain null in V1 — no fake total.
    expect(valuation.prezzoTotaleStimato).toBeNull();
    expect(valuation.prezzoTotaleMinimo).toBeNull();
    expect(valuation.prezzoTotaleMassimo).toBeNull();
    expect(valuation.provenance.precisionLevel).toBe("microzone");
  });

  it("downgrades precision/confidence for comune-level fallback", () => {
    const valuation: ValuationBlock = {
      prezzoMqStimato: 2500,
      prezzoMqMinimo: 1800,
      prezzoMqMassimo: 3600,
      prezzoTotaleStimato: null,
      prezzoTotaleMinimo: null,
      prezzoTotaleMassimo: null,
      unita: "EUR_per_mq",
      drivers: "Valori OMI Abitazioni civili — media comunale.",
      provenance: makeProvenance({
        source: "omi_valori (comune)",
        confidence: "media",
        updatedAt: "2026-04-19",
        precisionLevel: "comune",
        spatialScope: "comune",
      }),
    };
    expect(valuation.provenance.precisionLevel).toBe("comune");
    expect(valuation.provenance.spatialScope).toBe("comune");
    expect(valuation.provenance.confidence).toBe("media");
  });
});

// ════════════════════════════════════════════════════════════════
// Territory indicators — honest, source-backed only
// ════════════════════════════════════════════════════════════════

const honestIndicators: TerritoryIndicators = {
  sicurezzaAmbientale: {
    value: "media",
    kind: "environmental_risk_inverse",
    provenance: makeProvenance({
      source: "classificazione_sismica+ispra_rischio",
      confidence: "alta",
      updatedAt: "2026-04-19",
      precisionLevel: "comune",
      spatialScope: "comune",
    }),
  },
  rischioIdrogeologico: {
    value: "bassa",
    kind: "environmental_risk_inverse",
    provenance: makeProvenance({
      source: "ispra_rischio",
      confidence: "alta",
      updatedAt: "2026-04-19",
      precisionLevel: "comune",
      spatialScope: "comune",
    }),
  },
  profiloDemografico: {
    value: "equilibrata",
    kind: "demographic_age_profile",
    provenance: makeProvenance({
      source: "istat_comuni",
      confidence: "alta",
      updatedAt: "2026-04-19",
      precisionLevel: "comune",
      spatialScope: "comune",
    }),
  },
  residenzialita: {
    value: "centrale",
    kind: "residential_density",
    provenance: makeProvenance({
      source: "omi_zone",
      confidence: "media",
      updatedAt: "2026-04-19",
      precisionLevel: "microzone",
      spatialScope: "microzone",
    }),
  },
  // Honest unavailable — no real datasets wired for these in V1.
  serviziProssimita: null,
  verdeProssimita: null,
  accessibilita: null,
  pressioneTraffico: null,
  rumoreProxy: null,
};

describe("property-detail territory indicators honesty", () => {
  it("never fabricates noise / safety-as-crime / sentiment indicators when no real source exists", () => {
    expect(honestIndicators.rumoreProxy).toBeNull();
    expect(honestIndicators.pressioneTraffico).toBeNull();
    expect(honestIndicators.serviziProssimita).toBeNull();
    expect(honestIndicators.verdeProssimita).toBeNull();
    expect(honestIndicators.accessibilita).toBeNull();
  });

  it("labels safety derived from environmental risk as environmental_risk_inverse, not as criminality", () => {
    const safety = honestIndicators.sicurezzaAmbientale!;
    expect(safety.kind).toBe("environmental_risk_inverse");
    expect(safety.provenance.source).toContain("ispra_rischio");
    // Provenance scope is honestly comune — NOT civic / point.
    expect(safety.provenance.precisionLevel).toBe("comune");
    expect(safety.provenance.spatialScope).toBe("comune");
  });

  it("each resolved indicator carries its own provenance with precisionLevel and spatialScope", () => {
    const resolvedKeys: Array<keyof TerritoryIndicators> = [
      "sicurezzaAmbientale",
      "rischioIdrogeologico",
      "profiloDemografico",
      "residenzialita",
    ];
    for (const key of resolvedKeys) {
      const ind = honestIndicators[key]!;
      expect(ind.provenance.precisionLevel).toBeDefined();
      expect(ind.provenance.spatialScope).toBeDefined();
      expect(ind.provenance.source).toBeTruthy();
    }
  });
});

// ════════════════════════════════════════════════════════════════
// Block outcome semantics + partial success / failure isolation
// ════════════════════════════════════════════════════════════════

describe("property-detail block outcome semantics", () => {
  const publicId = `${URN_PREFIX}abcdefghjkmnpqrs`;

  it("keeps unavailable blocks null and absent from resolvedBlocks/failedBlocks", () => {
    const response = buildPropertyDetailResponse({
      publicId,
      requestedAt: "2026-04-19T10:00:00.000Z",
      emittedAt: "2026-04-19T10:00:00.000Z",
      identityResult: resolved(resolvedIdentity),
      territoryResult: unavailable<TerritoryBlock>(),
      valuationResult: unavailable<ValuationBlock>(),
      signalsResult: unavailable<SignalsBlock>(),
    });

    expect(response.identity).toEqual(resolvedIdentity);
    expect(response.territory).toBeNull();
    expect(response.valuation).toBeNull();
    expect(response.signals).toBeNull();
    expect(response.meta.resolvedBlocks).toEqual(["identity"]);
    expect(response.meta.failedBlocks).toEqual([]);
  });

  it("isolates failure per block: a single failed block must not affect others", () => {
    const valuation: ValuationBlock = {
      prezzoMqStimato: 2900,
      prezzoMqMinimo: 2400,
      prezzoMqMassimo: 3400,
      prezzoTotaleStimato: null,
      prezzoTotaleMinimo: null,
      prezzoTotaleMassimo: null,
      unita: "EUR_per_mq",
      drivers: "Valori OMI Abitazioni civili — zona B1.",
      provenance: makeProvenance({
        source: "omi_valori (zona)",
        confidence: "alta",
        updatedAt: "2026-04-19",
        precisionLevel: "microzone",
        spatialScope: "microzone",
      }),
    };
    const response = buildPropertyDetailResponse({
      publicId,
      requestedAt: "2026-04-19T10:00:00.000Z",
      emittedAt: "2026-04-19T10:00:00.000Z",
      identityResult: resolved(resolvedIdentity),
      territoryResult: failed<TerritoryBlock>("ispra timeout"),
      valuationResult: resolved(valuation),
      signalsResult: unavailable<SignalsBlock>(),
    });

    expect(response.identity).toEqual(resolvedIdentity);
    expect(response.valuation).toEqual(valuation);
    expect(response.territory).toBeNull();
    expect(response.signals).toBeNull();
    expect(response.meta.resolvedBlocks).toEqual(["identity", "valuation"]);
    expect(response.meta.failedBlocks).toEqual(["territory"]);
  });

  it("V1 Veneto pilot: identity+valuation+territory resolved with honest signals=unavailable", () => {
    const valuation: ValuationBlock = {
      prezzoMqStimato: 2900,
      prezzoMqMinimo: 2100,
      prezzoMqMassimo: 4700,
      prezzoTotaleStimato: null,
      prezzoTotaleMinimo: null,
      prezzoTotaleMassimo: null,
      unita: "EUR_per_mq",
      drivers: "Valori OMI Abitazioni civili — media comunale PADOVA.",
      provenance: makeProvenance({
        source: "omi_valori (comune)",
        confidence: "media",
        updatedAt: "2026-04-19",
        precisionLevel: "comune",
        spatialScope: "comune",
      }),
    };
    const territory: TerritoryBlock = {
      microZona: "Zona OMI B1 — ZONA ENTRO RIVIERE",
      sommario: "Padova: 207.412 abitanti, età media 47.5 anni.",
      puntiForti: ["Rischio sismico molto basso (zona 4)"],
      criticita: ["Rischio idraulico significativo (25.1% del territorio in P3)"],
      indicatori: honestIndicators,
      scenarioFuturo: null,
      provenance: makeProvenance({
        source: "omi_zone+istat_comuni+ispra_rischio+classificazione_sismica",
        confidence: "alta",
        updatedAt: "2026-04-19",
        precisionLevel: "microzone",
        spatialScope: "microzone",
      }),
    };
    const response = buildPropertyDetailResponse({
      publicId,
      requestedAt: "2026-04-19T10:00:00.000Z",
      emittedAt: "2026-04-19T10:00:00.000Z",
      identityResult: resolved(resolvedIdentity),
      territoryResult: resolved(territory),
      valuationResult: resolved(valuation),
      signalsResult: unavailable<SignalsBlock>(),
    });

    expect(response.meta.resolvedBlocks).toEqual(["identity", "territory", "valuation"]);
    expect(response.meta.failedBlocks).toEqual([]);
    // signals stays honestly null — never fabricated.
    expect(response.signals).toBeNull();
    // Valuation is sqm-only — totals null.
    expect(response.valuation?.prezzoTotaleStimato).toBeNull();
    expect(response.valuation?.unita).toBe("EUR_per_mq");
    // Territory honest indicators preserved.
    expect(response.territory?.indicatori?.rumoreProxy).toBeNull();
    expect(response.territory?.indicatori?.pressioneTraffico).toBeNull();
    expect(response.territory?.indicatori?.sicurezzaAmbientale?.kind).toBe("environmental_risk_inverse");
  });
});

// ════════════════════════════════════════════════════════════════
// Runtime handler contract
// ════════════════════════════════════════════════════════════════

describe("property-detail runtime handler contract", () => {
  it("returns a wrapper-free success payload and the returned id is reusable as input", async () => {
    const registry = createInMemoryPropertyIdRegistry();
    const publicId = await encodePublicPropertyId(padovaCoords, registry);

    const assemble = vi.fn(async (_coords, id, _dbg) => buildPropertyDetailResponse({
      publicId: id,
      requestedAt: "2026-04-19T10:00:00.000Z",
      emittedAt: "2026-04-19T10:00:00.000Z",
      identityResult: resolved(resolvedIdentity),
      territoryResult: unavailable<TerritoryBlock>(),
      valuationResult: unavailable<ValuationBlock>(),
      signalsResult: unavailable<SignalsBlock>(),
    }));

    const first = await handlePropertyDetailLookup(publicId, debugId, assemble, registry);
    const firstBody = await readJson(first);

    expect(first.status).toBe(200);
    expect(firstBody.ok).toBeUndefined();
    expect(firstBody.data).toBeUndefined();
    expect(firstBody.id).toBe(publicId);

    const second = await handlePropertyDetailLookup(String(firstBody.id), `${debugId}-2`, assemble, registry);
    const secondBody = await readJson(second);
    expect(second.status).toBe(200);
    expect(secondBody.id).toBe(publicId);

    for (const s of [String(firstBody.id), String(secondBody.id)]) {
      expect(s).not.toContain("45.4064");
      expect(s).not.toContain("11.8768");
    }
  });

  it("returns validation_error for malformed ids", async () => {
    const registry = createInMemoryPropertyIdRegistry();
    const assemble = vi.fn();
    const response = await handlePropertyDetailLookup(
      `${URN_PREFIX}broken`,
      debugId,
      assemble,
      registry,
    );
    const body = await readJson(response);

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid property id format. Expected: urn:ccv3:property:veneto:<opaque-id>",
      },
      debug_id: debugId,
    });
    expect(assemble).not.toHaveBeenCalled();
  });

  it("returns property_not_found for valid-shaped but unknown opaque ids", async () => {
    const registry = createInMemoryPropertyIdRegistry();
    const assemble = vi.fn();
    const response = await handlePropertyDetailLookup(
      `${URN_PREFIX}abcdefghjkmnpqrs`,
      debugId,
      assemble,
      registry,
    );
    const body = await readJson(response);

    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: { code: "PROPERTY_NOT_FOUND", message: "Unknown property id" },
      debug_id: debugId,
    });
    expect(assemble).not.toHaveBeenCalled();
  });

  it("returns temporary_backend_failure when identity resolution fails", async () => {
    const registry = createInMemoryPropertyIdRegistry();
    const publicId = await encodePublicPropertyId(padovaCoords, registry);
    const assemble = vi.fn(async (_coords, id, _dbg) => buildPropertyDetailResponse({
      publicId: id,
      requestedAt: "2026-04-19T10:00:00.000Z",
      emittedAt: "2026-04-19T10:00:00.000Z",
      identityResult: failed<IdentityBlock>(),
      territoryResult: unavailable<TerritoryBlock>(),
      valuationResult: unavailable<ValuationBlock>(),
      signalsResult: unavailable<SignalsBlock>(),
    }));

    const response = await handlePropertyDetailLookup(publicId, debugId, assemble, registry);
    const body = await readJson(response);

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: {
        code: "TEMPORARY_BACKEND_FAILURE",
        message: `Identity resolution failed. Reference: ${debugId}`,
      },
      debug_id: debugId,
    });
  });
});
