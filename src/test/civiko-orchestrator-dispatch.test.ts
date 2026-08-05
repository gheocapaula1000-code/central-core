import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(
    process.cwd(),
    "supabase/functions/civiko-orchestrator-dispatch/index.ts",
  ),
  "utf8",
);

describe("civiko-orchestrator-dispatch — Casa.it e pipeline fail-closed", () => {
  it("mappa Casa.it solo sulla coda multipagina già esistente", () => {
    const allow =
      SRC.split("const ALLOWED")[1]?.split("const PIPELINES")[0] ?? "";
    expect(allow).toContain("portal_casa: {");
    expect(allow).toContain('fn: "enqueue-padova-portal-scrapes"');
    expect(allow).toContain('portals: ["casa.it"]');
    expect(allow).toContain('mode: "full"');
  });

  it("espone le tre pipeline nell'ordine richiesto", () => {
    expect(SRC).toMatch(
      /pipeline_0510:\s*\[\s*"apify_immobiliare",\s*"apify_idealista",\s*"portal_casa",\s*"apify_subito",?\s*\]/,
    );
    expect(SRC).toMatch(
      /pipeline_0545:\s*\[\s*"collect_pending",\s*"radar_full",\s*"signals_classify",?\s*\]/,
    );
    expect(SRC).toMatch(
      /pipeline_0710:\s*\[\s*"offmarket_discover",\s*"offmarket_scores",\s*"early_warning",?\s*\]/,
    );
  });

  it("esegue le pipeline in sequenza e si ferma al primo errore", () => {
    const pipeline =
      SRC.split("async function runPipeline")[1]?.split(
        "async function releaseGate",
      )[0] ?? "";
    expect(pipeline).toContain("for (const step of PIPELINES[action])");
    expect(pipeline).toContain("await runTarget(step)");
    expect(pipeline).toContain("if (!result.ok)");
    expect(pipeline).toContain("failed_step: step");
    expect(pipeline).toContain("fail_closed: true");
  });

  it("considera fallita anche una risposta HTTP 200 con payload ok=false", () => {
    expect(SRC).toContain(
      "const payloadOk = !isObject(payload) || payload.ok !== false",
    );
    expect(SRC).toContain("const ok = res.ok && payloadOk");
  });

  it("usa metriche DB reali per import Casa e categorie", () => {
    expect(SRC).toContain('from("padova_listings")');
    expect(SRC).toContain('.eq("fonte", "casa.it")');
    expect(SRC).toContain('from("scraping_queue")');
    expect(SRC).toContain(
      'contains("processor_context", { portal: "casa.it" })',
    );
    expect(SRC).toContain('from("padova_contendibili")');
    expect(SRC).toContain('from("early_offmarket_signal_candidates")');
  });

  it("nega l'attivazione cron se la prova reale non passa", () => {
    expect(SRC).toContain("cron_activation_allowed: gatePassed");
    expect(SRC).toContain("return json(gatePassed ? 200 : 409, payload)");
    expect(SRC).toContain("processor_dead_in_window");
  });

  it("dichiara Europe/Rome e gli orari senza attivare cron", () => {
    expect(SRC).toContain('timezone: "Europe/Rome"');
    expect(SRC).toContain('times: ["05:10", "05:45", "07:10"]');
    expect(SRC).toContain("enabled: false");
    expect(SRC).not.toContain("cron.schedule");
  });

  it("non accetta URL, path o body dal client", () => {
    expect(SRC).not.toMatch(/parsed\.(url|target_url|path|endpoint|fn|body)\b/);
    expect(SRC).not.toMatch(/body\.(url|target_url|path|endpoint|fn)\b/);
  });

  it("accetta solo POST e richiede JSON", () => {
    expect(SRC).toContain('req.method !== "POST"');
    expect(SRC).toContain('"method_not_allowed"');
    expect(SRC).toContain('"unsupported_media_type"');
    expect(SRC).toContain('"invalid_json"');
    expect(SRC).toContain('"invalid_payload"');
  });

  it("fallisce chiuso se il dispatch secret manca", () => {
    expect(SRC).toContain(
      'Deno.env.get("CIVIKO_ORCHESTRATOR_DISPATCH_SECRET")',
    );
    expect(SRC).toMatch(/if \(!DISPATCH_SECRET\)/);
    expect(SRC).toContain(
      'return json(500, { ok: false, error: "misconfigured" })',
    );
  });

  it("rifiuta bearer errati con confronto timing-safe", () => {
    expect(SRC).toContain('auth.startsWith("Bearer ")');
    expect(SRC).toContain("function timingSafeEqual");
    expect(SRC).toContain("diff |=");
    expect(SRC).not.toContain("bearer === DISPATCH_SECRET");
    expect(SRC).toContain('json(401, { ok: false, error: "unauthorized" })');
  });

  it("mantiene le sette azioni operative storiche", () => {
    const allow =
      SRC.split("const ALLOWED")[1]?.split("const PIPELINES")[0] ?? "";
    const pairs: Array<[string, string]> = [
      ["apify_immobiliare", "cron-apify-immobiliare-nightly"],
      ["apify_idealista", "cron-apify-idealista-nightly"],
      ["apify_subito", "cron-apify-subito-nightly"],
      ["collect_pending", "padova-apify-collect-pending"],
      ["offmarket_discover", "cron-offmarket-padova-nightly"],
      ["offmarket_scores", "cron-offmarket-padova-nightly"],
      ["early_warning", "cron-offmarket-padova-nightly"],
    ];
    for (const [action, fn] of pairs) {
      expect(allow).toContain(`${action}: {`);
      expect(allow.split(`${action}: {`)[1]?.split("},")[0] ?? "").toContain(
        `fn: "${fn}"`,
      );
    }
  });

  it("non espone segreti nelle risposte o nei log", () => {
    expect(SRC).not.toMatch(/job_secret: JOB_SECRET/);
    const safe =
      SRC.split("function safeIdentifiers")[1]?.split(
        "interface StepResult",
      )[0] ?? "";
    expect(safe).not.toContain("JOB_SECRET");
    expect(safe).not.toContain("DISPATCH_SECRET");
    for (const line of SRC.split("\n").filter((l) => l.includes("console."))) {
      expect(line).not.toMatch(
        /bearer|Authorization|DISPATCH_SECRET|JOB_SECRET|rawBody|SERVICE_KEY/,
      );
    }
  });

  it("usa timeout controllato e nessun retry interno", () => {
    expect(SRC).toContain("AbortController");
    expect(SRC).toContain("DEFAULT_TIMEOUT_MS");
    expect(SRC).toContain("clearTimeout(timer)");
    expect(SRC).not.toMatch(/for \(let attempt/);
  });
});
