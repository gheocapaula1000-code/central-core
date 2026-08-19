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
      "scanned,",
      "completed_count:",
      "imports_count:",
      "errors:",
      "required_portals_complete:",
      "zero_novelty:",
    ]
  ) {
    assertStringIncludes(SRC, k);
  }
});

Deno.test("HTTP 200 non è più un successo automatico", () => {
  assert(!SRC.includes("ok: true, scanned: candidates.length"));
  assertStringIncludes(SRC, "const ok = failures.length === 0;");
  assertStringIncludes(SRC, "status: ok ? 200 : 422");
});

Deno.test("zero novità richiede catena completata e zero errori", () => {
  assertStringIncludes(
    SRC,
    "const zeroNovelty = errorsCount === 0 && completedCount > 0 && importsCount === 0;",
  );
});

Deno.test("watchdog: i job RUNNING non restano aperti per sempre", () => {
  assertStringIncludes(SRC, "expireStaleScrapeJobs");
  assertStringIncludes(SRC, "WATCHDOG_ERROR");
  assert(!SRC.includes('if (d && d.status === "RUNNING") continue'));
});
