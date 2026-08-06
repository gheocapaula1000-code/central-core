// Regressione perimetro Civiko: Comune di Padova + 8 slug ufficiali.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CIVIKO_EXACT8_SLUGS,
  createScopeCounters,
  bumpCounter,
  evaluateCivikoScopeGate,
  evaluateComuneScope,
  evaluateRawComuneScope,
  evaluateZoneExposure,
  isComunePadova,
  normalizeComune,
  reconcileScopeCounters,
} from "./civikoPadovaScopeGuard.ts";

Deno.test("normalizeComune: varianti Padova accettate", () => {
  for (const v of ["Padova", " PADOVA ", "Comune di Padova", "Padova (PD)", "Padova, PD", "Padova, Italia"]) {
    assertEquals(normalizeComune(v), "padova", `fallito: ${v}`);
    assert(isComunePadova(v));
  }
});

Deno.test("normalizeComune: comuni limitrofi non diventano Padova", () => {
  for (const v of ["Vigonza", "Noventa Padovana", "Ponte San Nicolo'", "Albignasego", "Selvazzano Dentro"]) {
    assert(!isComunePadova(v), `falso positivo: ${v}`);
  }
});

Deno.test("evaluateComuneScope: missing / ambiguous / out of scope", () => {
  assertEquals(evaluateComuneScope([]).ok, false);
  assertEquals((evaluateComuneScope([null, "", undefined]) as any).code, "COMUNE_MISSING");
  assertEquals((evaluateComuneScope(["Padova", "Vigonza"]) as any).code, "COMUNE_AMBIGUOUS");
  assertEquals((evaluateComuneScope(["Vigonza"]) as any).code, "COMUNE_OUT_OF_SCOPE");
  assertEquals(evaluateComuneScope(["Padova", "PADOVA (PD)"]).ok, true);
});

Deno.test("evaluateRawComuneScope: shape Subito Vigonza e city mancante", () => {
  const vigonza = { page_url: "https://www.subito.it/x-1.htm", location: { city: "Vigonza", province: "Padova" } };
  assertEquals((evaluateRawComuneScope("subito", vigonza) as any).code, "COMUNE_OUT_OF_SCOPE");
  const missing = { page_url: "https://www.subito.it/x-2.htm", location: { province: "Padova" } };
  assertEquals((evaluateRawComuneScope("subito", missing) as any).code, "COMUNE_MISSING");
  const ok = { page_url: "https://www.subito.it/x-3.htm", location: { city: "Padova" } };
  assertEquals(evaluateRawComuneScope("subito", ok).ok, true);
});

Deno.test("evaluateZoneExposure: solo gli 8 slug letterali sono esponibili", () => {
  assertEquals(CIVIKO_EXACT8_SLUGS.length, 8);
  for (const s of CIVIKO_EXACT8_SLUGS) assert(evaluateZoneExposure(s).exposable);
  assertEquals((evaluateZoneExposure(null) as any).code, "ZONE_NULL");
  assertEquals((evaluateZoneExposure("") as any).code, "ZONE_NULL");
  assertEquals((evaluateZoneExposure("arcella") as any).code, "ZONE_NOT_EXACT8");
});

Deno.test("contatori: bounded e riconciliati", () => {
  const c = createScopeCounters();
  bumpCounter(c, "scanned", 10);
  bumpCounter(c, "padova_kept", 6);
  bumpCounter(c, "out_of_scope_rejected", 3);
  bumpCounter(c, "other_rejected", 1);
  assert(reconcileScopeCounters(c).ok);
  bumpCounter(c, "scanned", 1);
  assert(!reconcileScopeCounters(c).ok);
  const neg = createScopeCounters();
  bumpCounter(neg, "scanned", -5);
  assertEquals(neg.scanned, 0);
});

Deno.test("gate: righe storiche non-Padova presenti ma escluse ⇒ PASS", () => {
  const counters = createScopeCounters();
  bumpCounter(counters, "scanned", 5);
  bumpCounter(counters, "padova_kept", 4);
  bumpCounter(counters, "out_of_scope_rejected", 1);
  bumpCounter(counters, "writes", 4);
  const gate = evaluateCivikoScopeGate({
    run_id: "run-1",
    counters,
    visible_rows: [
      { comune: "Padova", commercial_zone_slug: "centro-storico" },
      { comune: "PADOVA (PD)", commercial_zone_slug: "nord-arcella" },
    ],
    historic_non_padova_rows: 13,
    historic_non_padova_visible: 0,
    padova_null_zone_visible: 0,
  });
  assert(gate.ok, JSON.stringify(gate.failures));
  assertEquals(gate.metrics.historic_non_padova_rows, 13);
});

Deno.test("gate: scrittura fuori perimetro nella run corrente ⇒ FAIL", () => {
  const counters = createScopeCounters();
  bumpCounter(counters, "scanned", 3);
  bumpCounter(counters, "padova_kept", 3);
  bumpCounter(counters, "writes", 3);
  bumpCounter(counters, "out_of_scope_written", 1);
  const gate = evaluateCivikoScopeGate({
    run_id: "run-2",
    counters,
    visible_rows: [{ comune: "Vigonza", commercial_zone_slug: "centro-storico" }],
    historic_non_padova_rows: 13,
    historic_non_padova_visible: 0,
    padova_null_zone_visible: 0,
  });
  assert(!gate.ok);
  assert(gate.failures.includes("no_out_of_scope_write"));
  assert(gate.failures.includes("visible_rows_comune_padova"));
});

Deno.test("gate: riga Padova con zona NULL ancora esposta ⇒ FAIL", () => {
  const counters = createScopeCounters();
  bumpCounter(counters, "scanned", 1);
  bumpCounter(counters, "padova_kept", 1);
  const gate = evaluateCivikoScopeGate({
    run_id: "run-3",
    counters,
    visible_rows: [{ comune: "Padova", commercial_zone_slug: null }],
    historic_non_padova_rows: 13,
    historic_non_padova_visible: 0,
    padova_null_zone_visible: 7,
  });
  assert(!gate.ok);
  assert(gate.failures.includes("padova_null_zone_excluded"));
  assert(gate.failures.includes("visible_rows_exact8_zone"));
});
