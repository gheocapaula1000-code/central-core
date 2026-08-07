// Civiko-only. Il release_gate interroga PostgREST: una colonna inesistente
// produce HTTP 400, finisce in failed_queries e rende metrics_available=false,
// bloccando il gate in modo permanente e silenzioso.
// Questi test fissano le colonne realmente presenti nello schema.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  "supabase/functions/civiko-orchestrator-dispatch/index.ts",
  "utf8",
);

describe("release_gate — colonne reali dello schema Civiko", () => {
  it("padova_listings non ha created_at: la freschezza usa imported_at", () => {
    expect(SRC).not.toMatch(/padova_listings\?[^`]*created_at=/);
    expect(SRC).toContain("comune=not.ilike.Padova&imported_at=gte.");
    expect(SRC).toContain(
      "comune=ilike.Padova&commercial_zone_slug=is.null&imported_at=gte.",
    );
  });

  it("civiko_pwa_sync_acks non espone received_at nella select", () => {
    expect(SRC).not.toMatch(/civiko_pwa_sync_acks\?select=[^`]*received_at/);
    expect(SRC).toMatch(/civiko_pwa_sync_acks\?select=[^`]*created_at/);
  });

  it("l'audit non scrive la colonna inesistente reason_code", () => {
    expect(SRC).not.toMatch(/^\s*reason_code:/m);
    expect(SRC).toMatch(/^\s*error_code: safeCode\(input\.result\.reason\),/m);
  });

  it("l'audit non invia mai payload jsonb null su colonne NOT NULL", () => {
    expect(SRC).toContain("result: input.result.result ?? {}");
    expect(SRC).toContain("counters: input.result.result ?? {}");
  });

  it("resta fail-closed: metrics_available richiede zero query fallite", () => {
    expect(SRC).toContain(
      "const metricsAvailable = Boolean(SERVICE_KEY) && failedQueries.length === 0;",
    );
    expect(SRC).toContain(
      "const gate_passed = metricsAvailable && requirements.every((r) => r.passed);",
    );
  });

  it("le otto zone ufficiali restano il solo perimetro", () => {
    expect(SRC).toContain("CIVIKO_SCOPE_SLUGS");
    expect(SRC).not.toMatch(/altre-zone/);
  });
});

describe("release_gate — prerequisiti assenti vs query fallite", () => {
  it("l'assenza dell'audit recompute non viene contata come query fallita", () => {
    expect(SRC).toContain('missingPrerequisites.push("contendibili_recompute_audit_absent")');
    expect(SRC).toMatch(/if \(Number\.isFinite\(recomputeActionStartedMs\)\) \{\s*failedQueries\.push\("contendibili_exact_recompute"\);/);
  });

  it("l'assenza del run pipeline_0510 non viene contata come query fallita", () => {
    expect(SRC).toContain('missingPrerequisites.push("pipeline_0510_run_absent")');
    expect(SRC).not.toContain('failedQueries.push("pipeline_0510_exact_run_start")');
  });

  it("espone missing_prerequisites nel payload del gate", () => {
    expect(SRC).toContain("missing_prerequisites: missingPrerequisites,");
  });

  it("resta fail-closed: metricsAvailable dipende ancora solo da failedQueries", () => {
    expect(SRC).toContain(
      "const metricsAvailable = Boolean(SERVICE_KEY) && failedQueries.length === 0;",
    );
  });
});
