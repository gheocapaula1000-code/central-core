import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const INDEX = readFileSync(
  resolve(process.cwd(), "supabase/functions/civiko-commissioning/index.ts"),
  "utf8",
);
const CAPS = readFileSync(
  resolve(process.cwd(), "supabase/functions/civiko-commissioning/caps.ts"),
  "utf8",
);

describe("civiko-commissioning — chain resumibile fail-closed", () => {
  it("accetta esclusivamente resume_run_id nel body della chain", () => {
    expect(CAPS).toContain('civiko_commissioning_chain: ["resume_run_id"]');
    expect(CAPS).toContain('error: "invalid_resume_run_id"');
  });

  it("valida resume_run_id come UUID", () => {
    expect(CAPS).toMatch(/isUuid\(body\.resume_run_id\)/);
  });

  it("esegue un solo step per invocazione", () => {
    expect(INDEX).toContain("result = await runChainStep(CHAIN_STEPS[index]);");
    expect(INDEX).not.toContain("for (const step of CHAIN_STEPS) {");
  });

  it("persiste il progresso reale in counters e resta RUNNING se incompleto", () => {
    expect(INDEX).toContain("step_results: progress.steps");
    expect(INDEX).toContain("next_index: progress.next_index");
    expect(INDEX).toContain('status: "RUNNING",');
  });

  it("non trasforma mai un lavoro incompleto in SUCCESS", () => {
    expect(INDEX).toContain(
      'const finalStatus: CivikoCommissioningStatus = executedAll\n    ? overall\n    : (overall === "SUCCESS" ? "PARTIAL" : overall);',
    );
    expect(INDEX).toContain("ok: done ? finalStatus === \"SUCCESS\" : false,");
  });

  it("si ferma su FAILED/BLOCKED senza proseguire", () => {
    expect(INDEX).toContain(
      '(result.status === "FAILED" || result.status === "BLOCKED")',
    );
  });

  it("rifiuta la ripresa di run non-chain o non RUNNING", () => {
    expect(INDEX).toContain('row.action !== "civiko_commissioning_chain" || row.status !== "RUNNING"');
    expect(INDEX).toContain('error_code: "chain_run_not_resumable"');
  });

  it("rilascia il claim ad ogni invocazione per permettere il resume", () => {
    expect(INDEX).toContain('await releaseClaim("chain", runId);');
  });

  it("restituisce 202 con next_step finché la chain non è completa", () => {
    expect(INDEX).toContain("status: done ? (finalStatus === \"SUCCESS\" ? 200 : 409) : 202,");
    expect(INDEX).toContain("next_step: nextStepKey,");
  });

  it("mantiene invariati gli step ufficiali della chain", () => {
    for (
      const key of [
        "classificazione",
        "contendibili",
        "ribassi_cambi_agenzia",
        "off_market",
        "sync_pwa",
        "release_gate",
      ]
    ) {
      expect(INDEX).toContain(`key: "${key}"`);
    }
  });
});
