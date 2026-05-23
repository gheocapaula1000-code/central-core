// Pure-logic tests for Padova microzone matcher.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  matchPadovaMicrozone,
  applyPadovaMicrozoneFilter,
  normalizeRequestedMicrozones,
  PADOVA_MICROZONES,
} from "./padovaMicrozones.ts";

Deno.test("catalog has exactly 20 microzones", () => {
  assertEquals(PADOVA_MICROZONES.length, 20);
});

Deno.test("normalizeRequestedMicrozones accepts labels and ids, drops junk", () => {
  const out = normalizeRequestedMicrozones(["Arcella", "portello_universita", "Not A Zone", 42]);
  assertEquals(out.sort(), ["arcella", "portello_universita"].sort());
});

Deno.test("matchPadovaMicrozone returns unknown outside Padova", () => {
  const r = matchPadovaMicrozone({ comune: "Verona", text: ["arcella zona calda"] });
  assertEquals(r.microzone_match, "unknown");
});

Deno.test("matchPadovaMicrozone matches via indirizzo with high confidence", () => {
  const r = matchPadovaMicrozone({ comune: "Padova", indirizzo: "Via Tiziano Aspetti 12" });
  assertEquals(r.microzone_match, "matched");
  assertEquals(r.microzone_id, "arcella");
  assertEquals(r.microzone_match_confidence, "high");
  assertEquals(r.microzone_match_method, "indirizzo_keyword");
});

Deno.test("matchPadovaMicrozone matches via free text with low confidence", () => {
  const r = matchPadovaMicrozone({ comune: "Padova", text: ["Forte domanda in zona Forcellini"] });
  assertEquals(r.microzone_id, "forcellini_terranegra");
  assertEquals(r.microzone_match_confidence, "low");
});

Deno.test("applyPadovaMicrozoneFilter annotates when selection empty", () => {
  const items = [
    { comune: "Padova", indirizzo: "via curzola 5" },
    { comune: "Padova", text: ["nessun toponimo riconoscibile"] },
  ];
  const r = applyPadovaMicrozoneFilter(items, []);
  assertEquals(r.kept.length, 2);
  assertEquals(r.kept[0].microzone_id, "arcella");
  assertEquals(r.kept[1].microzone_match, "unknown");
});

Deno.test("applyPadovaMicrozoneFilter filters when selection non-empty", () => {
  const items = [
    { comune: "Padova", indirizzo: "via curzola 5" },           // arcella
    { comune: "Padova", indirizzo: "via forcellini 100" },      // forcellini
    { comune: "Padova", text: ["zona non identificabile"] },    // unknown
  ];
  const r = applyPadovaMicrozoneFilter(items, ["arcella"]);
  assertEquals(r.kept.length, 1);
  assertEquals(r.kept[0].microzone_id, "arcella");
  assertEquals(r.droppedNonMatching, 1);
  assertEquals(r.droppedUnknown, 1);
});
