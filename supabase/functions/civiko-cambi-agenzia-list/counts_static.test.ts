// Test statici: conteggi autorevoli dei cambi agenzia (nessuna chiamata live).
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SRC = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("total deriva da un COUNT esatto, non dalla lunghezza della pagina", () => {
  assertStringIncludes(SRC, '{ count: "exact" }');
  assertStringIncludes(SRC, 'select("id", { count: "exact", head: true })');
  assert(!SRC.includes("total: items.length"), "total non può essere la pagina");
  assertStringIncludes(SRC, "total: authoritativeTotal");
});

Deno.test("offset applicato davvero e bounded, limit <= 200", () => {
  assertStringIncludes(SRC, ".range(offset, offset + limit - 1)");
  assertStringIncludes(SRC, "MAX_LIMIT = 200");
  assertStringIncludes(SRC, "boundedOffset");
});

Deno.test("contratto pagina: items_count, has_more, snapshot_complete", () => {
  for (const k of ["items_count", "has_more", "snapshot_complete"]) {
    assertStringIncludes(SRC, `${k}:`);
  }
});

Deno.test("nessun placeholder inventato su titolo/indirizzo", () => {
  assert(!SRC.includes('?? "Immobile a Padova"'));
  assert(!SRC.includes('r.indirizzo ?? "Padova"'));
  assertStringIncludes(SRC, "titolo: nullableText(r.titolo)");
  assertStringIncludes(SRC, "indirizzo: nullableText(r.indirizzo)");
});

Deno.test("i filtri restano applicati anche al conteggio", () => {
  assertStringIncludes(SRC, "if (quartiere) countQ = countQ.ilike");
  assertStringIncludes(SRC, "if (zonaOmi) countQ = countQ.ilike");
});
