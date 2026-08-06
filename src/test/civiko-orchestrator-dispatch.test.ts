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
        "contendibili_backfill",
        "contendibili_recompute",
        "contendibili_evidence",
        "contendibili_extras",
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

  it("le azioni di completamento sono hardcoded, isolate e fail-closed", () => {
    const allow = SRC.split("const ALLOWED")[1]?.split("const PIPELINES")[0] ?? "";
    expect(allow).toContain('rpc: "padova_backfill_unit_evidence"');
    expect(allow).toContain("p_batch: 5000");
    expect(allow).toContain("p_force: false");
    expect(allow).toContain('rpc: "recompute_padova_listings_contendibili"');
    expect(allow).toContain('fn: "civiko-contendibili-evidence-refresh"');
    expect(allow).toContain("limit: 24");
    expect(allow).toContain('rpc: "recompute_padova_contendibili_extras"');
    const runner = SRC.split("async function runAction")[1]?.split("// Conteggio reale")[0] ?? "";
    expect(runner).toContain("/rest/v1/rpc/${target.rpc}");
    expect(runner).toContain("apikey: SERVICE_KEY");
    expect(runner).toContain("Authorization: `Bearer ${SERVICE_KEY}`");
    expect(runner).toContain('reason: "service_key_missing"');
  });

  it("propaga solo code/message sanitizzati per RPC PostgREST 400", () => {
    const safe = SRC.split("function safePostgrestReason")[1]?.split("interface StepResult")[0] ?? "";
    const runner = SRC.split("async function runAction")[1]?.split("// Conteggio reale")[0] ?? "";
    expect(SRC).toContain("const SAFE_POSTGREST_CODE");
    expect(SRC).toContain("const UNSAFE_POSTGREST_MESSAGE");
    expect(safe).toContain('typeof src.code === "string"');
    expect(safe).toContain('typeof src.message === "string"');
    expect(safe).toContain("POSTGREST_REASON_MAX_LENGTH");
    expect(safe).not.toMatch(/\bsrc\.(details|hint|error)\b/);
    expect(safe).not.toContain("JSON.stringify");
    expect(runner).toContain("isRpc && res.status === 400");
    expect(runner).toContain("safePostgrestReason(payload)");
    expect(runner).toContain('"postgrest_bad_request"');
    expect(runner).not.toContain("reason: text");
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
      "listings_promote",
      "private_leads_classify",
      "price_snapshot",
      "contendibili_backfill",
      "contendibili_image_certify",
      "contendibili_recompute",
      "contendibili_evidence",
      "contendibili_extras",
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
    expect(SRC).toContain("const GATE_WINDOW_HOURS = 4");
    expect(SRC).toContain("window_hours: GATE_WINDOW_HOURS");
  });

  it("release_gate interroga la prova Casa.it su scraping_queue", () => {
    const seg = SRC.split("function gateSpecs")[1]?.split("async function releaseGate")[0] ?? "";
    expect(seg).toContain("processor_context->>portal=eq.casa.it");
    expect(seg).toContain("status=eq.succeeded");
    expect(seg).toContain("processing_status=eq.succeeded");
    expect(seg).toContain("processing_status=eq.dead");
    expect(seg).toContain("created_at=gte.${since}");
  });

  it("release_gate verifica freschezza Casa.it su collect items e listings", () => {
    const seg = SRC.split("function gateSpecs")[1]?.split("async function releaseGate")[0] ?? "";
    expect(seg).toContain(
      "padova_collect_v2_items?select=id&portal=eq.casa&or=(created_at.gte.${since},updated_at.gte.${since})",
    );
    expect(seg).toContain("padova_listings?select=id&fonte=eq.casa`");
    expect(seg).toContain("fonte=eq.casa&imported_at=gte.${since}");
    expect(seg).toContain("fonte=eq.casa&last_seen_at=gte.${since}");
  });

  it("release_gate conta le categorie dalle stesse sorgenti della PWA", () => {
    const seg = SRC.split("function gateSpecs")[1]?.split("async function releaseGate")[0] ?? "";
    expect(seg).toContain("padova_contendibili_by_zone_v?select=id");
    expect(seg).toContain("agency_count_distinct.gte.2");
    expect(seg).toContain("n_agenzie=gte.3");
    expect(seg).toContain("padova_cambi_agenzia?select=id&is_active=eq.true");
    expect(seg).toContain("tipo_lead=in.(PRIVATO,privato,privato_stanco)");
    expect(seg).toContain("expired_at=is.null");
    expect(seg).toContain("early_offmarket_signal_candidates_by_zone_v?select=id");
    expect(seg).toContain("privacy_safe=eq.true");
    expect(seg).toContain("import_recommendation=eq.importable");
    expect(seg).toContain("status=in.(approved,promoted,importable)");
    expect(seg).toContain("civiko_signals_classified?select=signal_id&updated_at=gte.${since}");
  });

  it("release_gate conta i ribassi dalla RPC usata dalla PWA con guardie reali", () => {
    const seg = SRC.split("async function verifiedPriceDropsCount")[1]?.split("// Metriche reali")[0] ?? "";
    expect(seg).toContain("/rpc/get_padova_verified_price_drops_by_zone_v2");
    expect(seg).toContain("p_min_drop_pct: 5");
    expect(seg).toContain("p_max_age_days: 14");
    expect(seg).toContain('row.url.startsWith("https://")');
    expect(seg).toContain("!isAuctionRecord(row)");
    expect(seg).toContain("Promise.all(batch.map((slug) => callSlug(slug)))");
  });

  it("release_gate raggruppa le metriche nei quattro gruppi richiesti", () => {
    const seg = SRC.split("async function releaseGate")[1] ?? "";
    expect(seg).toContain("imported: {}");
    expect(seg).toContain("casa_pipeline: {}");
    expect(seg).toContain("categories: {}");
    expect(seg).toContain("classified_in_window: {}");
    expect(seg).toContain("metrics,");
  });

  it("release_gate richiede provider succeeded, processor succeeded e nessun dead", () => {
    const seg = SRC.split("async function releaseGate")[1] ?? "";
    expect(seg).toContain('key: "casa_provider_succeeded"');
    expect(seg).toContain('g("casa_pipeline", "queue_provider_succeeded") > 0');
    expect(seg).toContain('key: "casa_processor_succeeded"');
    expect(seg).toContain('g("casa_pipeline", "queue_processor_succeeded") > 0');
    expect(seg).toContain('key: "casa_processor_no_dead"');
    expect(seg).toContain('g("casa_pipeline", "queue_processor_dead") === 0');
  });

  it("release_gate richiede Casa.it fresca su collect e listings", () => {
    const seg = SRC.split("async function releaseGate")[1] ?? "";
    expect(seg).toContain('key: "casa_collect_fresh"');
    expect(seg).toContain('g("casa_pipeline", "collect_items_casa_fresh") > 0');
    expect(seg).toContain('key: "casa_listing_fresh"');
    expect(seg).toContain('g("imported", "listings_casa_imported_in_window") > 0');
    expect(seg).toContain('g("imported", "listings_casa_seen_in_window") > 0');
  });

  it("release_gate richiede ogni categoria PWA singolarmente maggiore di zero", () => {
    const seg = SRC.split("async function releaseGate")[1] ?? "";
    expect(seg).not.toContain("const categoriesSum");
    expect(seg).toContain('key: "pwa_contendibili_non_zero"');
    expect(seg).toContain('key: "pwa_multi_agenzia_non_zero"');
    expect(seg).toContain('key: "pwa_ribassi_non_zero"');
    expect(seg).toContain('key: "pwa_cambi_agenzia_non_zero"');
    expect(seg).toContain('key: "pwa_privati_non_zero"');
    expect(seg).toContain('key: "pwa_offmarket_non_zero"');
    expect(seg).toContain('g("categories", "offmarket_verified") > 0');
  });

  it("gate verde solo se tutti i requisiti passano e le metriche sono disponibili", () => {
    const seg = SRC.split("async function releaseGate")[1] ?? "";
    expect(seg).toContain("const gate_passed = metricsAvailable && requirements.every((r) => r.passed)");
    expect(seg).toContain("const cron_activation_allowed = gate_passed");
    expect(seg).toContain("ok: gate_passed");
  });

  it("ritorna 409 se le metriche ci sono ma il gate non passa, 502 se non verificabili", () => {
    const seg = SRC.split("async function releaseGate")[1] ?? "";
    expect(seg).toContain('payload.error = "metrics_unavailable"');
    expect(seg).toContain("return { status: 502, payload }");
    expect(seg).toContain("return { status: gate_passed ? 200 : 409, payload }");
    expect(SRC).toContain("const gate = await releaseGate()");
    expect(SRC).toContain("return json(gate.status, gate.payload)");
  });

  it("query fallita non viene sostituita da zero e blocca il gate", () => {
    const seg = SRC.split("async function releaseGate")[1] ?? "";
    expect(seg).toContain("if (count === null) failedQueries.push(s.metric)");
    expect(seg).toContain("failedQueries.length === 0");
    expect(seg).toContain("failed_queries");
    // realCount ritorna null (mai 0) quando la query non è verificabile
    const rc = SRC.split("async function realCount")[1]?.split("const GATE_WINDOW_HOURS")[0] ?? "";
    expect(rc).toContain("return null");
    expect(rc).not.toContain("return 0");
  });

  it("cron_activation_allowed è false in ogni percorso non verde", () => {
    const seg = SRC.split("async function releaseGate")[1] ?? "";
    // metriche non disponibili => requirements vuoti => gate_passed false
    expect(seg).toContain("const requirements = metricsAvailable");
    expect(seg).toContain(": [];");
  });


  it("non crea né attiva cron", () => {
    expect(SRC).not.toMatch(/cron\.schedule|pg_cron|cron\.alter_job|cron\.unschedule/);
  });

  it("non accetta URL o path dal client (anti-SSRF)", () => {
    expect(SRC).not.toMatch(/body\.(url|target_url|path|endpoint|fn)\b/);
    // Gli unici URL costruiti usano SUPABASE_URL + allowlist/PostgREST hardcoded.
    expect(SRC).toContain("/functions/v1/${target.fn}");
    expect(SRC).toContain("/rest/v1/rpc/${target.rpc}");
    expect(SRC).toContain("/rest/v1/${pathAndQuery}");
    expect(SRC).toContain("/rest/v1/rpc/get_padova_verified_price_drops_by_zone_v2");
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
