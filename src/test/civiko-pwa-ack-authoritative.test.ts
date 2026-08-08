import { describe, expect, it } from "vitest";
import {
  evaluatePwaAck,
  PWA_DATA_MAX_AGE_MS,
  PWA_REQUIRED_COUNT_KEYS,
} from "../../supabase/functions/civiko-commissioning/pwaAck";
import { readFileSync } from "node:fs";

const NOW = Date.parse("2026-08-08T05:00:00.000Z");

const fullCounts = () =>
  Object.fromEntries(PWA_REQUIRED_COUNT_KEYS.map((k) => [k, 5])) as Record<string, number>;

const input = (o: Partial<Parameters<typeof evaluatePwaAck>[0]> = {}) => ({
  httpStatus: 200,
  feedOk: true,
  counts: fullCounts(),
  freshness: {
    generated_at: "2026-08-08T04:59:00.000Z",
    newest_source_updated_at: "2026-08-08T02:00:00.000Z",
    last_provider_refresh_at: "2026-08-08T01:00:00.000Z",
  },
  clientAck: null,
  chainRunId: "run-1",
  now: NOW,
  ...o,
});

describe("ack PWA autoritativo read-only", () => {
  it("positivo: dati reali e freschi → SUCCESS senza ack client", () => {
    const r = evaluatePwaAck(input());
    expect(r.status).toBe("SUCCESS");
    expect(r.error_code).toBeNull();
    expect(r.ack_source).toBe("core_authoritative_read");
    expect(r.total_readable).toBe(5 * PWA_REQUIRED_COUNT_KEYS.length);
    expect(r.chain_run_id).toBe("run-1");
    expect(r.data_age_ms).toBeGreaterThan(0);
  });

  it("positivo: ack client ok resta l'origine dichiarata", () => {
    const r = evaluatePwaAck(input({ clientAck: { run_id: "pwa-9", ok: true } }));
    expect(r.status).toBe("SUCCESS");
    expect(r.ack_source).toBe("pwa_client_ack");
    expect(r.client_ack_run_id).toBe("pwa-9");
  });

  it("negativo: feed non leggibile → FAILED", () => {
    const r = evaluatePwaAck(input({ httpStatus: 502 }));
    expect(r.status).toBe("FAILED");
    expect(r.error_code).toBe("pwa_feed_unreadable");
  });

  it("negativo: envelope feed non ok", () => {
    const r = evaluatePwaAck(input({ feedOk: false }));
    expect(r.status).toBe("PARTIAL");
    expect(r.error_code).toBe("pwa_feed_not_ok");
  });

  it("negativo: conteggio mancante → incompleto", () => {
    const counts = fullCounts();
    delete (counts as Record<string, unknown>).contendibili;
    const r = evaluatePwaAck(input({ counts }));
    expect(r.error_code).toBe("pwa_counts_incomplete");
    expect(r.status).toBe("PARTIAL");
  });

  it("negativo: nessun dato leggibile → non è SUCCESS", () => {
    const counts = Object.fromEntries(PWA_REQUIRED_COUNT_KEYS.map((k) => [k, 0]));
    const r = evaluatePwaAck(input({ counts }));
    expect(r.error_code).toBe("pwa_counts_empty");
  });

  it("negativo: freshness non attribuibile", () => {
    const r = evaluatePwaAck(
      input({ freshness: { generated_at: "2026-08-08T04:59:00.000Z" } }),
    );
    expect(r.error_code).toBe("pwa_freshness_unknown");
  });

  it("negativo: generated_at invalido", () => {
    const r = evaluatePwaAck(
      input({ freshness: { generated_at: "nope", newest_source_updated_at: "2026-08-08T02:00:00.000Z" } }),
    );
    expect(r.error_code).toBe("pwa_generated_at_invalid");
  });

  it("negativo: dati oltre finestra di freschezza → stale", () => {
    const stale = new Date(NOW - PWA_DATA_MAX_AGE_MS - 60_000).toISOString();
    const r = evaluatePwaAck(
      input({
        freshness: {
          generated_at: "2026-08-08T04:59:00.000Z",
          newest_source_updated_at: stale,
        },
      }),
    );
    expect(r.error_code).toBe("pwa_data_stale");
    expect(r.status).toBe("PARTIAL");
  });

  it("modulo read-only: nessuna scrittura verso il DB", () => {
    const src = readFileSync(
      "supabase/functions/civiko-commissioning/pwaAck.ts",
      "utf8",
    );
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(/fetch\(|\.insert\(|upsert|method: "POST"/i.test(code)).toBe(false);
  });
});

describe("release gate: error_code al root e allo step", () => {
  const src = readFileSync("supabase/functions/civiko-commissioning/index.ts", "utf8");

  it("lo step release_gate espone release_gate_not_passed", () => {
    expect(src.includes('error_code: passed ? null : "release_gate_not_passed"')).toBe(true);
  });

  it("il root dell'envelope 409 espone release_gate_not_passed", () => {
    expect(src.includes('gateBlocked ? "release_gate_not_passed"')).toBe(true);
    expect(src.includes("gate_passed: gateStep ? gateStep.gate_passed === true : null")).toBe(true);
  });

  it("i missing[] restano quelli reali dell'orchestratore", () => {
    expect(
      src.includes("missing: gateStep && Array.isArray(gateStep.missing) ? gateStep.missing : []"),
    ).toBe(true);
  });

  it("lo step sync_pwa usa l'ack autoritativo e non solo la tabella ack", () => {
    expect(src.includes("evaluatePwaAck(")).toBe(true);
    expect(src.includes('fail("PARTIAL", "pwa_ack_missing", 200)')).toBe(false);
  });
});
