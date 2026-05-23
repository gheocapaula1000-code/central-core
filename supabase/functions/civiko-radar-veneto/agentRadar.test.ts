// Pure-logic tests for Agent Radar Veneto.
// Exercises Veneto-only filter, demo fallback, stable shape, ranking helpers.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildAgentRadar,
  buildAosOnlyBreakdown,
  buildHumanReason,
  normalizeProvincia,
  VENETO_PROVINCES,
} from "./agentRadar.ts";


// Ensure no service role → triggers "empty" branch (no Supabase calls).
Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
Deno.env.delete("SUPABASE_URL");

Deno.test("normalizeProvincia accepts code and full name", () => {
  assertEquals(normalizeProvincia("VE"), "VE");
  assertEquals(normalizeProvincia("Padova"), "PD");
  assertEquals(normalizeProvincia("Milano"), null);
  assertEquals(normalizeProvincia(""), null);
  assertEquals(normalizeProvincia(null), null);
});

Deno.test("VENETO_PROVINCES contains exactly 7 codes", () => {
  assertEquals(VENETO_PROVINCES.length, 7);
  for (const c of ["VE","VR","VI","PD","TV","BL","RO"]) {
    assert(VENETO_PROVINCES.includes(c as never));
  }
});

Deno.test("buildAgentRadar returns stable empty shape when backend missing", async () => {
  const out = await buildAgentRadar({});
  assertEquals(out.configured, false);
  assertEquals(out.scope.region, "Veneto");
  assertEquals(out.scope.datasetStatus, "empty");
  assertEquals(out.zones.length, 0);
  assertEquals(out.opportunities.length, 0);
  assertEquals(out.summary.dataQuality, "mancante");
  // shape sanity
  assert(Array.isArray(out.dataQuality.missing));
  assert(out.dataQuality.missing.includes("supabase"));
});

Deno.test("buildAgentRadar production-safe: allowDemo=true non restituisce mai zone demo", async () => {
  const out = await buildAgentRadar({ allowDemo: true });
  assertEquals(out.zones.length, 0);
  assertEquals(out.dataQuality.demo.length, 0);
  assertEquals(out.summary.dataQuality, "mancante");
});

Deno.test("buildAgentRadar ignora provincia fuori Veneto", async () => {
  const out = await buildAgentRadar({ provincia: "Milano", allowDemo: true });
  assertEquals(out.zones.length, 0);
  for (const z of out.zones) assert(VENETO_PROVINCES.includes(z.provincia as never));
});

Deno.test("output JSON is fully serializable (no undefined)", async () => {
  const out = await buildAgentRadar({ allowDemo: true });
  const round = JSON.parse(JSON.stringify(out));
  assertEquals(round.scope.region, "Veneto");
  assertEquals(round.zones.length, 0);
});

Deno.test("buildAosOnlyBreakdown produces real, non-fabricated breakdown", () => {
  const b = buildAosOnlyBreakdown(72, "offmarket_opportunity_scores:acquisition_priority_score");
  // Snake_case fields, total reflects input, per-signal subscores stay 0 (no invention).
  assertEquals(b.area_opportunity_score, 72);
  assertEquals(b.total, 72);
  assertEquals(b.ribassi, 0);
  assertEquals(b.motivated_sellers, 0);
  assertEquals(b.aste, 0);
  assertEquals(b.stock_listings, 0);
  assertEquals(b.omi_gap, 0);
  assertEquals(b.omi_gap_direction, "n/a");
  assertEquals(b.omi_gap_pct, null);
  assertEquals(b.microzone_match, 0);
  assert(b.notes.some((n) => n.includes("offmarket_opportunity_scores")));
});

Deno.test("buildAosOnlyBreakdown clamps invalid input and is JSON-serializable", () => {
  const b = buildAosOnlyBreakdown(Number.NaN, "open_data_veneto:radar_signals");
  assertEquals(b.area_opportunity_score, 0);
  assertEquals(b.total, 0);
  const round = JSON.parse(JSON.stringify(b));
  assertEquals(round.area_opportunity_score, 0);
  assertEquals(round.omi_gap_direction, "n/a");
});

Deno.test("opportunity object spread preserves score_breakdown end-to-end", () => {
  // Simulates the annotatedOpps map step that wraps opportunities with microzone fields.
  const op = { id: "op-1", whyNow: "x", score_breakdown: buildAosOnlyBreakdown(60, "test:source") };
  const annotated = { ...op, microzone: null, microzone_match: "unknown" as const };
  assert(annotated.score_breakdown);
  assertEquals(annotated.score_breakdown.total, 60);
  // Snake_case is the contract field consumed by AcquisitionRadar.
  assert("score_breakdown" in annotated);
});

Deno.test("buildHumanReason surfaces AOS when only that component is present", () => {
  const b = buildAosOnlyBreakdown(50, "test:source");
  // AOS-only breakdown still produces a human reason citing area_opportunity_score.
  const reason = buildHumanReason(b, "Padova");
  assert(reason.includes("score di area Civiko"));
  assert(reason.includes("Padova"));
  assertEquals(buildHumanReason(undefined), "");
});

import { classifyUrbanSignal, emptyUrbanBuckets } from "./agentRadar.ts";

Deno.test("classifyUrbanSignal: patrimonio_pubblico from alienazione text", () => {
  assertEquals(classifyUrbanSignal("public_asset_disposal_signal", null, "Alienazione immobile comunale", null), "patrimonio_pubblico");
  assertEquals(classifyUrbanSignal(null, null, "Dismissione patrimonio", null), "patrimonio_pubblico");
});

Deno.test("classifyUrbanSignal: mobilita_tram for tram/SFMR/ciclabile", () => {
  assertEquals(classifyUrbanSignal("mobility_dataset", null, "Nuova fermata tram", null), "mobilita_tram");
  assertEquals(classifyUrbanSignal(null, null, "SFMR Padova", null), "mobilita_tram");
  assertEquals(classifyUrbanSignal(null, null, "Pista ciclabile", null), "mobilita_tram");
});

Deno.test("classifyUrbanSignal: opere_pubbliche for cantieri/manutenzione/rotatorie/parcheggi", () => {
  assertEquals(classifyUrbanSignal(null, null, "Manutenzione straordinaria strada", null), "opere_pubbliche");
  assertEquals(classifyUrbanSignal(null, null, "Nuova rotatoria via Roma", null), "opere_pubbliche");
  assertEquals(classifyUrbanSignal(null, null, "Parcheggio interrato", null), "opere_pubbliche");
});

Deno.test("classifyUrbanSignal: urbanistica for variante / PAT / piano interventi", () => {
  assertEquals(classifyUrbanSignal("urban_planning_dataset", null, "Variante al P.I.", null), "urbanistica");
});

Deno.test("classifyUrbanSignal: rigenerazione_urbana for brownfield/rigenerazione", () => {
  assertEquals(classifyUrbanSignal(null, null, "Rigenerazione urbana ex caserma", null), "rigenerazione_urbana");
  assertEquals(classifyUrbanSignal(null, null, "Brownfield redevelopment", null), "rigenerazione_urbana");
});

Deno.test("classifyUrbanSignal: servizi_pubblici for scuola/ospedale/università", () => {
  assertEquals(classifyUrbanSignal(null, null, "Nuovo plesso scolastico", null), "servizi_pubblici");
  assertEquals(classifyUrbanSignal(null, null, "Ospedale di Padova", null), "servizi_pubblici");
});

Deno.test("classifyUrbanSignal: returns null when no urban context", () => {
  assertEquals(classifyUrbanSignal(null, null, "asta giudiziaria", null), null);
  assertEquals(classifyUrbanSignal(null, null, "", null), null);
});

Deno.test("buildAosOnlyBreakdown includes urban fields zeroed", () => {
  const b = buildAosOnlyBreakdown(40, "test:source");
  assertEquals(b.urbanistica, 0);
  assertEquals(b.opere_pubbliche, 0);
  assertEquals(b.mobilita_tram, 0);
  assertEquals(b.patrimonio_pubblico, 0);
  assertEquals(b.rigenerazione_urbana, 0);
  assertEquals(b.servizi_pubblici, 0);
  assertEquals(b.urban_microzone_context, 0);
});

Deno.test("buildHumanReason surfaces urban transformation labels", () => {
  const b = buildAosOnlyBreakdown(0, "test");
  b.patrimonio_pubblico = 6;
  b.mobilita_tram = 4;
  b.urbanistica = 3;
  b.total = 50;
  const reason = buildHumanReason(b, "Padova");
  assert(reason.includes("Patrimonio pubblico"));
  assert(reason.includes("Mobilità / tram"));
});

Deno.test("emptyUrbanBuckets initializes all zero", () => {
  const b = emptyUrbanBuckets();
  assertEquals(b.total, 0);
  assertEquals(b.urbanistica, 0);
});
