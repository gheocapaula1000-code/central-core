// Regressione — categoria pubblica "Contesi 3+".
// Un immobile e' contendibile SOLO con almeno 3 agenzie distinte.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  contesi3PlusGate,
  MIN_AGENZIE_CONTESI,
} from "../_shared/contesi3PlusGate.ts";

const MIGRATION =
  "supabase/migrations/20260808122854_26e45871-0374-4bf4-aaca-6a2356def1a3.sql";

const base = {
  canonicalIds: ["c1", "c2", "c3"],
  prezzoMin: 200000,
  prezzoMax: 200000,
};

Deno.test("soglia contratto = 3 agenzie distinte", () => {
  assertEquals(MIN_AGENZIE_CONTESI, 3);
});

Deno.test("2 agenzie distinte -> escluso", () => {
  const r = contesi3PlusGate({
    ...base,
    canonicalIds: ["c1", "c2"],
    agencies: ["Rossi Immobiliare", "Bianchi Case"],
  });
  assert(!r.ok);
  assert(r.reasons.includes("AGENZIE_INSUFFICIENTI"));
});

Deno.test("3 agenzie distinte -> incluso", () => {
  const r = contesi3PlusGate({
    ...base,
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
    agencies: ["A Casa", "B Case", "C Immobili"],
    prezzoMin: 200000,
    prezzoMax: 230000, // esattamente +15%
    photoCertifiedPairs: 3,
  });
  assertEquals(r.reasons, []);
  assert(r.ok);
});

Deno.test("spread oltre 15% -> escluso anche con foto identiche certificate", () => {
  const r = contesi3PlusGate({
    ...base,
    agencies: ["A Casa", "B Case", "C Immobili"],
    prezzoMin: 200000,
    prezzoMax: 240000, // +20%
    photoCertifiedPairs: 3,
  });
  assert(!r.ok);
  assert(r.reasons.includes("PREZZO_OLTRE_15_PCT"));
});

Deno.test("spread 10-15% senza prova -> escluso", () => {
  const r = contesi3PlusGate({
    ...base,
    agencies: ["A Casa", "B Case", "C Immobili"],
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
    agencies: ["A Casa", "B Case", "C Immobili"],
    canonicalIds: ["c1", "c1", "c1"],
  });
  assert(!r.ok);
  assert(r.reasons.includes("CANONICAL_COLLISION"));
});

Deno.test("asta o MLS -> escluso", () => {
  const r = contesi3PlusGate({
    ...base,
    agencies: ["A Casa", "B Case", "C Immobili"],
    hasMls: true,
  });
  assert(!r.ok);
  assert(r.reasons.includes("ASTA_O_MLS"));
});

Deno.test("migrazione: soglia 3+ propagata a gate, staging e QA", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert(/p_n_agenzie >= 3/.test(sql), "gate gruppo non a 3 agenzie");
  assert(/p_n_annunci_canonici >= 3/.test(sql), "gate gruppo non a 3 canonici");
  assert(/p_n_rows BETWEEN 3 AND 4/.test(sql), "gate gruppo non a >= 3 righe");
  assert(/WHERE n_agenzie >= 3/.test(sql), "staging unit-certified non a 3 agenzie");
  assert(/OR n_agenzie < 3/.test(sql), "QA post-scrittura non a 3 agenzie");
  assert(
    /p_prezzo_max <= p_prezzo_min \* 1\.15/.test(sql),
    "tolleranza prezzo 15% non preservata",
  );
  assert(
    /Verifica post-patch fallita/.test(sql),
    "patch non fail-closed",
  );
});
