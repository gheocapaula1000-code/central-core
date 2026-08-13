// Regressione — categoria pubblica "Contesi 2+".
// Un immobile e' contendibile con almeno 2 agenzie distinte.
// I cluster 3+ restano HOT solo lato UI/display.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  contesi3PlusGate,
  MIN_AGENZIE_CONTESI,
} from "../_shared/contesi3PlusGate.ts";

const MIGRATION_3PLUS =
  "supabase/migrations/20260808122854_26e45871-0374-4bf4-aaca-6a2356def1a3.sql";
const MIGRATION_2PLUS =
  "supabase/migrations/20260813190000_contesi_2plus_threshold.sql";

const base = {
  canonicalIds: ["c1", "c2"],
  prezzoMin: 200000,
  prezzoMax: 200000,
};

Deno.test("soglia contratto = 2 agenzie distinte", () => {
  assertEquals(MIN_AGENZIE_CONTESI, 2);
});

Deno.test("1 agenzia -> escluso", () => {
  const r = contesi3PlusGate({
    ...base,
    canonicalIds: ["c1"],
    agencies: ["Rossi Immobiliare"],
  });
  assert(!r.ok);
  assert(r.reasons.includes("AGENZIE_INSUFFICIENTI"));
});

Deno.test("2 agenzie distinte -> incluso", () => {
  const r = contesi3PlusGate({
    ...base,
    agencies: ["Rossi Immobiliare", "Bianchi Case"],
  });
  assertEquals(r.reasons, []);
  assert(r.ok);
  assertEquals(r.nAgenzie, 2);
});

Deno.test("3 agenzie distinte -> incluso", () => {
  const r = contesi3PlusGate({
    ...base,
    canonicalIds: ["c1", "c2", "c3"],
    agencies: ["Rossi Immobiliare", "Bianchi Case", "Verdi Real Estate"],
  });
  assertEquals(r.reasons, []);
  assert(r.ok);
  assertEquals(r.nAgenzie, 3);
});

Deno.test("stessa agenzia duplicata -> escluso", () => {
  const r = contesi3PlusGate({
    ...base,
    agencies: ["Rossi Immobiliare", "rossi immobiliare", "ROSSI  IMMOBILIARE"],
  });
  assert(!r.ok);
  assertEquals(r.nAgenzie, 1);
  assert(r.reasons.includes("AGENZIE_INSUFFICIENTI"));
});

Deno.test("spread prezzo 15% -> incluso con prova foto certificata", () => {
  const r = contesi3PlusGate({
    ...base,
    agencies: ["A Casa", "B Case"],
    prezzoMin: 200000,
    prezzoMax: 230000, // esattamente +15%
    photoCertifiedPairs: 2,
  });
  assertEquals(r.reasons, []);
  assert(r.ok);
});

Deno.test("spread oltre 15% -> escluso anche con foto identiche certificate", () => {
  const r = contesi3PlusGate({
    ...base,
    agencies: ["A Casa", "B Case"],
    prezzoMin: 200000,
    prezzoMax: 240000, // +20%
    photoCertifiedPairs: 2,
  });
  assert(!r.ok);
  assert(r.reasons.includes("PREZZO_OLTRE_15_PCT"));
});

Deno.test("spread 10-15% senza prova -> escluso", () => {
  const r = contesi3PlusGate({
    ...base,
    agencies: ["A Casa", "B Case"],
    prezzoMin: 200000,
    prezzoMax: 226000, // +13%
    photoCertifiedPairs: 0,
  });
  assert(!r.ok);
  assert(r.reasons.includes("PREZZO_OLTRE_10_PCT_SENZA_PROVA"));
});

Deno.test("canonical collision -> escluso", () => {
  const r = contesi3PlusGate({
    ...base,
    agencies: ["A Casa", "B Case"],
    canonicalIds: ["c1", "c1"],
  });
  assert(!r.ok);
  assert(r.reasons.includes("CANONICAL_COLLISION"));
});

Deno.test("asta o MLS -> escluso", () => {
  const r = contesi3PlusGate({
    ...base,
    agencies: ["A Casa", "B Case"],
    hasMls: true,
  });
  assert(!r.ok);
  assert(r.reasons.includes("ASTA_O_MLS"));
});

Deno.test("migrazione storica 3+ presente e migrazione 2+ la ripristina", async () => {
  const sql3 = await Deno.readTextFile(MIGRATION_3PLUS);
  assert(/p_n_agenzie >= 3/.test(sql3), "migrazione storica 3+ assente");

  const sql2 = await Deno.readTextFile(MIGRATION_2PLUS);
  assert(/p_n_agenzie >= 2/.test(sql2), "gate gruppo non a 2 agenzie");
  assert(/p_n_annunci_canonici >= 2/.test(sql2), "gate gruppo non a 2 canonici");
  assert(/p_n_rows BETWEEN 2 AND 4/.test(sql2), "gate gruppo non a >= 2 righe");
  assert(/WHERE n_agenzie >= 2/.test(sql2), "staging unit-certified non a 2 agenzie");
  assert(/n_agenzie < 2/.test(sql2), "QA post-scrittura non a 2 agenzie");
  assert(
    /p_prezzo_max <= p_prezzo_min \* 1\.15/.test(sql2),
    "tolleranza prezzo 15% non preservata",
  );
  assert(
    /Verifica post-patch fallita/.test(sql2),
    "patch non fail-closed",
  );
});
