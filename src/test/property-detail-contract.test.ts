import { describe, expect, it, vi } from "vitest";
import type {
  IdentityBlock,
  ProviderResult,
  SignalsBlock,
  TerritoryBlock,
  ValuationBlock,
} from "../../supabase/functions/property-detail/types.ts";
import {
  buildPropertyDetailResponse,
  encodePublicPropertyId,
  parsePropertyUrn,
} from "../../supabase/functions/property-detail/contract.ts";
import { handlePropertyDetailLookup } from "../../supabase/functions/property-detail/handler.ts";
import {
  createInMemoryPropertyIdRegistry,
  OPAQUE_TOKEN_PATTERN,
} from "../../supabase/functions/property-detail/registry.ts";

const padovaCoords = { lat: 45.4064, lng: 11.8768 };
const debugId = "dbg-property-detail";

const resolvedIdentity: IdentityBlock = {
  indirizzo: "Via Roma",
  civico: "42",
  comune: "Padova",
  provincia: "Padova",
  cap: "35121",
  coordinate: padovaCoords,
  tipologia: null,
  stato: null,
  superficieMq: null,
  locali: null,
  piano: null,
  annoCostruzione: null,
  classeEnergetica: null,
  provenance: {
    source: "omi_zone_geometry+nominatim",
    confidence: "alta",
    updatedAt: "2026-04-19",
  },
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

describe("property-detail opaque public ID round-trip", () => {
  it("mints an opaque URN that does not encode coordinates and is reusable as input", async () => {
    const registry = createInMemoryPropertyIdRegistry();

    const publicId = await encodePublicPropertyId(padovaCoords, registry);
    expect(publicId.startsWith(URN_PREFIX)).toBe(true);

    const opaque = publicId.slice(URN_PREFIX.length);
    expect(OPAQUE_TOKEN_PATTERN.test(opaque)).toBe(true);

    // Coordinates must not be reversibly extractable from the opaque token.
    expect(opaque).not.toContain("45");
    expect(opaque).not.toContain("11");
    expect(opaque).not.toMatch(/45[0-9]{4}/);
    expect(opaque).not.toMatch(/11[0-9]{4}/);

    // Reusable: same coordinates → same opaque token.
    const second = await encodePublicPropertyId(padovaCoords, registry);
    expect(second).toBe(publicId);

    // Resolvable back to the original coordinates via the registry.
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

  it("accepts legacy coordinate URNs as compatibility-only and converts to opaque ID", async () => {
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

  it("keeps failed blocks null and only in failedBlocks", () => {
    const response = buildPropertyDetailResponse({
      publicId,
      requestedAt: "2026-04-19T10:00:00.000Z",
      emittedAt: "2026-04-19T10:00:00.000Z",
      identityResult: resolved(resolvedIdentity),
      territoryResult: unavailable<TerritoryBlock>(),
      valuationResult: failed<ValuationBlock>(),
      signalsResult: unavailable<SignalsBlock>(),
    });

    expect(response.valuation).toBeNull();
    expect(response.meta.resolvedBlocks).toEqual(["identity"]);
    expect(response.meta.failedBlocks).toEqual(["valuation"]);
  });

  it("adds resolved non-identity blocks only to resolvedBlocks", () => {
    const signals: SignalsBlock = [{
      id: "sig-001",
      tipo: "infrastruttura",
      titolo: "Nuova linea tram",
      descrizione: "Collegamento previsto entro 2028",
      impatto: "positivo",
      orizzonte: "2028",
      provenance: { source: "ufficiale", confidence: "alta", updatedAt: "2026-03-01" },
    }];
    const response = buildPropertyDetailResponse({
      publicId,
      requestedAt: "2026-04-19T10:00:00.000Z",
      emittedAt: "2026-04-19T10:00:00.000Z",
      identityResult: resolved(resolvedIdentity),
      territoryResult: unavailable<TerritoryBlock>(),
      valuationResult: unavailable<ValuationBlock>(),
      signalsResult: resolved(signals),
    });

    expect(response.signals).toEqual(signals);
    expect(response.meta.resolvedBlocks).toEqual(["identity", "signals"]);
    expect(response.meta.failedBlocks).toEqual([]);
  });

  it("isolates failure per block: a single failed block must not affect others", () => {
    const valuation: ValuationBlock = {
      prezzoStimato: 2900,
      prezzoMinimo: 2400,
      prezzoMassimo: 3400,
      drivers: "Valori OMI Abitazioni civili — zona B1, stato NORMALE, 1 fascia di prezzo €/m².",
      provenance: { source: "omi_valori (zona)", confidence: "alta", updatedAt: "2026-04-19" },
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

  it("supports the typical V1 Veneto pilot response: identity+valuation+territory resolved, signals honestly unavailable", () => {
    const valuation: ValuationBlock = {
      prezzoStimato: 2900,
      prezzoMinimo: 2100,
      prezzoMassimo: 4700,
      drivers: "Valori OMI Abitazioni civili — media comunale PADOVA, stato misto (NORMALE, OTTIMO), 3 fasce €/m².",
      provenance: { source: "omi_valori (comune)", confidence: "media", updatedAt: "2026-04-19" },
    };
    const territory: TerritoryBlock = {
      microZona: "Zona OMI B1 — ZONA ENTRO RIVIERE-VIA XX SETTEMBRE",
      sommario: "Padova: 207.412 abitanti, età media 47.5 anni.",
      puntiForti: ["Rischio sismico molto basso (zona 4)", "Rischio frana trascurabile"],
      criticita: ["Rischio idraulico significativo (25.1% del territorio in P3)"],
      indicatori: { vivibilita: null, sicurezza: "media", rumore: null, servizi: null },
      scenarioFuturo: null,
      provenance: { source: "omi_zone+istat_comuni+ispra_rischio+classificazione_sismica", confidence: "alta", updatedAt: "2026-04-19" },
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
    expect(response.signals).toBeNull(); // honest unavailable, not fabricated
    expect(response.valuation?.prezzoStimato).toBeGreaterThan(0);
    expect(response.valuation!.prezzoMinimo!).toBeLessThanOrEqual(response.valuation!.prezzoMassimo!);
    expect(response.territory?.microZona).toContain("Zona OMI");
    // Provenance present on every resolved block
    expect(response.valuation?.provenance.source).toBeTruthy();
    expect(response.territory?.provenance.source).toBeTruthy();
    // Indicatori may have honest nulls — only sicurezza is derivable from real data in V1
    expect(response.territory?.indicatori?.vivibilita).toBeNull();
    expect(response.territory?.indicatori?.rumore).toBeNull();
    expect(response.territory?.indicatori?.servizi).toBeNull();
  });
});

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
    expect(firstBody.meta).toEqual({
      requestedAt: "2026-04-19T10:00:00.000Z",
      resolvedBlocks: ["identity"],
      failedBlocks: [],
    });

    // Returned id is reusable as input for the same endpoint.
    const second = await handlePropertyDetailLookup(String(firstBody.id), `${debugId}-2`, assemble, registry);
    const secondBody = await readJson(second);
    expect(second.status).toBe(200);
    expect(secondBody.id).toBe(publicId);

    // Coordinate string never appears in any returned id.
    const stringForms = [String(firstBody.id), String(secondBody.id)];
    for (const s of stringForms) {
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
