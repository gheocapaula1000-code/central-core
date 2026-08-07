// Civiko One commissioning — suite fail-closed.
//
// Verifica: cap minimi non aumentabili, schema chiuso, invarianza delle 8 zone
// ufficiali di Padova, isolamento rispetto alle altre PWA (UEradar/TrovaBandi,
// Wyloni, LuxuRadar), migrazioni additive con RLS senza policy pubbliche.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  CIVIKO_COMMISSIONING_ACTIONS,
  CIVIKO_COMMISSIONING_BODY_SCHEMA,
  CIVIKO_COMMISSIONING_CAPS,
  CIVIKO_COMMISSIONING_CLAIM_TTL_SECONDS,
  CIVIKO_COMMISSIONING_PROVIDERS,
  capExactlyApplied,
  validateCommissioningBody,
} from "../../supabase/functions/civiko-commissioning/caps.ts";
import { CIVIKO_COMMERCIAL_ZONES } from "../../supabase/functions/_shared/civikoCommercialZoneContract.ts";

const ROOT = resolve(__dirname, "../..");
const FN = readFileSync(
  resolve(ROOT, "supabase/functions/civiko-commissioning/index.ts"),
  "utf8",
);
const MIGRATION = (() => {
  const dir = resolve(ROOT, "supabase/migrations");
  const file = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(resolve(dir, f), "utf8"))
    .find((sql) => sql.includes("civiko_commissioning_runs"));
  if (!file) throw new Error("migration civiko_commissioning non trovata");
  return file;
})();

const EXPECTED_ZONES = [
  "centro-storico",
  "nord-arcella",
  "est-brenta",
  "est-forcellini-camin",
  "sud-est-sant-osvaldo",
  "sud-voltabarozzo-guizza",
  "sud-ovest-mandria",
  "ovest-chiesanuova-brentelle",
];

describe("otto zone Padova — invarianti", () => {
  it("il contratto espone esattamente gli 8 slug ufficiali, nell'ordine", () => {
    expect(CIVIKO_COMMERCIAL_ZONES.map((z) => z.slug)).toEqual(EXPECTED_ZONES);
  });

  it("il commissioning non introduce né rinomina slug", () => {
    for (const slug of EXPECTED_ZONES) expect(FN).toContain(slug);
    const slugsInFile = FN.match(/"[a-z]+(?:-[a-z']+)+"/g) ?? [];
    const suspicious = slugsInFile
      .map((s) => s.replace(/"/g, ""))
      .filter((s) => /^(centro|nord|est|sud|ovest)[-a-z']*$/.test(s))
      .filter((s) => !EXPECTED_ZONES.includes(s));
    expect(suspicious).toEqual([]);
  });
});

describe("cap minimi server-side", () => {
  it("valori esatti e non aumentabili dal client", () => {
    expect(CIVIKO_COMMISSIONING_CAPS).toEqual({
      apify: { max_items: 3, max_total_charge_usd: 0.05 },
      firecrawl: { max_pages: 1, max_credits: 1 },
      perplexity: { max_queries: 1, max_completion_tokens: 128 },
    });
    expect(CIVIKO_COMMISSIONING_PROVIDERS).toEqual(["apify", "firecrawl", "perplexity"]);
    expect(CIVIKO_COMMISSIONING_CLAIM_TTL_SECONDS).toBe(600);
  });

  it("nessuna azione accetta cap, url o target dal body", () => {
    for (const fields of Object.values(CIVIKO_COMMISSIONING_BODY_SCHEMA)) {
      for (const f of fields) {
        expect(["run_id", "baseline_snapshot_id"]).toContain(f);
      }
    }
  });

  it("cap mancante o non confermato esattamente ⇒ nessuna conferma", () => {
    const requested = { max_items: 3, max_total_charge_usd: 0.05 };
    expect(capExactlyApplied(requested, requested)).toBe(true);
    expect(capExactlyApplied(requested, null)).toBe(false);
    expect(capExactlyApplied(requested, {})).toBe(false);
    expect(capExactlyApplied(requested, { max_items: 3 })).toBe(false);
    // Anche un cap più restrittivo NON è conferma esatta.
    expect(capExactlyApplied(requested, { max_items: 1, max_total_charge_usd: 0.05 })).toBe(false);
    expect(capExactlyApplied(requested, { max_items: "3", max_total_charge_usd: 0.05 })).toBe(false);
    expect(capExactlyApplied({}, {})).toBe(false);
  });
});

describe("schema chiuso e allowlist", () => {
  it("azione sconosciuta rifiutata", () => {
    expect(validateCommissioningBody({ action: "release_gate" })).toMatchObject({
      ok: false,
      status: 400,
      error: "action_not_allowed",
    });
    expect(validateCommissioningBody({})).toMatchObject({ ok: false });
  });

  it("campi non previsti rifiutati", () => {
    expect(
      validateCommissioningBody({
        action: "civiko_commissioning_microrun_apify",
        max_items: 500,
      }),
    ).toMatchObject({ ok: false, error: "unexpected_field" });
    expect(
      validateCommissioningBody({ action: "civiko_commissioning_baseline", url: "https://x" }),
    ).toMatchObject({ ok: false, error: "unexpected_field" });
  });

  it("verify_delta esige un run_id UUID valido", () => {
    expect(
      validateCommissioningBody({ action: "civiko_commissioning_verify_delta" }),
    ).toMatchObject({ ok: false, error: "invalid_run_id" });
    expect(
      validateCommissioningBody({
        action: "civiko_commissioning_verify_delta",
        run_id: "not-a-uuid",
      }),
    ).toMatchObject({ ok: false, error: "invalid_run_id" });
    expect(
      validateCommissioningBody({
        action: "civiko_commissioning_verify_delta",
        run_id: "11111111-2222-4333-8444-555555555555",
        baseline_snapshot_id: "nope",
      }),
    ).toMatchObject({ ok: false, error: "invalid_baseline_snapshot_id" });
    expect(
      validateCommissioningBody({
        action: "civiko_commissioning_verify_delta",
        run_id: "11111111-2222-4333-8444-555555555555",
      }),
    ).toMatchObject({ ok: true, runId: "11111111-2222-4333-8444-555555555555" });
  });

  it("tutte le azioni dichiarate hanno uno schema", () => {
    for (const a of CIVIKO_COMMISSIONING_ACTIONS) {
      expect(CIVIKO_COMMISSIONING_BODY_SCHEMA[a]).toBeDefined();
    }
  });
});

describe("runtime fail-closed", () => {
  it("auth col secret dell'orchestrator, timing-safe, mai loggato", () => {
    expect(FN).toContain("CIVIKO_ORCHESTRATOR_DISPATCH_SECRET");
    expect(FN).toContain("timingSafeEqual");
    expect(FN).toContain('json(401, { ok: false, error: "unauthorized" })');
    expect(FN).not.toMatch(/console\.(log|error)\([^)]*SECRET[^)]*\)/);
  });

  it("cap non confermato dall'adapter ⇒ BLOCKED e nessuna scansione valida", () => {
    for (const p of CIVIKO_COMMISSIONING_PROVIDERS) {
      expect(FN).toContain(`${p}_cap_not_confirmed`);
    }
    expect(FN).toContain("capExactlyApplied");
  });

  it("provider 200 senza persistenza ⇒ PARTIAL, mai SUCCESS", () => {
    expect(FN).toContain("artifact_persist_failed");
    expect(FN).toContain('"PARTIAL"');
  });

  it("verify_delta: run sconosciuto, delta ambiguo e prova mancante", () => {
    expect(FN).toContain("unknown_run_id");
    expect(FN).toContain("no_persisted_proof");
    expect(FN).toContain("ambiguous_delta");
    expect(FN).toContain("run_not_succeeded");
  });

  it("feed PWA: stessa semantica del feed autenticato, incoerenza ⇒ ok=false", () => {
    expect(FN).toContain("civiko-one-signals-feed");
    expect(FN).toContain("feed_counts_incomplete");
    expect(FN).toContain("admin_workspace_missing");
  });

  it("chain: gate rosso non diventa mai SUCCESS", () => {
    expect(FN).toContain("release_gate_not_passed");
    expect(FN).toContain("chain_not_fully_successful");
  });

  it("concorrenza: claim one-shot per provider e per chain", () => {
    expect(FN).toContain("civiko_commissioning_claim");
    expect(FN).toContain("civiko_commissioning_release_claim");
    expect(FN).toContain("concurrent_microrun_in_flight");
    expect(FN).toContain("concurrent_chain_in_flight");
  });
});

describe("isolamento dalle altre PWA", () => {
  it("il commissioning non referenzia UEradar/TrovaBandi, Wyloni, LuxuRadar", () => {
    for (const forbidden of ["trovabandi", "wyloni", "luxuradar", "luxu_assets"]) {
      expect(FN.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("nessuna funzione esistente importa o cita il commissioning", () => {
    const dir = resolve(ROOT, "supabase/functions");
    const offenders: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "civiko-commissioning") continue;
      const base = resolve(dir, entry.name);
      for (const f of readdirSync(base)) {
        if (!f.endsWith(".ts")) continue;
        const src = readFileSync(resolve(base, f), "utf8");
        if (src.includes("civiko-commissioning") || src.includes("civiko_commissioning")) {
          offenders.push(`${entry.name}/${f}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("migrazione additiva", () => {
  it("crea solo le quattro tabelle di commissioning e non altera oggetti esistenti", () => {
    for (const t of [
      "civiko_commissioning_baselines",
      "civiko_commissioning_runs",
      "civiko_commissioning_artifacts",
      "civiko_commissioning_claims",
    ]) {
      expect(MIGRATION).toContain(`CREATE TABLE IF NOT EXISTS public.${t}`);
      expect(MIGRATION).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
      expect(MIGRATION).toContain(`GRANT ALL ON public.${t} TO service_role`);
    }
    expect(MIGRATION).not.toMatch(/DROP TABLE/i);
    expect(MIGRATION).not.toMatch(/ALTER TABLE public\.padova_/i);
    expect(MIGRATION).not.toMatch(/trovabandi/i);
  });

  it("nessun accesso client: niente grant ad anon/authenticated, nessuna policy", () => {
    expect(MIGRATION).not.toMatch(/TO\s+anon/i);
    expect(MIGRATION).not.toMatch(/TO\s+authenticated/i);
    expect(MIGRATION).not.toMatch(/CREATE POLICY/i);
  });

  it("RPC di claim atomiche, con TTL limitato ed execute al solo service_role", () => {
    expect(MIGRATION).toContain("FUNCTION public.civiko_commissioning_claim");
    expect(MIGRATION).toContain("FUNCTION public.civiko_commissioning_release_claim");
    expect(MIGRATION).toContain("ON CONFLICT (provider) DO UPDATE");
    expect(MIGRATION).toContain("expires_at <= now()");
    expect(MIGRATION).toMatch(/GRANT EXECUTE ON FUNCTION public\.civiko_commissioning_claim/);
    expect(MIGRATION).toMatch(/REVOKE ALL ON FUNCTION public\.civiko_commissioning_claim/);
    expect(MIGRATION).toContain("SET search_path = public");
  });

  it("stati reali vincolati dallo schema", () => {
    expect(MIGRATION).toContain("'RUNNING','SUCCESS','PARTIAL','BLOCKED','FAILED'");
  });
});
