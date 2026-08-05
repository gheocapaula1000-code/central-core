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
    expect(hc).toContain("schedule: scheduleContract()");
  });

  it("mantiene le azioni storiche mappate sulle funzioni corrette", () => {
    const pairs: Array<[string, string]> = [
      ["apify_immobiliare", "cron-apify-immobiliare-nightly"],
      ["apify_idealista", "cron-apify-idealista-nightly"],
      ["apify_subito", "cron-apify-subito-nightly"],
      ["collect_pending", "padova-apify-collect-pending"],
      ["offmarket_discover", "cron-offmarket-padova-nightly"],
      ["offmarket_scores", "cron-offmarket-padova-nightly"],
      ["early_warning", "cron-offmarket-padova-nightly"],
    ];
    const allow = SRC.split("const ALLOWED")[1]?.split("const PIPELINES")[0] ?? "";
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

  it("aggiunge le nuove azioni richieste", () => {
    for (
      const a of [
        "portal_casa",
        "radar_full",
        "signals_classify",
        "pipeline_0510",
        "pipeline_0545",
        "pipeline_0710",
        "release_gate",
      ]
    ) {
      expect(SRC).toContain(a);
    }
  });

  it("Casa.it usa esclusivamente enqueue-padova-portal-scrapes", () => {
    const allow = SRC.split("const ALLOWED")[1]?.split("const PIPELINES")[0] ?? "";
    const seg = allow.split("portal_casa: {")[1]?.split("},")[0] ?? "";
    expect(seg).toContain('fn: "enqueue-padova-portal-scrapes"');
    expect(seg).toContain('portals: ["casa.it"]');
    expect(seg).toContain("max_pages");
    expect(SRC).not.toContain("cron-apify-casa-nightly");
    expect(SRC).not.toContain("padova-apify-casa-collect");
    expect(SRC).not.toContain("firecrawl");
  });

  it("radar_full e signals_classify puntano alle funzioni esistenti", () => {
    const allow = SRC.split("const ALLOWED")[1]?.split("const PIPELINES")[0] ?? "";
    const radar = allow.split("radar_full: {")[1]?.split("},")[0] ?? "";
    expect(radar).toContain('fn: "cron-radar-padova-nightly"');
    expect(radar).toContain('query: "mode=full"');
    const cls = allow.split("signals_classify: {")[1]?.split("},")[0] ?? "";
    expect(cls).toContain('fn: "civiko-signals-classify"');
  });

  it("espone il contratto orario Europe/Rome con 05:10, 05:45, 07:10 ed enabled=false", () => {
    expect(SRC).toContain('const SCHEDULE_TIMEZONE = "Europe/Rome"');
    expect(SRC).toContain("const CRON_ENABLED = false");
    expect(SRC).toContain('at: "05:10"');
    expect(SRC).toContain('at: "05:45"');
    expect(SRC).toContain('at: "07:10"');
  });

  it("le pipeline sono sequenziali e fail-closed", () => {
    const seg = SRC.split("if (action in PIPELINES)")[1] ?? "";
    expect(seg).toContain("for (const step of pipeline.steps)");
    expect(seg).toContain("const r = await runAction(step)");
    expect(seg).toContain("if (!r.ok)");
    expect(seg).toContain("break;");
    expect(seg).toContain("failed_at: failedAt");
    // Nessuna esecuzione parallela.
    expect(seg).not.toContain("Promise.all");
  });

  it("le pipeline usano solo step dell'allowlist", () => {
    const pipes = SRC.split("const PIPELINES")[1]?.split("const SCHEDULE_TIMEZONE")[0] ?? "";
    const allowed = [
      "portal_casa",
      "apify_immobiliare",
      "apify_idealista",
      "apify_subito",
      "collect_pending",
      "radar_full",
      "offmarket_discover",
      "offmarket_scores",
      "early_warning",
      "signals_classify",
    ];
    const steps = Array.from(pipes.matchAll(/"([a-z_0-9]+)"/g)).map((m) => m[1]).filter((s) =>
      !/^\d{2}:\d{2}$/.test(s)
    );
    for (const s of steps) expect(allowed).toContain(s);
  });

  it("release_gate usa conteggi reali del database ed è fail-closed", () => {
    expect(SRC).toContain("async function releaseGate()");
    expect(SRC).toContain('Prefer: "count=exact"');
    expect(SRC).toContain("content-range");
    expect(SRC).toContain("cron_activation_allowed");
    expect(SRC).toContain("padova_collect_v2_items");
    expect(SRC).toContain("padova_listings");
    expect(SRC).toContain("civiko_signals_classified");
    // count non verificabile => check non superato.
    expect(SRC).toContain('passed: typeof count === "number" && count >= s.min');
    expect(SRC).toContain("checks.every((c) => c.passed)");
  });

  it("non crea né attiva cron", () => {
    expect(SRC).not.toMatch(/cron\.schedule|pg_cron|cron\.alter_job|cron\.unschedule/);
  });

  it("non accetta URL o path dal client (anti-SSRF)", () => {
    expect(SRC).not.toMatch(/body\.(url|target_url|path|endpoint|fn)\b/);
    // Gli unici URL costruiti usano SUPABASE_URL + allowlist/PostgREST hardcoded.
    const urlLines = SRC.split("\n").filter((l) => l.includes("${SUPABASE_URL}"));
    expect(urlLines).toHaveLength(2);
    expect(urlLines.some((l) => l.includes("target.fn") && l.includes("target.query"))).toBe(true);
    expect(urlLines.some((l) => l.includes("/rest/v1/"))).toBe(true);
  });

  it("usa x-job-secret internamente senza mai restituirlo", () => {
    expect(SRC).toContain('"x-job-secret": JOB_SECRET');
    expect(SRC).not.toMatch(/job_secret: JOB_SECRET/);
    const safe = SRC.split("function safeIdentifiers")[1]?.split("interface StepResult")[0] ?? "";
    expect(safe).not.toContain("JOB_SECRET");
    expect(safe).not.toContain("DISPATCH_SECRET");
    expect(SRC).not.toMatch(/service_key: SERVICE_KEY/);
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
