// Test statici: contratto semantico di collect-pending verso l'orchestratore.
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SRC = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("accetta i requisiti fail-closed del dispatcher", () => {
  assertStringIncludes(SRC, "body.require_candidates === true");
  assertStringIncludes(SRC, "body.require_terminal === true");
  assertStringIncludes(SRC, "body.required_portals");
});

Deno.test("espone i contatori richiesti", () => {
  for (
    const k of [
      "scanned:",
      "completed_count:",
      "imports_count:",
      "pending_count:",
      "errors_count:",
      "required_portals_complete:",
      "zero_novelty:",
    ]
  ) {
    assertStringIncludes(SRC, k);
  }
});

Deno.test("HTTP 200 non è più un successo automatico", () => {
  assert(!SRC.includes("ok: true, scanned: candidates.length"));
  assertStringIncludes(SRC, "pendingCount === 0");
  assertStringIncludes(SRC, "collectHttpStatus");
});

Deno.test("zero novità richiede catena completata, zero pending e zero import", () => {
  assertStringIncludes(SRC, "pendingCount === 0 && results.every");
});

Deno.test("drena dataset paginati e webhooks Apify", () => {
  assertStringIncludes(SRC, "fetchDatasetPaged");
  assertStringIncludes(SRC, "extractCollectRunIds");
  assertStringIncludes(SRC, "expireStaleScrapeJobs");
});

Deno.test("watchdog: i job RUNNING non restano aperti per sempre", () => {
  assertStringIncludes(SRC, "expireStaleScrapeJobs");
  assertStringIncludes(SRC, "WATCHDOG_ERROR");
  assert(!SRC.includes('if (d && d.status === "RUNNING") continue'));
});
