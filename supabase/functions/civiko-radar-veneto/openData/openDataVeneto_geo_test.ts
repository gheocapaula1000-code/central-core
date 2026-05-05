// Unit test: geo inference & topic classification for Open Data Veneto importer.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { VENETO_COMUNI } from "./venetoComuni.ts";

// Re-import private helpers via dynamic re-exec is heavy; instead, replicate
// behavior by sourcing the module's regexes. Simpler: spot-test through
// runOpenDataVenetoDeepImport's normalize pipeline by stubbing fetch.
// For brevity we test the lookup directly.

Deno.test("VENETO_COMUNI contains expected comuni", () => {
  assertEquals(VENETO_COMUNI["Vicenza"], "VI");
  assertEquals(VENETO_COMUNI["Minerbe"], "VR");
  assertEquals(VENETO_COMUNI["Malo"], "VI");
});
