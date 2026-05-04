// Pure-logic tests for Agent Radar Veneto.
// Exercises Veneto-only filter, demo fallback, stable shape, ranking helpers.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildAgentRadar,
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
  assertEquals(round.zones.length, 3);
});
