// Compliance tests for inheritance / successione signals.
// Verifica che il guard rifiuti qualunque segnale a livello persona/civico
// e accetti solo aggregati di area.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertAggregateInheritanceSignal,
  enforceAggregateInheritanceSignal,
  ALLOWED_INHERITANCE_GRANULARITY,
  NEUTRAL_INHERITANCE_ACTIONS,
} from "./inheritanceComplianceGuard.ts";
import { scrapeSuccessioniPotenziali } from "../successioniPotenziali.ts";

Deno.test("rejects signal with surname field", () => {
  const r = assertAggregateInheritanceSignal({
    granularity: "microzona",
    titolo: "Zona presidio",
    surname: "Rossi",
  });
  assert(!r.allowed);
  assert(r.violations.some((v) => v.includes("surname")));
});

Deno.test("rejects signal with full_name / death_date / obituary_url", () => {
  const r = assertAggregateInheritanceSignal({
    granularity: "comune",
    full_name: "Mario Rossi",
    death_date: "2025-01-10",
    obituary_url: "https://necrologi.example/x",
  });
  assert(!r.allowed);
  assert(r.violations.some((v) => v.includes("full_name")));
  assert(r.violations.some((v) => v.includes("death_date")));
  assert(r.violations.some((v) => v.includes("obituary_url")));
});

Deno.test("rejects nominative obituary text in title/description", () => {
  const r = assertAggregateInheritanceSignal({
    granularity: "microzona",
    titolo: "Possibile successione famiglia Rossi",
    descrizione: "Decesso registrato, necrologio pubblicato",
  });
  assert(!r.allowed);
  assert(r.violations.some((v) => v.startsWith("forbidden_text_token")));
});

Deno.test("rejects exact civic-number address in text", () => {
  const r = assertAggregateInheritanceSignal({
    granularity: "microzona",
    descrizione: "Andare in Via Roma, 12 per verificare l'immobile",
  });
  assert(!r.allowed);
  assert(r.violations.includes("forbidden_civic_number_in_text"));
});

Deno.test("rejects obituary source name", () => {
  const r = assertAggregateInheritanceSignal({
    granularity: "comune",
    titolo: "Pressione patrimoniale comunale",
    fonte: "Necrologi Il Gazzettino",
  });
  assert(!r.allowed);
  assert(r.violations.includes("forbidden_obituary_source"));
});

Deno.test("rejects forbidden granularity (address / civic)", () => {
  for (const g of ["address", "civic", "person", "household"]) {
    const r = assertAggregateInheritanceSignal({ granularity: g, titolo: "x" });
    assert(!r.allowed, `granularity ${g} must be rejected`);
  }
});

Deno.test("accepts aggregate signal at allowed granularity with neutral action", () => {
  for (const g of ALLOWED_INHERITANCE_GRANULARITY) {
    const r = assertAggregateInheritanceSignal({
      granularity: g,
      titolo: "Pressione patrimoniale aggregata",
      descrizione: "Microzona con indice di vecchiaia elevato e OMI residenziale.",
      agentAction: NEUTRAL_INHERITANCE_ACTIONS[0],
      fonte: "istat_dcis_popres1",
    });
    assertEquals(r.allowed, true, `granularity ${g} must be allowed; got ${r.violations.join(",")}`);
  }
});

Deno.test("enforceAggregateInheritanceSignal throws on violation", () => {
  let threw = false;
  try {
    enforceAggregateInheritanceSignal({ granularity: "address", surname: "X" });
  } catch (_e) {
    threw = true;
  }
  assert(threw);
});

Deno.test("scrapeSuccessioniPotenziali è disabilitato e ritorna []", async () => {
  const out = await scrapeSuccessioniPotenziali("Padova", "PD");
  assertEquals(out, []);
});
