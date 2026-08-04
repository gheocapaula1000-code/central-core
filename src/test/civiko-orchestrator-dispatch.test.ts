import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "supabase/functions/civiko-orchestrator-dispatch/index.ts"),
  "utf8",
);
const CONFIG = readFileSync(resolve(process.cwd(), "supabase/config.toml"), "utf8");

describe("civiko-orchestrator-dispatch — contratto statico", () => {
  it("è registrata in config.toml con verify_jwt = false", () => {
    expect(CONFIG).toContain("[functions.civiko-orchestrator-dispatch]");
    const block = CONFIG.split("[functions.civiko-orchestrator-dispatch]")[1] ?? "";
    expect(block.split("[")[0]).toContain("verify_jwt = false");
  });

  it("accetta solo POST", () => {
    expect(SRC).toContain('req.method !== "POST"');
    expect(SRC).toContain('"method_not_allowed"');
    expect(SRC).toMatch(/return json\(405/);
  });

  it("richiede Content-Type application/json", () => {
    expect(SRC).toContain("application/json");
    expect(SRC).toContain('"unsupported_media_type"');
  });

  it("fail-closed su secret mancante con 500 misconfigured", () => {
    expect(SRC).toContain('Deno.env.get("CIVIKO_ORCHESTRATOR_DISPATCH_SECRET")');
    expect(SRC).toMatch(/if \(!DISPATCH_SECRET\)/);
    expect(SRC).toMatch(/return json\(500, \{ ok: false, error: "misconfigured" \}\)/);
  });

  it("rifiuta bearer assente o errato con 401 unauthorized", () => {
    expect(SRC).toContain('auth.startsWith("Bearer ")');
    expect(SRC).toMatch(/return json\(401, \{ ok: false, error: "unauthorized" \}\)/);
  });

  it("usa un confronto timing-safe senza short-circuit su ===", () => {
    expect(SRC).toContain("function timingSafeEqual");
    expect(SRC).toContain("diff |=");
    expect(SRC).not.toContain("bearer === DISPATCH_SECRET");
  });

  it("limita la dimensione del body e valida il JSON", () => {
    expect(SRC).toContain("MAX_BODY_BYTES");
    expect(SRC).toContain('"payload_too_large"');
    expect(SRC).toContain('"invalid_json"');
    expect(SRC).toContain('"invalid_payload"');
  });

  it("respinge action non ammesse", () => {
    expect(SRC).toContain('"action_not_allowed"');
    expect(SRC).toContain("ACTIONS as readonly string[]).includes(action)");
  });

  it("healthcheck non chiama provider né funzioni e ritorna solo booleani", () => {
    const hc = SRC.split('if (action === "healthcheck")')[1]?.split("if (!JOB_SECRET")[0] ?? "";
    expect(hc).not.toContain("fetch(");
    expect(hc).toContain("dispatch_secret: Boolean(DISPATCH_SECRET)");
    expect(hc).toContain("job_secret: Boolean(JOB_SECRET)");
    expect(hc).toContain("supabase_url: Boolean(SUPABASE_URL)");
  });

  it("mappa esattamente le 7 azioni operative sulle funzioni corrette", () => {
    const pairs: Array<[string, string]> = [
      ["apify_immobiliare", "cron-apify-immobiliare-nightly"],
      ["apify_idealista", "cron-apify-idealista-nightly"],
      ["apify_subito", "cron-apify-subito-nightly"],
      ["collect_pending", "padova-apify-collect-pending"],
      ["offmarket_discover", "cron-offmarket-padova-nightly"],
      ["offmarket_scores", "cron-offmarket-padova-nightly"],
      ["early_warning", "cron-offmarket-padova-nightly"],
    ];
    const allow = SRC.split("const ALLOWED")[1]?.split("const ACTIONS")[0] ?? "";
    for (const [action, fn] of pairs) {
      expect(allow).toContain(`${action}: {`);
      const seg = allow.split(`${action}: {`)[1]?.split("},")[0] ?? "";
      expect(seg).toContain(`fn: "${fn}"`);
    }
    expect(allow).toContain("query: \"job=discover-early-offmarket-signals\"");
    expect(allow).toContain("query: \"job=build-offmarket-opportunity-scores\"");
    expect(allow).toContain("query: \"job=build-padova-early-warning\"");
    expect(allow).toContain("body: { stale_minutes: 5, max_runs: 10 }");
  });

  it("non accetta URL o path dal client (anti-SSRF)", () => {
    expect(SRC).not.toMatch(/body\.(url|target_url|path|endpoint|fn)\b/);
    // L'unico URL costruito usa SUPABASE_URL + allowlist hardcoded.
    const urlLines = SRC.split("\n").filter((l) => l.includes("${SUPABASE_URL}"));
    expect(urlLines).toHaveLength(1);
    expect(urlLines[0]).toContain("target.fn");
    expect(urlLines[0]).toContain("target.query");
  });

  it("usa x-job-secret internamente senza mai restituirlo", () => {
    expect(SRC).toContain('"x-job-secret": JOB_SECRET');
    expect(SRC).not.toMatch(/job_secret: JOB_SECRET/);
    const safe = SRC.split("function safeIdentifiers")[1]?.split("Deno.serve")[0] ?? "";
    expect(safe).not.toContain("JOB_SECRET");
    expect(safe).not.toContain("DISPATCH_SECRET");
  });

  it("non logga token, Authorization, payload o secret", () => {
    const logs = SRC.split("\n").filter((l) => l.includes("console."));
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) {
      expect(l).not.toMatch(/bearer|Authorization|DISPATCH_SECRET|JOB_SECRET|rawBody|payload|text/);
    }
  });

  it("non restituisce stack trace", () => {
    expect(SRC).not.toContain(".stack");
    expect(SRC).not.toMatch(/String\(e\)/);
  });

  it("ha timeout controllato e nessun retry interno", () => {
    expect(SRC).toContain("AbortController");
    expect(SRC).toContain("DEFAULT_TIMEOUT_MS");
    expect(SRC).toContain("clearTimeout(timer)");
    expect(SRC).not.toMatch(/for \(let attempt/);
    expect(SRC).not.toMatch(/retr(y|ies)\s*[=<]/i);
  });
});
