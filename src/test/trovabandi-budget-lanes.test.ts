import { describe, expect, it } from "vitest";
import {
  canSpendPaid,
  createPaidBudget,
  documentIsReadable,
  filterSourcesByLane,
  isCompleteVerified,
  normalizeLane,
  parseAllowPaid,
  readIncomingEngineSecret,
  shouldSkipExpiredRecrawl,
  shouldSkipPaidExtract,
  shouldUsePaidProvider,
  sourceLane,
  spendPaid,
  usableStoredEvidence,
} from "../../supabase/functions/trovabandi-engine/budget.ts";

describe("TrovaBandi lanes", () => {
  it("classifica i tier ufficiali senza inventare corsie", () => {
    expect(
      sourceLane({
        name: "Albo Padova",
        authority_level: "COMUNALE",
        source_kind: "ALBO_PRETORIO",
      }),
    ).toBe("locale");
    expect(
      sourceLane({
        name: "CCIAA Padova",
        authority_level: "CAMERALE",
        source_kind: "CAMERALE",
      }),
    ).toBe("camerale");
    expect(
      sourceLane({
        name: "BUR Veneto",
        authority_level: "REGIONALE",
        source_kind: "BUR",
      }),
    ).toBe("regionale");
    expect(
      sourceLane({
        name: "Invitalia",
        authority_level: "NAZIONALE",
        source_kind: "CATALOGO",
      }),
    ).toBe("nazionale");
    expect(
      sourceLane({
        name: "Italia Domani - bandi PNRR",
        official_domain: "italiadomani.gov.it",
        authority_level: "NAZIONALE",
      }),
    ).toBe("pnrr");
    expect(
      sourceLane({
        name: "Funding & Tenders",
        authority_level: "EU",
        source_kind: "EU_PORTAL",
      }),
    ).toBe("ue");
    expect(
      sourceLane({
        name: "Dipartimento Pari Opportunità",
        official_domain: "pariopportunita.gov.it",
        search_query: "imprenditoria femminile",
      }),
    ).toBe("femminile");
    expect(
      sourceLane({
        name: "Politiche Giovanili",
        official_domain: "politichegiovanili.gov.it",
      }),
    ).toBe("giovanile");
  });

  it("filtra i dovuti per corsia e rifiuta lane invalide", () => {
    const sources = [
      { name: "Invitalia", authority_level: "NAZIONALE" },
      { name: "EIC", authority_level: "EU", source_kind: "EU_PORTAL" },
    ];
    expect(filterSourcesByLane(sources, "ue")).toHaveLength(1);
    expect(filterSourcesByLane(sources, null)).toHaveLength(2);
    expect(normalizeLane("PNRR")).toBe("pnrr");
    expect(normalizeLane("nope")).toBeNull();
  });
});

describe("TrovaBandi cost skips", () => {
  it("salta il recrawl di SCADUTO", () => {
    expect(shouldSkipExpiredRecrawl({ verification_status: "SCADUTO" })).toBe(
      true,
    );
    expect(shouldSkipExpiredRecrawl({ verification_status: "PARZIALE" })).toBe(
      false,
    );
  });

  it("salta la re-estrazione a pagamento di VERIFICATO completi", () => {
    expect(
      shouldSkipPaidExtract({
        verification_status: "VERIFICATO",
        deadline_at: "2026-09-30T00:00:00.000Z",
        max_grant_amount: 50000,
      }),
    ).toBe(true);
    expect(
      isCompleteVerified({
        verification_status: "VERIFICATO",
        deadline_at: "2026-09-30T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      shouldSkipPaidExtract({
        verification_status: "PARZIALE",
        deadline_at: "2026-09-30T00:00:00.000Z",
        max_grant_amount: 1,
      }),
    ).toBe(false);
    expect(
      shouldSkipPaidExtract({
        verification_status: "SPORTELLO",
        deadline_at: null,
        max_grant_amount: 80000,
      }),
    ).toBe(true);
  });

  it("usa l'excerpt persistito e paga solo se l'ufficiale fallisce", () => {
    expect(usableStoredEvidence("x".repeat(199))).toBeNull();
    expect(usableStoredEvidence("x".repeat(200))?.length).toBe(200);
    expect(documentIsReadable("ok ".repeat(80))).toBe(true);
    expect(shouldUsePaidProvider(true, true)).toBe(false);
    expect(shouldUsePaidProvider(false, true)).toBe(true);
    expect(shouldUsePaidProvider(true, false)).toBe(true);
  });
});

describe("TrovaBandi paid budget", () => {
  it("cap a 1 search / 1 scrape / 1 extract e si spegne se un collect è già RUNNING", () => {
    const budget = createPaidBudget(true, false);
    expect(canSpendPaid(budget, "search")).toBe(true);
    expect(spendPaid(budget, "search")).toBe(true);
    expect(canSpendPaid(budget, "search")).toBe(false);
    expect(spendPaid(budget, "scrape")).toBe(true);
    expect(spendPaid(budget, "scrape")).toBe(false);
    expect(createPaidBudget(true, true).allowPaid).toBe(false);
    expect(createPaidBudget(false, false).maxPaidExtracts).toBe(0);
  });

  it("parseAllowPaid default true, cheap incrementale false", () => {
    expect(parseAllowPaid(undefined)).toBe(true);
    expect(parseAllowPaid(false)).toBe(false);
    expect(parseAllowPaid("false")).toBe(false);
  });

  it("accetta x-internal-secret e x-job-secret senza preferire valori vuoti", () => {
    expect(
      readIncomingEngineSecret({
        get: (name) => (name === "x-internal-secret" ? "core" : null),
      }),
    ).toBe("core");
    expect(
      readIncomingEngineSecret({
        get: (name) => (name === "x-job-secret" ? "job" : ""),
      }),
    ).toBe("job");
  });
});
