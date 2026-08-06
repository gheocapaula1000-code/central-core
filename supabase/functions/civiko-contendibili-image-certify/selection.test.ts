import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AttemptState,
  chunk,
  eligibilityReason,
  isTerminalOutcome,
  normalizeOutcome,
  selectEligible,
  sourceFingerprint,
} from "./selection.ts";

const base = {
  maxAttempts: 4,
  pipelineRunId: "run-1",
  hasFingerprint: false,
  inScope: true,
  currentSourceFp: "fp-a",
};
const att = (o: Partial<AttemptState> = {}): AttemptState => ({
  attempts: 0,
  last_pipeline_run_id: null,
  terminal: false,
  image_source_fp: null,
  ...o,
});

Deno.test("chunk: >200 candidati vengono spezzati per le query .in()", () => {
  const ids = Array.from({ length: 501 }, (_, i) => i);
  const parts = chunk(ids);
  assertEquals(parts.length, 3);
  assertEquals(parts[0].length, 200);
  assertEquals(parts[2].length, 101);
  assertEquals(parts.flat(), ids);
});

Deno.test("eleggibilità: fuori perimetro, già fingerprint, stesso run", () => {
  assertEquals(eligibilityReason({ ...base, inScope: false }), "out_of_scope");
  assertEquals(eligibilityReason({ ...base, hasFingerprint: true }), "already_fingerprinted");
  assertEquals(
    eligibilityReason({ ...base, attempt: att({ last_pipeline_run_id: "run-1" }) }),
    "same_run",
  );
});

Deno.test("hard 4: al quarto tentativo il listing non viene più selezionato", () => {
  assertEquals(eligibilityReason({ ...base, attempt: att({ attempts: 3 }) }), null);
  assertEquals(
    eligibilityReason({ ...base, attempt: att({ attempts: 4 }) }),
    "attempts_exhausted",
  );
});

Deno.test("no_photo terminale: bloccato finché la fonte non cambia", () => {
  const terminal = att({ attempts: 1, terminal: true, image_source_fp: "fp-a" });
  assertEquals(
    eligibilityReason({ ...base, attempt: terminal, currentSourceFp: "fp-a" }),
    "terminal_unchanged",
  );
  assertEquals(
    eligibilityReason({ ...base, attempt: terminal, currentSourceFp: null }),
    "terminal_no_source",
  );
  // cambio fonte immagine ⇒ nuovo tentativo consentito
  assertEquals(eligibilityReason({ ...base, attempt: terminal, currentSourceFp: "fp-b" }), null);
  // mai oltre il tetto di 4 comunque
  assertEquals(
    eligibilityReason({
      ...base,
      attempt: att({ attempts: 4, terminal: true, image_source_fp: "fp-a" }),
      currentSourceFp: "fp-b",
    }),
    "attempts_exhausted",
  );
});

Deno.test("outcome terminali normalizzati", () => {
  assertEquals(normalizeOutcome("undecodable"), "no_valid_image");
  assertEquals(isTerminalOutcome("no_photo"), true);
  assertEquals(isTerminalOutcome("undecodable"), true);
  assertEquals(isTerminalOutcome("fingerprinted"), false);
});

Deno.test("fingerprint fonte: deterministico, stabile all'ordine chiavi, sensibile al contenuto", async () => {
  const a = await sourceFingerprint({ images: ["x", "y"], refs: null });
  const b = await sourceFingerprint({ refs: null, images: ["x", "y"] });
  const c = await sourceFingerprint({ images: ["x", "z"], refs: null });
  assertEquals(a, b);
  assertNotEquals(a, c);
  assertEquals(await sourceFingerprint({ images: null, refs: null }), null);
});

Deno.test("selezione: max 4 su >200 candidati, residuo autoritativo fino a EOF", () => {
  const pool = Array.from({ length: 260 }, (_, i) => i);
  const blocked = new Set([0, 1, 2]);
  const out = selectEligible(
    pool,
    (id) => (blocked.has(id) ? "attempts_exhausted" : null),
    4,
  );
  assertEquals(out.selected, [3, 4, 5, 6]);
  assertEquals(out.remaining, 260 - 3 - 4);
  assertEquals(out.exclusions.attempts_exhausted, 3);
});

Deno.test("selezione: >5000 stati di avanzamento paginati non bloccano la coda", () => {
  const states = new Map<number, AttemptState>();
  for (let i = 0; i < 5200; i++) states.set(i, att({ attempts: 4 }));
  states.set(5200, att());
  const pool = Array.from({ length: 5201 }, (_, i) => i);
  const out = selectEligible(
    pool,
    (id) =>
      eligibilityReason({ ...base, attempt: states.get(id), currentSourceFp: null }),
    4,
  );
  assertEquals(out.selected, [5200]);
  assertEquals(out.remaining, 0);
  assertEquals(out.exclusions.attempts_exhausted, 5200);
});
