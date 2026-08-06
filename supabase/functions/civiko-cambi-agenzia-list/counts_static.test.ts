// Test statici: conteggi autorevoli dei cambi agenzia (nessuna chiamata live).
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SRC = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("total deriva da un COUNT esatto, non dalla lunghezza della pagina", () => {
  assertStringIncludes(SRC, 'select("id", { count: "exact", head: true })');
  assert(!SRC.includes("total: items.length"), "total non può essere la pagina");
  assertStringIncludes(SRC, "const total = typeof count === \"number\" ? count : 0;");
});

Deno.test("offset applicato davvero e bounded, limit <= 200", () => {
  assertStringIncludes(SRC, ".range(page.from, page.to)");
  assertStringIncludes(SRC, "MAX_LIMIT = 200");
  // Oltre EOF nessuna query di pagina e nessun clamp a total-1.
  assertStringIncludes(SRC, "if (!page.beyond_eof)");
});

Deno.test("contratto pagina: items_count, has_more, snapshot_complete", () => {
  const ENV = Deno.readTextFileSync(new URL("../_shared/listContracts.ts", import.meta.url));
  for (const k of ["items_count", "has_more", "snapshot_complete"]) {
    assertStringIncludes(ENV, `${k}`);
  }
  assertStringIncludes(SRC, "listEnvelope({");
  assertStringIncludes(SRC, "snapshot_complete: snapshotComplete(");
});


Deno.test("nessun placeholder inventato su titolo/indirizzo", () => {
  assert(!SRC.includes('?? "Immobile a Padova"'));
  assert(!SRC.includes('r.indirizzo ?? "Padova"'));
  assertStringIncludes(SRC, "titolo: nullableText(r.titolo)");
  assertStringIncludes(SRC, "indirizzo: nullableText(r.indirizzo)");
});

Deno.test("i filtri restano applicati anche al conteggio", () => {
  // Stessi identici filtri per conteggio e pagina, con match esatto (mai ILIKE).
  assertStringIncludes(SRC, "const applyFilters =");
  assertStringIncludes(SRC, "await applyFilters(\n      supabase.from(\"padova_cambi_agenzia_by_zone_v\").select(\"id\", { count: \"exact\", head: true }),");
  assertStringIncludes(SRC, 'if (quartiere) out = out.eq("quartiere", quartiere);');
  assertStringIncludes(SRC, 'if (zonaOmi) out = out.eq("zona_omi", zonaOmi);');
  assert(!/\.ilike\(/.test(SRC), "nessun ILIKE su input utente");
});
