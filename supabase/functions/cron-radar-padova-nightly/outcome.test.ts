// Regressione: /agent-radar è read-only e non scrive radar_signals.
// radar_signals_written deve restare telemetria e non far fallire il run.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateRunOutcome } from "./outcome.ts";

Deno.test("successo con zero scritture radar_signals", () => {
  const out = evaluateRunOutcome(true, 0);
  assertEquals(out.ok, true);
  assertEquals(out.error, null);
  assertEquals(out.radar_signals_written, 0);
});

Deno.test("successo con conteggio non disponibile (null)", () => {
  const out = evaluateRunOutcome(true, null);
  assertEquals(out.ok, true);
  assertEquals(out.error, null);
  assertEquals(out.radar_signals_written, null);
});

Deno.test("successo con scritture presenti", () => {
  const out = evaluateRunOutcome(true, 12);
  assertEquals(out.ok, true);
  assertEquals(out.error, null);
});

Deno.test("failure downstream resta 502 anche con scritture presenti", () => {
  const out = evaluateRunOutcome(false, 12);
  assertEquals(out.ok, false);
  assertEquals(out.error, "radar_downstream_failure");
});

Deno.test("failure downstream con zero scritture", () => {
  const out = evaluateRunOutcome(false, 0);
  assertEquals(out.ok, false);
  assertEquals(out.error, "radar_downstream_failure");
});
