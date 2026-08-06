import { describe, expect, it } from "vitest";
import {
  boundedInteger,
  boundedNumeric,
  normalizeAuthorityLevel,
  normalizeCategoryCode,
  safeTextArray,
  safeTimestamp,
  sanitizeDbErrorCode,
} from "../../supabase/functions/trovabandi-engine/extraction";

describe("TrovaBandi — categoria compatibile con il CHECK di database", () => {
  it("preserva gli underscore delle categorie composte", () => {
    expect(normalizeCategoryCode("FONDO_PERDUTO")).toBe("FONDO_PERDUTO");
    expect(normalizeCategoryCode("fondo perduto")).toBe("FONDO_PERDUTO");
    expect(normalizeCategoryCode(" credito-imposta ")).toBe("CREDITO_IMPOSTA");
  });

  it("non produce mai codici fuori enum (causa reale del write failed)", () => {
    expect(normalizeCategoryCode("FONDOPERDUTO")).toBeNull();
    expect(normalizeCategoryCode("CONTRIBUTO_CAMERALE")).toBeNull();
    expect(normalizeCategoryCode(null)).toBeNull();
  });

  it("valida l'authority level ammesso", () => {
    expect(normalizeAuthorityLevel("camerale")).toBe("CAMERALE");
    expect(normalizeAuthorityLevel("PROVINCIALE")).toBeNull();
  });
});

describe("TrovaBandi — validazione numerica fail-closed", () => {
  it("rifiuta overflow su numeric(6,2)", () => {
    expect(boundedNumeric(50, 6, 2)).toBe(50);
    expect(boundedNumeric(9999.99, 6, 2)).toBe(9999.99);
    expect(boundedNumeric(10000, 6, 2)).toBeNull();
    expect(boundedNumeric(200000, 6, 2)).toBeNull();
  });

  it("rifiuta valori non finiti, negativi e non numerici", () => {
    expect(boundedNumeric(Number.NaN, 15, 2)).toBeNull();
    expect(boundedNumeric(Number.POSITIVE_INFINITY, 18, 2)).toBeNull();
    expect(boundedNumeric(-1, 15, 2)).toBeNull();
    expect(boundedNumeric("100000", 15, 2)).toBeNull();
  });

  it("arrotonda alla scala della colonna senza inventare valori", () => {
    expect(boundedNumeric(1234.567, 15, 2)).toBe(1234.57);
  });

  it("accetta solo interi nel range dichiarato", () => {
    expect(boundedInteger(3, 1, 5)).toBe(3);
    expect(boundedInteger(2.5, 0, 10)).toBeNull();
    expect(boundedInteger(9, 1, 5)).toBeNull();
    expect(boundedInteger(3_000_000_000, 0, 2_147_483_647)).toBeNull();
  });
});

describe("TrovaBandi — timestamp e array sicuri", () => {
  it("rifiuta date impossibili o fuori intervallo", () => {
    expect(safeTimestamp("2026-03-31T16:00:00Z")).toBe("2026-03-31T16:00:00.000Z");
    expect(safeTimestamp("entro il 31 dicembre")).toBeNull();
    expect(safeTimestamp("0202-01-01T00:00:00Z")).toBeNull();
    expect(safeTimestamp("")).toBeNull();
    expect(safeTimestamp(12345)).toBeNull();
  });

  it("normalizza gli array di testo per colonne text[]", () => {
    expect(safeTextArray(["  62  ", "62", "", "63"])).toEqual(["62", "63"]);
    expect(safeTextArray("62")).toEqual([]);
    expect(safeTextArray([1, true, null])).toEqual([]);
    expect(safeTextArray(["x".repeat(900)], 100, 500)[0]).toHaveLength(500);
    expect(safeTextArray(Array.from({ length: 200 }, (_, i) => `p${i}`))).toHaveLength(100);
  });
});

describe("TrovaBandi — telemetria errori di scrittura", () => {
  it("espone soltanto il codice sanificato", () => {
    expect(sanitizeDbErrorCode({ code: "23514", message: "check constraint", details: "row" })).toBe(
      "DB_23514",
    );
    expect(sanitizeDbErrorCode({ code: "22P02" })).toBe("DB_22P02");
    expect(sanitizeDbErrorCode({ code: "PGRST204" })).toBe("DB_PGRST204");
  });

  it("non propaga mai message, details, hint o contenuti", () => {
    const code = sanitizeDbErrorCode({
      code: "23514",
      message: "https://pd.camcom.it/segreto",
      hint: "secret",
      details: "row content",
    });
    expect(code).toBe("DB_23514");
    expect(code).not.toMatch(/http|secret|row/i);
  });

  it("degrada in modo sicuro senza codice", () => {
    expect(sanitizeDbErrorCode({})).toBe("DB_UNKNOWN");
    expect(sanitizeDbErrorCode(null)).toBe("DB_UNKNOWN");
  });
});
