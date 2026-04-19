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

describe("property-detail public ID round-trip", () => {
  it("encodes a reusable public URN and decodes it back to Veneto coordinates", () => {
    const publicId = encodePublicPropertyId(padovaCoords);
    expect(publicId).toMatch(/^urn:ccv3:property:veneto:v1_[0-9a-z]+_[0-9a-z]+_[0-9a-z]+$/i);

    const parsed = parsePropertyUrn(publicId);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.inputKind).toBe("public_id");
      expect(parsed.publicId).toBe(publicId);
      expect(parsed.coords).toEqual(padovaCoords);
    }
  });

  it("still accepts legacy coordinate URNs but canonicalizes them to the public URN", () => {
    const parsed = parsePropertyUrn("urn:ccv3:property:veneto:45.4064:11.8768");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.inputKind).toBe("legacy_coordinates");
      expect(parsed.publicId).toBe(encodePublicPropertyId(padovaCoords));
    }
  });

  it("rejects malformed ids with validation semantics", () => {
    expect(parsePropertyUrn("urn:ccv3:property:veneto:not-a-real-id")).toEqual({
      ok: false,
      error: "invalid_format",
    });
  });
});

describe("property-detail block outcome semantics", () => {
  it("keeps unavailable blocks null and absent from resolvedBlocks/failedBlocks", () => {
    const response = buildPropertyDetailResponse({
      coords: padovaCoords,
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
      coords: padovaCoords,
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
      provenance: {
        source: "ufficiale",
        confidence: "alta",
        updatedAt: "2026-03-01",
      },
    }];

    const response = buildPropertyDetailResponse({
      coords: padovaCoords,
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
});

describe("property-detail runtime handler contract", () => {
  it("returns a direct success payload with no ok/data wrapper", async () => {
    const publicId = encodePublicPropertyId(padovaCoords);
    const assemble = vi.fn().mockResolvedValue(buildPropertyDetailResponse({
      coords: padovaCoords,
      requestedAt: "2026-04-19T10:00:00.000Z",
      emittedAt: "2026-04-19T10:00:00.000Z",
      identityResult: resolved(resolvedIdentity),
      territoryResult: unavailable<TerritoryBlock>(),
      valuationResult: unavailable<ValuationBlock>(),
      signalsResult: unavailable<SignalsBlock>(),
    }));

    const response = await handlePropertyDetailLookup(publicId, debugId, assemble);
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body.ok).toBeUndefined();
    expect(body.data).toBeUndefined();
    expect(body.id).toBe(publicId);
    expect(body.meta).toEqual({
      requestedAt: "2026-04-19T10:00:00.000Z",
      resolvedBlocks: ["identity"],
      failedBlocks: [],
    });
    expect(body.identity).toEqual(resolvedIdentity);
    expect(body.territory).toBeNull();
    expect(body.valuation).toBeNull();
    expect(body.signals).toBeNull();
    expect(assemble).toHaveBeenCalledWith(padovaCoords, debugId);
  });

  it("accepts a returned public id again as input for the same endpoint flow", async () => {
    const publicId = encodePublicPropertyId(padovaCoords);
    const assemble = vi.fn().mockResolvedValue(buildPropertyDetailResponse({
      coords: padovaCoords,
      requestedAt: "2026-04-19T10:00:00.000Z",
      emittedAt: "2026-04-19T10:00:00.000Z",
      identityResult: resolved(resolvedIdentity),
      territoryResult: unavailable<TerritoryBlock>(),
      valuationResult: unavailable<ValuationBlock>(),
      signalsResult: unavailable<SignalsBlock>(),
    }));

    const first = await handlePropertyDetailLookup(publicId, debugId, assemble);
    const firstBody = await readJson(first);
    const second = await handlePropertyDetailLookup(String(firstBody.id), `${debugId}-2`, assemble);
    const secondBody = await readJson(second);

    expect(second.status).toBe(200);
    expect(secondBody.id).toBe(publicId);
    expect(assemble).toHaveBeenNthCalledWith(1, padovaCoords, debugId);
    expect(assemble).toHaveBeenNthCalledWith(2, padovaCoords, `${debugId}-2`);
  });

  it("returns validation_error for invalid ids with explicit error contract", async () => {
    const assemble = vi.fn();
    const response = await handlePropertyDetailLookup("urn:ccv3:property:veneto:broken", debugId, assemble);
    const body = await readJson(response);

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid property id format. Expected: urn:ccv3:property:veneto:<stable-id>",
      },
      debug_id: debugId,
    });
    expect(assemble).not.toHaveBeenCalled();
  });

  it("returns property_not_found for unknown but valid-shaped public ids", async () => {
    const unknownCoords = { lat: 45.5701, lng: 12.3101 };
    const publicId = encodePublicPropertyId(unknownCoords);
    const assemble = vi.fn().mockResolvedValue(buildPropertyDetailResponse({
      coords: unknownCoords,
      requestedAt: "2026-04-19T10:00:00.000Z",
      emittedAt: "2026-04-19T10:00:00.000Z",
      identityResult: unavailable<IdentityBlock>(),
      territoryResult: unavailable<TerritoryBlock>(),
      valuationResult: unavailable<ValuationBlock>(),
      signalsResult: unavailable<SignalsBlock>(),
    }));

    const response = await handlePropertyDetailLookup(publicId, debugId, assemble);
    const body = await readJson(response);

    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: {
        code: "PROPERTY_NOT_FOUND",
        message: "No property data found for this location in Veneto",
      },
      debug_id: debugId,
    });
  });

  it("returns temporary_backend_failure when identity resolution fails", async () => {
    const publicId = encodePublicPropertyId(padovaCoords);
    const assemble = vi.fn().mockResolvedValue(buildPropertyDetailResponse({
      coords: padovaCoords,
      requestedAt: "2026-04-19T10:00:00.000Z",
      emittedAt: "2026-04-19T10:00:00.000Z",
      identityResult: failed<IdentityBlock>(),
      territoryResult: unavailable<TerritoryBlock>(),
      valuationResult: unavailable<ValuationBlock>(),
      signalsResult: unavailable<SignalsBlock>(),
    }));

    const response = await handlePropertyDetailLookup(publicId, debugId, assemble);
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
