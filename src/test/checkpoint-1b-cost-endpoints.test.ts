/**
 * CHECKPOINT 1B — protezione endpoint onerosi.
 *
 * 1. Test funzionali della guardia condivisa requireCivikoCostSecret
 *    (env mockata, nessuna chiamata esterna).
 * 2. Test strutturali su civiko-content-studio, civiko-property-from-photo
 *    e civiko-radar-veneto (ordine della guardia rispetto ai costi).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CANONICAL = "canonical-civiko-secret-32chars-x";
const PROXY = "core-internal-proxy-secret-32chrs";
const DIAG = "diagnostic-secret-value-32charsxx";
const JOB = "central-core-job-secret-32charsxx";

let env: Record<string, string> = {};

// Minimal Deno shim so the edge-shared module can run under vitest.
beforeEach(() => {
  env = {};
  (globalThis as unknown as { Deno: unknown }).Deno = {
    env: { get: (k: string) => env[k] },
  };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as unknown as { Deno?: unknown }).Deno;
});

// The shared module targets Deno; transpile it in isolation (removing the
// remote dynamic import that is never reached by this guard) and load it as a
// data URL, so no external service is ever contacted.
async function guard() {
  const { transform } = await import("esbuild");
  const raw = readFileSync(join(process.cwd(), "supabase/functions/_shared/http.ts"), "utf-8")
    .replace(/await import\("https:\/\/esm\.sh\/[^"]+"\)/g, "({ createClient: () => null })");
  const { code } = await transform(raw, { loader: "ts", format: "esm", target: "es2022" });
  const mod = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return mod.requireCivikoCostSecret as (req: Request, id: string) => Response | null;
}

function req(headers: Record<string, string>): Request {
  return new Request("https://core.test/civiko/content-studio", { method: "POST", headers });
}

describe("1B — requireCivikoCostSecret: rifiuti", () => {
  beforeEach(() => {
    env.AI_CORE_SECRET_CIVIKO = CANONICAL;
    env.CORE_INTERNAL_SECRET = PROXY;
    env.DIAGNOSTIC_SECRET = DIAG;
    env.CENTRAL_CORE_JOB_SECRET = JOB;
  });

  it("source app assente → 401", async () => {
    const g = await guard();
    const r = g(req({ "x-internal-secret": CANONICAL }), "d1");
    expect(r?.status).toBe(401);
  });

  it("source app non ammessa → 401", async () => {
    const g = await guard();
    const r = g(req({ "x-source-app": "wyloni", "x-internal-secret": CANONICAL }), "d2");
    expect(r?.status).toBe(401);
  });

  it("secret assente → 401", async () => {
    const g = await guard();
    const r = g(req({ "x-source-app": "civiko" }), "d3");
    expect(r?.status).toBe(401);
  });

  it("secret errato → 401", async () => {
    const g = await guard();
    const r = g(req({ "x-source-app": "civiko", "x-internal-secret": "wrong-value-here-32-characters-x" }), "d4");
    expect(r?.status).toBe(401);
  });

  it("DIAGNOSTIC_SECRET non autorizza", async () => {
    const g = await guard();
    expect(g(req({ "x-source-app": "civiko", "x-internal-secret": DIAG }), "d5")?.status).toBe(401);
  });

  it("CENTRAL_CORE_JOB_SECRET non autorizza", async () => {
    const g = await guard();
    expect(g(req({ "x-source-app": "civiko", "x-internal-secret": JOB }), "d6")?.status).toBe(401);
  });
});

describe("1B — requireCivikoCostSecret: configurazione e autorizzazioni", () => {
  it("nessun candidato configurato → 500 CONFIG_ERROR", async () => {
    const g = await guard();
    const r = g(req({ "x-source-app": "civiko", "x-internal-secret": CANONICAL }), "d7");
    expect(r?.status).toBe(500);
    const body = await r!.json();
    expect(body.error.code).toBe("CONFIG_ERROR");
  });

  it("secret canonico corretto → autorizzato", async () => {
    env.AI_CORE_SECRET_CIVIKO = CANONICAL;
    const g = await guard();
    expect(g(req({ "x-source-app": "civiko", "x-internal-secret": CANONICAL }), "d8")).toBeNull();
  });

  it("CORE_INTERNAL_SECRET corretto → autorizzato (compat proxy)", async () => {
    env.AI_CORE_SECRET_CIVIKO = CANONICAL;
    env.CORE_INTERNAL_SECRET = PROXY;
    const g = await guard();
    expect(g(req({ "x-source-app": "civiko", "x-internal-secret": PROXY }), "d9")).toBeNull();
  });

  it("civiko, civiko-one, civiko_one autorizzabili", async () => {
    env.AI_CORE_SECRET_CIVIKO = CANONICAL;
    const g = await guard();
    for (const app of ["civiko", "civiko-one", "civiko_one", "CIVIKO-ONE"]) {
      expect(g(req({ "x-source-app": app, "x-internal-secret": CANONICAL }), "d10")).toBeNull();
    }
  });

  it("acquisitionradar autorizzabile solo tramite i candidati previsti", async () => {
    env.AI_CORE_SECRET_ACQUISITIONRADAR = "ar-canonical-secret-32-charactrs";
    env.CORE_INTERNAL_SECRET = PROXY;
    const g = await guard();
    expect(g(req({ "x-source-app": "acquisitionradar", "x-internal-secret": "ar-canonical-secret-32-charactrs" }), "d11")).toBeNull();
    expect(g(req({ "x-source-app": "acquisitionradar", "x-internal-secret": PROXY }), "d12")).toBeNull();
    // il secret canonico di un'altra app Civiko non è un candidato valido qui
    env.AI_CORE_SECRET_CIVIKO = CANONICAL;
    expect(g(req({ "x-source-app": "acquisitionradar", "x-internal-secret": CANONICAL }), "d13")?.status).toBe(401);
  });

  it("accetta i soli header server-side previsti", async () => {
    env.AI_CORE_SECRET_CIVIKO = CANONICAL;
    const g = await guard();
    expect(g(req({ "x-source-app": "civiko", "x-app-secret": CANONICAL }), "d14")).toBeNull();
    expect(g(req({ "x-source-app": "civiko", "x-core-secret": CANONICAL }), "d15")).toBeNull();
    expect(g(req({ "x-source-app": "civiko", authorization: `Bearer ${CANONICAL}` }), "d16")).toBeNull();
  });

  it("nessun valore o frammento del secret nei log e nelle risposte", async () => {
    env.AI_CORE_SECRET_CIVIKO = CANONICAL;
    env.CORE_INTERNAL_SECRET = PROXY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = await guard();
    const r = g(req({ "x-source-app": "civiko", "x-internal-secret": "wrong-value-here-32-characters-x" }), "d17");
    const text = await r!.text();
    const logged = warn.mock.calls.flat().join(" ");
    for (const haystack of [text, logged]) {
      expect(haystack).not.toContain(CANONICAL);
      expect(haystack).not.toContain(PROXY);
      expect(haystack).not.toContain(CANONICAL.slice(0, 8));
      expect(haystack).not.toMatch(/incoming_len|fingerprint/i);
    }
  });
});

describe("1B — guardia condivisa: contratto statico", () => {
  const src = readFileSync(join(process.cwd(), "supabase/functions/_shared/http.ts"), "utf-8");
  const block = src.slice(src.indexOf("export function requireCivikoCostSecret"));

  it("usa constantTimeEqual e non === sui secret", () => {
    expect(block).toMatch(/constantTimeEqual\(incoming, candidate\)/);
    expect(block).not.toMatch(/incoming\s*===/);
  });

  it("non legge DIAGNOSTIC_SECRET né CENTRAL_CORE_JOB_SECRET", () => {
    expect(block).not.toMatch(/DIAGNOSTIC_SECRET|CENTRAL_CORE_JOB_SECRET/);
  });

  it("documenta il fallback temporaneo e la rimozione dopo 1C", () => {
    expect(src).toMatch(/TEMPORARY CORE_INTERNAL_SECRET FALLBACK/);
    expect(src).toMatch(/removed after Checkpoint 1C/);
  });

  it("non modifica requireSecret né resolveExpectedSecret", () => {
    expect(src).toMatch(/export function requireSecret\(req: Request, debugId: string\)/);
    expect(src).toMatch(/function resolveExpectedSecret\(sourceApp: string\)/);
  });
});

describe("1B — civiko-content-studio", () => {
  const src = readFileSync(join(process.cwd(), "supabase/functions/civiko-content-studio/index.ts"), "utf-8");

  it("importa e chiama la guardia condivisa", () => {
    expect(src).toMatch(/requireCivikoCostSecret/);
  });

  it("la guardia precede rate limit, parsing body, provider key, orchestrate e fetch", () => {
    const g = src.indexOf("requireCivikoCostSecret(req, debugId)");
    expect(g).toBeGreaterThan(0);
    for (const marker of ["rateLimit(req, FUNCTION_NAME", "await req.json()", "orchestrate(raw"]) {
      expect(src.indexOf(marker)).toBeGreaterThan(g);
    }
    expect(src.indexOf("LOVABLE_API_KEY")).toBeLessThan(g); // solo dentro funzioni non ancora invocate
    expect(src.slice(g).indexOf("fetch(")).toBeGreaterThan(0);
  });

  it("health e manifest restano pubblici e passivi, metodi non supportati respinti", () => {
    expect(src).toMatch(/if \(req\.method === "OPTIONS"\) return handleOptions\(req\)/);
    expect(src).toMatch(/METHOD_NOT_ALLOWED/);
    const g = src.indexOf("requireCivikoCostSecret(req, debugId)");
    expect(src.indexOf('"health"')).toBeLessThan(g);
    expect(src.indexOf('"manifest"')).toBeLessThan(g);
  });

  it("il rifiuto non produce fallback HTTP 200", () => {
    expect(src).toMatch(/if \(authFailure\) return withIdentity\(authFailure, "unauthorized"\)/);
  });
});

describe("1B — civiko-property-from-photo", () => {
  const src = readFileSync(join(process.cwd(), "supabase/functions/civiko-property-from-photo/index.ts"), "utf-8");

  it("importa e chiama la guardia condivisa", () => {
    expect(src).toMatch(/requireCivikoCostSecret/);
  });

  it("la guardia precede parsing body e orchestrate", () => {
    const g = src.indexOf("requireCivikoCostSecret(req, debugId)");
    expect(g).toBeGreaterThan(0);
    expect(src.indexOf("raw = await req.json()")).toBeGreaterThan(g);
    expect(src.indexOf("await orchestrate(raw")).toBeGreaterThan(g);
  });

  it("health e manifest restano passivi, 405 conservato", () => {
    expect(src).toMatch(/if \(req\.method === "OPTIONS"\) return handleOptions\(req\)/);
    expect(src).toMatch(/METHOD_NOT_ALLOWED/);
  });

  it("il rifiuto non produce fallback HTTP 200", () => {
    expect(src).toMatch(/if \(authFailure\) return withIdentity\(authFailure, "unauthorized"\)/);
  });
});

describe("1B — civiko-radar-veneto heavy gate", () => {
  const src = readFileSync(join(process.cwd(), "supabase/functions/civiko-radar-veneto/index.ts"), "utf-8");
  const block = src.slice(src.indexOf("const HEAVY_JOBS = new Set("), src.indexOf("// Job endpoints"));

  it("authorizeJob precede shouldRunHeavyCron e isMonthlyCapReached", () => {
    const auth = block.indexOf("const _heavyAuth = authorizeJob(req, debugId)");
    expect(auth).toBeGreaterThan(0);
    expect(block.indexOf("shouldRunHeavyCron")).toBeGreaterThan(auth);
    expect(block.indexOf("isMonthlyCapReached")).toBeGreaterThan(auth);
    expect(block.indexOf('await import("../_shared/heavyCronGate.ts")')).toBeGreaterThan(auth);
    expect(block.indexOf('await import("../_shared/monthlyBudget.ts")')).toBeGreaterThan(auth);
  });

  it("l'errore del budget gate è fail-closed (503, nessun job avviato)", () => {
    expect(block).toMatch(/fail-closed/);
    expect(block).not.toMatch(/fail-open/);
    expect(block).toMatch(/json\(req, 503, \{\s*skipped: true, reason: "gate_unavailable"/);
  });

  it("HEAVY_JOBS invariato: 21 path", () => {
    const paths = block.slice(0, block.indexOf("]);")).match(/"\/jobs\/[a-z0-9-]+"/g) ?? [];
    expect(paths.length).toBe(21);
    expect(paths).toContain('"/jobs/padova-daily-radar"');
    expect(paths).toContain('"/jobs/build-civiko-veneto-data-engine"');
  });

  it("le guardie route-specifiche successive restano presenti", () => {
    const after = src.slice(src.indexOf("// Job endpoints"));
    expect((after.match(/authorizeJob\(req, debugId\)/g) ?? []).length).toBeGreaterThan(20);
  });

  it("route dati non heavy restano senza job secret aggiunto", () => {
    expect(src).toMatch(/\/contendibili/);
    expect(src).toMatch(/agent-radar/);
  });
});
