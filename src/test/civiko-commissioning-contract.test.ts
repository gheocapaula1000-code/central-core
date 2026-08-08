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
  authorizeBearer,
  capExactlyApplied,
  validateCommissioningBody,
} from "../../supabase/functions/civiko-commissioning/caps.ts";
import { CIVIKO_COMMERCIAL_ZONES } from "../../supabase/functions/_shared/civikoCommercialZoneContract.ts";

const ROOT = resolve(__dirname, "../..");
const FN = readFileSync(
  resolve(ROOT, "supabase/functions/civiko-commissioning/index.ts"),
  "utf8",
);

// Migrazione additiva della RPC di promozione PWA-ready (commissioning only).
const MIGRATION_SQL = readdirSync(resolve(ROOT, "supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(resolve(ROOT, "supabase/migrations", f), "utf8"))
  .filter((sql) => sql.includes("civiko_commissioning_promote_apify_job"))
  .join("\n");
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
  "nord-est",
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
    // Gli slug non sono mai hardcoded: derivano dal contratto condiviso.
    expect(FN).toContain("CIVIKO_COMMERCIAL_ZONES.map((z) => z.slug)");
    const literals = (FN.match(/"[a-z]+(?:-[a-z']+)+"/g) ?? []).map((s) => s.replace(/"/g, ""));
    const suspicious = literals
      .filter((s) => /^(centro|nord|est|sud|ovest)[-a-z']*$/.test(s))
      .filter((s) => !EXPECTED_ZONES.includes(s));
    expect(suspicious).toEqual([]);
  });
});

describe("cap minimi server-side", () => {
  it("valori esatti e non aumentabili dal client", () => {
    expect(CIVIKO_COMMISSIONING_CAPS).toEqual({
      apify: { max_items: 3, max_total_charge_usd: 0.015 },
      firecrawl: { max_pages: 1, max_credits: 1 },
      perplexity: { max_queries: 1, max_completion_tokens: 128 },
    });
    expect(CIVIKO_COMMISSIONING_PROVIDERS).toEqual(["apify", "firecrawl", "perplexity"]);
    expect(CIVIKO_COMMISSIONING_CLAIM_TTL_SECONDS).toBe(600);
  });

  it("nessuna azione accetta cap, url o target dal body", () => {
    for (const fields of Object.values(CIVIKO_COMMISSIONING_BODY_SCHEMA)) {
      for (const f of fields) {
        expect(["run_id", "baseline_snapshot_id", "resume_run_id"]).toContain(f);
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
    expect(FN).toContain("authorizeBearer(bearer, [DISPATCH_SECRET, CENTRAL_CORE_API_KEY, AI_CORE_SECRET])");
    expect(FN).toContain('json(authz.status, { ok: false, error: authz.error })');
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
    // Solo codice eseguibile: i commenti possono nominare le PWA escluse.
    const code = FN.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of ["trovabandi", "wyloni", "luxuradar", "luxu_assets"]) {
      expect(code.toLowerCase()).not.toContain(forbidden);
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

const SRC = FN;

describe("Civiko commissioning — aderenza allo schema DB reale", () => {
  it("padova_listings: attivo = expired_at IS NULL, mai stato/created_at/updated_at", () => {
    expect(SRC).toContain("padova_listings?select=id&expired_at=is.null");
    expect(SRC).not.toMatch(/padova_listings[^"']*stato=eq/);
    expect(SRC).not.toMatch(/padova_listings\?select=[^"']*\bcreated_at\b/);
    expect(SRC).not.toMatch(/padova_listings\?select=[^"']*\bupdated_at\b/);
    expect(SRC).toMatch(/padova_listings\?select=imported_at,last_seen_at,expired_at/);
  });

  it("padova_apify_runs: usa started_at/finished_at, mai created_at", () => {
    expect(SRC).toMatch(/padova_apify_runs\?select=[^"']*started_at/);
    expect(SRC).not.toMatch(/padova_apify_runs\?select=[^"']*\bcreated_at\b/);
    expect(SRC).not.toMatch(/padova_apify_runs[^"']*order=created_at/);
  });

  it("civiko_pwa_sync_acks: colonne reali, nessun received_at", () => {
    expect(SRC).not.toMatch(/received_at/);
    for (const col of [
      "started_at", "finished_at", "created_at", "counts",
      "scope_comune", "scope_slugs", "municipality", "commercial_zone_slugs",
    ]) {
      expect(SRC).toMatch(new RegExp(`civiko_pwa_sync_acks\\?select=[^"']*${col}`));
    }
  });

  it("padova_cambi_agenzia: filtro is_active, nessun campo stato", () => {
    expect(SRC).toContain("padova_cambi_agenzia?select=id&is_active=is.true");
    expect(SRC).not.toMatch(/padova_cambi_agenzia[^"']*stato=eq/);
  });
});

describe("Civiko commissioning — prova persistita provider-specifica", () => {
  it("firecrawl e perplexity sono BLOCKED: nessun writer di dominio Civiko", () => {
    expect(SRC).toMatch(/firecrawl:\s*\{\s*\n\s*table: "padova_listings",\s*\n\s*writer_available: false/);
    expect(SRC).toMatch(/perplexity:\s*\{\s*\n\s*table: "civiko_signals_classified",\s*\n\s*writer_available: false/);
    expect(SRC).toContain("_no_civiko_persistence");
    // fail-closed prima di qualsiasi spesa
    expect(SRC).toMatch(/if \(!persistenceSpec\.writer_available\)[\s\S]{0,400}actual_cost_usd: 0/);
  });

  it("HTTP 200 del provider senza riga di dominio non diventa mai SUCCESS", () => {
    expect(SRC).toMatch(/outcome\.status === "SUCCESS" && !proof[\s\S]{0,120}finalStatus = "BLOCKED"/);
  });

  it("gli artifact di audit non contano come prova nel verify-delta", () => {
    expect(SRC).toContain("isCivikoDomainProofTable");
    expect(SRC).toContain("civiko_commissioning_artifacts");
    expect(SRC).toMatch(/domainArtifacts = \(artifacts \?\? \[\]\)\.filter/);
    expect(SRC).toContain("no_persisted_proof");
    expect(SRC).toContain("ambiguous_delta");
  });

  it("apify: prova cercata su padova_apify_runs legata al run reale", () => {
    expect(SRC).toMatch(/padova_apify_runs\?run_id=eq\./);
  });
});

describe("micro-run apify: solo percorso Civiko esistente", () => {
  it("non avvia mai l'actor Apify direttamente", () => {
    expect(SRC).not.toContain("api.apify.com/v2/acts/");
    expect(SRC).not.toContain("actor-runs/");
    expect(SRC).not.toContain("emastra~subito-it-immobili");
    expect(SRC).not.toContain("APIFY_API_TOKEN");
  });

  it("usa padova-apify-subito-collect con cap server-side e nessun dry_run", () => {
    expect(SRC).toContain('APIFY_MICRORUN_COLLECTOR = "padova-apify-subito-collect"');
    expect(SRC).toMatch(/functions\/v1\/\$\{APIFY_MICRORUN_COLLECTOR\}/);
    expect(SRC).toContain("max_items: requested.max_items");
    expect(SRC).toContain("wait_seconds: APIFY_COLLECT_WAIT_SECONDS");
    expect(SRC).not.toContain("dry_run: true");
    expect(SRC).not.toContain("async_start: true");
  });

  it("singola URL Padova per il micro-run", () => {
    expect(SRC).toContain("search_urls: [APIFY_MICRORUN_SEARCH_URL]");
    expect(SRC).toContain("/vendita/appartamenti/padova/padova/");
  });

  it("cap monetario allineato alla formula reale max_items*5/1000", () => {
    expect(CIVIKO_COMMISSIONING_CAPS.apify.max_total_charge_usd).toBe(
      Number(((CIVIKO_COMMISSIONING_CAPS.apify.max_items * 5) / 1000).toFixed(3)),
    );
    expect(CIVIKO_COMMISSIONING_CAPS.apify.max_total_charge_usd).toBe(0.015);
    expect(SRC).toContain("apify_cap_formula_mismatch");
    // Cap applicato riletto dalla riga reale, non da un echo provider.
    expect(SRC).toContain("max_total_charge_usd: Number(runRow.cost_cap_usd ?? NaN)");
    expect(SRC).not.toContain("maxTotalChargeUsd");
  });

  it("prova di dominio: padova_apify_runs SUCCEEDED + righe staging del job_id", () => {
    expect(SRC).toContain('String(row.status ?? "") !== "SUCCEEDED"');
    expect(SRC).toContain("padova_collect_v2_items?select=id&job_id=eq.");
    expect(SRC).toContain("created + updated > 0");
    expect(SRC).toContain("apify_staging_rows_missing");
    expect(SRC).toContain("apify_run_not_succeeded");
    expect(SRC).toContain("apify_run_row_missing");
  });

  it("attivazione mai consentita da un micro-run", () => {
    expect(SRC).toContain("activation_allowed: false");
    expect(SRC).not.toContain("activation_allowed: true");
  });

  it("preflight/health/baseline restano a costo zero senza chiamare Apify", () => {
    const healthIdx = SRC.indexOf("civiko_commissioning_healthcheck");
    expect(healthIdx).toBeGreaterThan(-1);
    // La chiamata al collector avviene solo dentro apifyMicroRun.
    const calls = SRC.match(/APIFY_MICRORUN_COLLECTOR\}/g) ?? [];
    expect(calls.length).toBe(1);
  });
});


describe("promozione PWA-ready Apify (RPC Civiko isolata)", () => {
  it("il micro-run chiama la RPC dedicata con job_id e run_id", () => {
    expect(SRC).toContain('"civiko_commissioning_promote_apify_job"');
    expect(SRC).toContain("{ p_job_id: jobId, p_run_id: runId }");
    // Non invoca la RPC globale esistente (solo menzione in commento).
    expect(SRC).not.toMatch(/rpc\(\s*"promote_padova_collect_v2_to_listings"/);
    expect(SRC).not.toMatch(/rpc\/promote_padova_collect_v2_to_listings/);
  });

  it("SUCCESS solo con writes>0, out_of_scope_written=0 e URL promossi", () => {
    expect(SRC).toContain("apify_promotion_rpc_failed");
    expect(SRC).toContain("apify_promotion_no_writes");
    expect(SRC).toContain("apify_promotion_out_of_scope_written");
    expect(SRC).toContain("apify_promotion_no_urls");
    expect(SRC).toContain("promoWrites) || promoWrites <= 0");
    expect(SRC).toContain("promoOutOfScope) || promoOutOfScope !== 0");
  });

  it("prova attribuibile: padova_listings con last_seen_at >= started_at del micro-run", () => {
    expect(SRC).toMatch(/padova_listings\?select=id,url,fonte,comune,quartiere,last_seen_at/);
    expect(SRC).toContain("last_seen_at=gte.${encodeURIComponent(startedAt)}");
    expect(SRC).toContain("apify_pwa_listing_proof_missing");
    expect(SRC).toContain("promoUrls.every((u) => freshUrls.has(u))");
  });

  it("il solo staging non è più prova di dominio", () => {
    expect(SRC).toMatch(/apify:\s*\{[\s\S]{0,400}table: "padova_listings",[\s\S]{0,200}writer_available: true/);
    // Il proof restituito è padova_listings, non lo staging.
    expect(SRC).not.toContain('table_name: "padova_collect_v2_items"');
  });

  it("gli stati reali restano fail-closed (BLOCKED/PARTIAL, mai SUCCESS finto)", () => {
    const successes = SRC.match(/status: "SUCCESS"/g) ?? [];
    // apify + firecrawl + perplexity adapters, nessuna scorciatoia extra.
    expect(successes.length).toBeLessThanOrEqual(3);
    expect(SRC).toContain('status: "BLOCKED"');
    expect(SRC).toContain('status: "PARTIAL"');
  });
});

describe("RPC SQL civiko_commissioning_promote_apify_job", () => {
  const SQL = MIGRATION_SQL;

  it("esiste una migrazione additiva che crea la RPC", () => {
    expect(SQL).toContain("CREATE OR REPLACE FUNCTION public.civiko_commissioning_promote_apify_job");
    expect(SQL).toContain("p_job_id text");
    expect(SQL).toContain("p_run_id uuid");
    expect(SQL).toContain("SECURITY DEFINER");
    expect(SQL).toContain("SET search_path TO 'public'");
    // Nessuna ridefinizione di funzioni esistenti.
    expect(SQL).not.toContain("FUNCTION public.promote_padova_collect_v2_to_listings");
    expect(SQL).not.toMatch(/DROP\s+(TABLE|FUNCTION)/i);
  });

  it("scope chiuso: solo job_id, comune Padova, max 3 righe", () => {
    expect(SQL).toContain("job_id = p_job_id");
    expect(SQL).toContain("public.civiko_is_comune_padova(citta)");
    expect(SQL).toContain("v_max_rows constant int := 3");
    expect(SQL).toContain("LIMIT v_max_rows");
  });

  it("ritorna i contatori richiesti e gli URL promossi", () => {
    for (const k of ["'scanned'", "'kept'", "'new'", "'updated'", "'writes'", "'out_of_scope_written'", "'urls'", "'run_id'"]) {
      expect(SQL).toContain(k);
    }
  });

  it("audit legato al run di commissioning", () => {
    expect(SQL).toContain("INSERT INTO public.civiko_commissioning_artifacts");
    expect(SQL).toContain("FROM public.civiko_commissioning_runs r WHERE r.run_id = p_run_id");
  });

  it("ACL fail-closed: nessun accesso public/anon/authenticated", () => {
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public.civiko_commissioning_promote_apify_job(text, uuid) FROM PUBLIC");
    expect(SQL).toContain("FROM anon");
    expect(SQL).toContain("FROM authenticated");
    expect(SQL).toContain("GRANT EXECUTE ON FUNCTION public.civiko_commissioning_promote_apify_job(text, uuid) TO service_role");
    expect(SQL).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.civiko_commissioning_promote_apify_job\(text, uuid\) TO (anon|authenticated)/);
  });

  it("input mancanti sono rifiutati fail-closed", () => {
    expect(SQL).toContain("'job_id_required'");
    expect(SQL).toContain("'run_id_required'");
  });

  it("le 8 zone restano invariate anche nella migrazione", () => {
    const slugs = SQL.match(/"(centro|nord|est|sud|ovest)[-a-z']*"/g) ?? [];
    expect(slugs).toEqual([]);
    expect(EXPECTED_ZONES).toHaveLength(8);
  });
});

describe("Civiko commissioning — auth Bearer (primary/fallback/missing/wrong)", () => {
  const PRIMARY = "civiko-dispatch-secret-aaaaaaaaaaaaaaaa";
  const FALLBACK = "central-core-api-key-bbbbbbbbbbbbbbbb";
  const LEGACY = "ai-core-secret-legacy-cccccccccccccccc";

  it("accetta il secret primario dell'orchestrator", () => {
    expect(authorizeBearer(PRIMARY, [PRIMARY, FALLBACK])).toEqual({ ok: true, status: 200, error: null });
  });

  it("accetta il fallback CENTRAL_CORE_API_KEY già esistente", () => {
    expect(authorizeBearer(FALLBACK, [PRIMARY, FALLBACK])).toEqual({ ok: true, status: 200, error: null });
  });

  it("accetta il fallback anche se il primario non è configurato", () => {
    expect(authorizeBearer(FALLBACK, ["", FALLBACK]).ok).toBe(true);
  });

  it("401 se il bearer non coincide con nessun secret", () => {
    expect(authorizeBearer("wrong-token", [PRIMARY, FALLBACK])).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });

  it("401 se il bearer è assente", () => {
    expect(authorizeBearer("", [PRIMARY, FALLBACK]).status).toBe(401);
  });

  it("accetta il fallback legacy AI_CORE_SECRET", () => {
    expect(authorizeBearer(LEGACY, [PRIMARY, FALLBACK, LEGACY])).toEqual({ ok: true, status: 200, error: null });
  });

  it("accetta AI_CORE_SECRET anche se gli altri due non sono configurati", () => {
    expect(authorizeBearer(LEGACY, ["", "", LEGACY]).ok).toBe(true);
  });

  it("401 con bearer errato anche in presenza dei tre candidati", () => {
    expect(authorizeBearer("wrong-token", [PRIMARY, FALLBACK, LEGACY])).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });

  it("401 con bearer assente in presenza dei tre candidati", () => {
    expect(authorizeBearer("", [PRIMARY, FALLBACK, LEGACY]).status).toBe(401);
  });

  it("500 solo se tutti e tre i secret sono assenti", () => {
    expect(authorizeBearer(PRIMARY, ["", ""])).toEqual({ ok: false, status: 500, error: "misconfigured" });
    expect(authorizeBearer(LEGACY, ["", "", ""])).toEqual({ ok: false, status: 500, error: "misconfigured" });
  });

  it("nessun valore di secret viene loggato o restituito", () => {
    const res = authorizeBearer("wrong-token", [PRIMARY, FALLBACK]);
    expect(JSON.stringify(res)).not.toContain(PRIMARY);
    expect(JSON.stringify(res)).not.toContain(FALLBACK);
    expect(JSON.stringify(res)).not.toContain(LEGACY);
    const CAPS_SRC = readFileSync(
      resolve(__dirname, "../../supabase/functions/civiko-commissioning/caps.ts"),
      "utf8",
    );
    expect(CAPS_SRC).not.toMatch(/console\.[a-z]+\([^)]*secret/i);
    expect(SRC).not.toMatch(/console\.[a-z]+\([^)]*(DISPATCH_SECRET|CENTRAL_CORE_API_KEY|bearer)/);
  });

  it("l'handler usa authorizeBearer con entrambi i secret", () => {
    expect(SRC).toContain('Deno.env.get("CENTRAL_CORE_API_KEY")');
    expect(SRC).toContain("authorizeBearer(bearer, [DISPATCH_SECRET, CENTRAL_CORE_API_KEY, AI_CORE_SECRET])");
  });
});

describe("Civiko commissioning — contratto verify_delta", () => {
  it("emette audit_excluded, delta_new/updated, writes, sample_ids, pwa_ready", () => {
    expect(SRC).toContain("audit_excluded: true");
    expect(SRC).toContain("delta_new: deltaNew");
    expect(SRC).toContain("delta_updated: deltaUpdated");
    expect(SRC).toContain("writes,");
    expect(SRC).toContain("sample_ids: sampleIds");
    expect(SRC).toContain("pwa_ready: pwaReady");
  });

  it("i valori derivano solo dagli artifact padova_listings del run", () => {
    expect(SRC).toContain('domainArtifacts.filter((a) => a.table_name === "padova_listings")');
    expect(SRC).toMatch(/listingArtifacts[\s\S]{0,900}ev\.listing_ids/);
    expect(SRC).toMatch(/listingArtifacts[\s\S]{0,900}ev\.promotion_new/);
  });

  it("sample_ids accetta solo id numerici o stringa/UUID non vuoti", () => {
    expect(SRC).toContain('typeof id === "number" && Number.isFinite(id)');
    expect(SRC).toContain('typeof id === "string" && id.length > 0');
  });

  it("fail-closed: senza prova padova_listings il verify non è ok", () => {
    expect(SRC).toContain("const listingProof = listingArtifacts.length > 0 && writes > 0 && sampleIds.length > 0 && pwaReady");
    expect(SRC).toContain('"no_pwa_listing_proof"');
    expect(SRC).toContain("persistedProof && updateProof && listingProof");
  });

  it("il micro-run Apify persiste listing_ids nell'evidence", () => {
    expect(SRC).toContain("listing_ids: listingIds");
    expect(SRC).toContain("promotion_writes: promoWrites");
  });
});
