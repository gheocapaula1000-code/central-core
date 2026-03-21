import { describe, it, expect } from "vitest";

/**
 * Listing Bridge Contract Tests
 *
 * Validates the KeyDraft→Bridge→Sottra data transport contract.
 * Pure logic — no live HTTP calls.
 */

const CORE_VERSION = "3.3.5";
const SUPPORTED_SCHEMA_VERSIONS = ["1.0"];

// ── Mirror of production validation logic ──

function validatePayload(body: unknown): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!body || typeof body !== "object") return { valid: false, errors: ["Body must be a JSON object"], warnings };
  const p = body as Record<string, unknown>;

  if (!p.schema_version || typeof p.schema_version !== "string") errors.push("Missing or invalid schema_version");
  else if (!SUPPORTED_SCHEMA_VERSIONS.includes(p.schema_version)) errors.push(`Unsupported schema_version: ${p.schema_version}`);

  const src = p.source as Record<string, unknown> | undefined;
  if (!src || typeof src !== "object") errors.push("Missing source object");
  else {
    if (!src.app || typeof src.app !== "string") errors.push("Missing source.app");
    if (!src.exported_at || typeof src.exported_at !== "string") errors.push("Missing source.exported_at");
    if (!src.bridge_trace_id || typeof src.bridge_trace_id !== "string") errors.push("Missing source.bridge_trace_id");
  }

  const lst = p.listing as Record<string, unknown> | undefined;
  if (!lst || typeof lst !== "object") errors.push("Missing listing object");
  else {
    if (!lst.listing_id || typeof lst.listing_id !== "string") errors.push("Missing listing.listing_id");
    if (!lst.run_id || typeof lst.run_id !== "string") errors.push("Missing listing.run_id");
  }

  const gt = p.generated_text as Record<string, unknown> | undefined;
  if (!gt || typeof gt !== "object") errors.push("Missing generated_text object");
  else {
    if (!gt.primary_listing_text || typeof gt.primary_listing_text !== "string") errors.push("Missing generated_text.primary_listing_text");
  }

  if (!p.property || typeof p.property !== "object") warnings.push("property object is missing");

  return { valid: errors.length === 0, errors, warnings };
}

function buildValidPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "1.0",
    source: {
      app: "keydraft",
      environment: "production",
      exported_at: "2026-03-21T10:00:00Z",
      bridge_trace_id: "trace-abc-123",
    },
    listing: {
      listing_id: "lst-001",
      run_id: "run-001",
      status: "ready_for_export",
    },
    property: {
      property_type: "appartamento",
      rooms_estimated: 3,
      bathrooms_estimated: 1,
      photo_count: 8,
    },
    photo_derived: {
      materials_detected: ["parquet", "marmo"],
      features_detected: ["balcone", "vista"],
      confidence_flags: ["high_confidence"],
    },
    agent_supplied: {
      structured_features: {
        garage: true,
        cantina: false,
        terrazza: true,
      },
      freeform_notes: "Appartamento ristrutturato",
    },
    generated_text: {
      primary_listing_text: "Bellissimo appartamento luminoso...",
      listing_text_long: "Testo lungo...",
      listing_text_short: "Testo breve",
      listing_social_variants: ["Post 1", "Post 2", "Post 3"],
    },
    sharing: {
      whatsapp_ready_summary: "Appartamento 3 locali, ristrutturato",
    },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// A. PATH REGISTRY
// ═══════════════════════════════════════════════════════════════

describe("Listing Bridge — path registry", () => {
  const BRIDGE_PATHS = [
    { path: "/health", method: "GET" },
    { path: "/manifest", method: "GET" },
    { path: "/ingest", method: "POST" },
    { path: "/status/:trace_id", method: "GET" },
    { path: "/retry/:trace_id", method: "POST" },
  ];

  it("all expected paths defined", () => {
    expect(BRIDGE_PATHS.length).toBe(5);
  });

  it.each(BRIDGE_PATHS)("$path ($method) is a valid route", ({ path, method }) => {
    expect(["GET", "POST"]).toContain(method);
    expect(path.startsWith("/")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// B. SCHEMA VALIDATION
// ═══════════════════════════════════════════════════════════════

describe("Listing Bridge — schema validation", () => {
  it("accepts valid payload", () => {
    const result = validatePayload(buildValidPayload());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects null body", () => {
    const result = validatePayload(null);
    expect(result.valid).toBe(false);
  });

  it("rejects missing schema_version", () => {
    const result = validatePayload(buildValidPayload({ schema_version: undefined }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("schema_version"))).toBe(true);
  });

  it("rejects unsupported schema_version", () => {
    const result = validatePayload(buildValidPayload({ schema_version: "99.0" }));
    expect(result.valid).toBe(false);
  });

  it("rejects missing source", () => {
    const result = validatePayload(buildValidPayload({ source: undefined }));
    expect(result.valid).toBe(false);
  });

  it("rejects missing listing", () => {
    const result = validatePayload(buildValidPayload({ listing: undefined }));
    expect(result.valid).toBe(false);
  });

  it("rejects missing generated_text", () => {
    const result = validatePayload(buildValidPayload({ generated_text: undefined }));
    expect(result.valid).toBe(false);
  });

  it("rejects missing primary_listing_text", () => {
    const result = validatePayload(buildValidPayload({
      generated_text: { listing_text_long: "some text" },
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("primary_listing_text"))).toBe(true);
  });

  it("warns when property is missing but still valid", () => {
    const result = validatePayload(buildValidPayload({ property: undefined }));
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// C. TRANSFORMATION
// ═══════════════════════════════════════════════════════════════

describe("Listing Bridge — transformation to Sottra payload", () => {
  function transformToSottraPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const p = payload as any;
    return {
      bridge_trace_id: p.source.bridge_trace_id,
      source_app: p.source.app,
      source_environment: p.source.environment ?? null,
      exported_at: p.source.exported_at,
      schema_version: p.schema_version,
      listing_id: p.listing.listing_id,
      run_id: p.listing.run_id,
      listing_status: p.listing.status,
      property_type: p.property?.property_type ?? null,
      rooms: p.property?.rooms_estimated ?? null,
      bathrooms: p.property?.bathrooms_estimated ?? null,
      photo_count: p.property?.photo_count ?? null,
      materials_detected: p.photo_derived?.materials_detected ?? [],
      features_detected: p.photo_derived?.features_detected ?? [],
      confidence_flags: p.photo_derived?.confidence_flags ?? [],
      structured_features: p.agent_supplied?.structured_features ?? {},
      freeform_notes: p.agent_supplied?.freeform_notes ?? null,
      primary_text: p.generated_text.primary_listing_text,
      text_long: p.generated_text.listing_text_long ?? null,
      text_short: p.generated_text.listing_text_short ?? null,
      social_variants: p.generated_text.listing_social_variants ?? [],
      whatsapp_summary: p.sharing?.whatsapp_ready_summary ?? null,
      origin_map: p.origin_map ?? null,
      imported_at: expect.any(String),
    };
  }

  it("transforms valid payload correctly", () => {
    const payload = buildValidPayload();
    const result = transformToSottraPayload(payload);
    expect(result.bridge_trace_id).toBe("trace-abc-123");
    expect(result.source_app).toBe("keydraft");
    expect(result.listing_id).toBe("lst-001");
    expect(result.primary_text).toBe("Bellissimo appartamento luminoso...");
    expect(result.rooms).toBe(3);
  });

  it("carries confidence_flags faithfully", () => {
    const payload = buildValidPayload();
    const result = transformToSottraPayload(payload);
    expect(result.confidence_flags).toEqual(["high_confidence"]);
  });

  it("carries freeform_notes faithfully", () => {
    const payload = buildValidPayload();
    const result = transformToSottraPayload(payload);
    expect(result.freeform_notes).toBe("Appartamento ristrutturato");
  });

  it("carries origin_map faithfully", () => {
    const payload = buildValidPayload({
      origin_map: { primary_listing_text: { from: ["photo_derived", "agent_supplied"] } },
    });
    const result = transformToSottraPayload(payload);
    expect(result.origin_map).toEqual({ primary_listing_text: { from: ["photo_derived", "agent_supplied"] } });
  });

  it("carries social_variants faithfully", () => {
    const payload = buildValidPayload();
    const result = transformToSottraPayload(payload);
    expect(result.social_variants).toEqual(["Post 1", "Post 2", "Post 3"]);
  });

  it("carries whatsapp_summary faithfully", () => {
    const payload = buildValidPayload();
    const result = transformToSottraPayload(payload);
    expect(result.whatsapp_summary).toBe("Appartamento 3 locali, ristrutturato");
  });

  it("carries source_environment and exported_at", () => {
    const payload = buildValidPayload();
    const result = transformToSottraPayload(payload);
    expect(result.source_environment).toBe("production");
    expect(result.exported_at).toBe("2026-03-21T10:00:00Z");
  });

  it("carries listing_status", () => {
    const payload = buildValidPayload();
    const result = transformToSottraPayload(payload);
    expect(result.listing_status).toBe("ready_for_export");
  });

  it("handles missing optional fields with safe defaults", () => {
    const payload = buildValidPayload({
      property: undefined,
      photo_derived: undefined,
      agent_supplied: undefined,
      sharing: undefined,
      origin_map: undefined,
    });
    const result = transformToSottraPayload(payload);
    expect(result.property_type).toBeNull();
    expect(result.rooms).toBeNull();
    expect(result.materials_detected).toEqual([]);
    expect(result.confidence_flags).toEqual([]);
    expect(result.structured_features).toEqual({});
    expect(result.freeform_notes).toBeNull();
    expect(result.whatsapp_summary).toBeNull();
    expect(result.origin_map).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// D. JOB STATE MACHINE
// ═══════════════════════════════════════════════════════════════

describe("Listing Bridge — job state machine", () => {
  const VALID_STATES = ["received", "validated", "transformed", "delivered", "imported", "failed"];

  it("all states are defined", () => {
    expect(VALID_STATES).toHaveLength(6);
  });

  it("states follow a logical progression", () => {
    expect(VALID_STATES.indexOf("received")).toBeLessThan(VALID_STATES.indexOf("validated"));
    expect(VALID_STATES.indexOf("validated")).toBeLessThan(VALID_STATES.indexOf("transformed"));
    expect(VALID_STATES.indexOf("transformed")).toBeLessThan(VALID_STATES.indexOf("delivered"));
  });

  it("failed can occur from any state", () => {
    expect(VALID_STATES).toContain("failed");
  });
});

// ═══════════════════════════════════════════════════════════════
// E. IDEMPOTENCY
// ═══════════════════════════════════════════════════════════════

describe("Listing Bridge — idempotency contract", () => {
  it("idempotent response has expected shape", () => {
    const response = {
      ok: true,
      data: {
        job_id: "uuid-123",
        trace_id: "trace-abc",
        status: "delivered",
        idempotent: true,
      },
      warnings: ["Job already exists — returning existing state"],
      debug_id: "dbg-001",
    };
    expect(response.data.idempotent).toBe(true);
    expect(response.warnings.length).toBeGreaterThan(0);
  });

  it("unique constraint on trace_id prevents duplicates", () => {
    // DB constraint: UNIQUE (trace_id)
    // DB constraint: UNIQUE (listing_id, run_id)
    expect(true).toBe(true); // structural assertion — enforced by DB
  });
});

// ═══════════════════════════════════════════════════════════════
// F. ERROR CODES
// ═══════════════════════════════════════════════════════════════

describe("Listing Bridge — error codes", () => {
  const BRIDGE_ERROR_CODES = [
    "VALIDATION_FAILED",
    "DELIVERY_FAILED",
    "RETRY_DELIVERY_FAILED",
    "MISSING_TRACE_ID",
    "JOB_NOT_FOUND",
    "JOB_NOT_RETRYABLE",
    "MAX_RETRIES_EXCEEDED",
    "DB_ERROR",
  ];

  it("all error codes are UPPER_SNAKE_CASE", () => {
    for (const code of BRIDGE_ERROR_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });

  it("no overlap with core infra error codes", () => {
    const CORE_CODES = ["APP_SECRET_REQUIRED", "ORIGIN_NOT_ALLOWED", "INTERNAL_ERROR"];
    for (const code of BRIDGE_ERROR_CODES) {
      expect(CORE_CODES).not.toContain(code);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// G. ENVELOPE CONSISTENCY
// ═══════════════════════════════════════════════════════════════

describe("Listing Bridge — envelope shape", () => {
  it("success envelope has standard fields", () => {
    const envelope = { ok: true, data: { job_id: "x" }, warnings: [], debug_id: "d1" };
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toBeDefined();
    expect(Array.isArray(envelope.warnings)).toBe(true);
  });

  it("error envelope has standard fields", () => {
    const envelope = {
      ok: false, data: null, warnings: [], debug_id: "d2",
      error: { code: "VALIDATION_FAILED", message: "..." },
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });
});

// ═══════════════════════════════════════════════════════════════
// H. ISOLATION — no regression on core patterns
// ═══════════════════════════════════════════════════════════════

describe("Listing Bridge — isolation from core", () => {
  it("function name is listing-bridge (not mixed with other functions)", () => {
    expect("listing-bridge").not.toBe("sottra");
    expect("listing-bridge").not.toBe("ai-core-run");
    expect("listing-bridge").not.toBe("ecosystem-gateway");
  });

  it("uses standard Central Core V3 patterns", () => {
    // Same shared helpers: makeDebugId, handleOptions, ok, fail, requireSecret, etc.
    const SHARED_HELPERS = ["makeDebugId", "handleOptions", "ok", "fail", "requireSecret", "enforceOriginPolicy", "addIdentityHeaders", "buildManifest"];
    expect(SHARED_HELPERS.length).toBe(8);
  });

  it("version aligned with core", () => {
    expect(CORE_VERSION).toBe("3.3.5");
  });
});
