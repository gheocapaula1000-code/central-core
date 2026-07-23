/**
 * D.1–D.16 — Static contract tests for the "Real signal sources v1" intervention.
 *
 * Scope (static / lexical):
 *   Tests marked "STATIC" are executed against the migration SQL text and the
 *   edge-function source code. They catch regressions of the invariants the
 *   migration is meant to introduce without requiring the migration to be
 *   applied.
 *
 * Scope (runtime, post-migration only):
 *   Tests marked with `it.skip(...)` and prefixed `[NON ESEGUITO — richiede
 *   migration applicata]` document runtime checks that must be executed AFTER
 *   the migration is applied and the edge functions are deployed. They are
 *   deliberately skipped, not made into false PASS results.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION = readFileSync(
  resolve("docs/pending-migrations/20260724000000_civiko_one_real_signal_sources_v1.sql"),
  "utf8",
);
const FEED = readFileSync(
  resolve("supabase/functions/civiko-one-signals-feed/index.ts"),
  "utf8",
);
const RUNNER = readFileSync(
  resolve("supabase/functions/civiko-radar-veneto/offmarket/earlyOffmarketRunner.ts"),
  "utf8",
);

describe("D — real signal sources v1 (static contract)", () => {
  // D.1 contendibili da almeno due portali → n_agenzie >= 2 rule OR n_portali>=2
  // The exact policy is: contendibile = n_agenzie >= 2 (mutually exclusive with
  // multi_portale = n_portali >= 2 AND n_agenzie < 2). Both branches require
  // multiple portal/agency signals; a single-source group cannot survive.
  it("D.1 STATIC — contendibile branch requires n_agenzie >= 2", () => {
    expect(MIGRATION).toMatch(/_fg_cont[\s\S]{0,200}n_agenzie\s*>=\s*2/);
  });

  // D.2 nessun gruppo con un solo portale → no branch admits (n_agenzie < 2 AND
  // n_portali < 2). Contendibili needs >=2 agencies; multi_portale needs >=2 portals.
  it("D.2 STATIC — multi_portale branch requires n_portali >= 2 AND n_agenzie < 2", () => {
    expect(MIGRATION).toMatch(/_fg_mp[\s\S]{0,200}n_portali\s*>=\s*2\s*AND\s*n_agenzie\s*<\s*2/);
    // Sanity: there is no branch that accepts singletons.
    expect(MIGRATION).not.toMatch(/n_agenzie\s*>=\s*1\s*AND\s*n_portali\s*>=\s*1/);
  });

  // D.3 nessun gruppo cross-zone — identity_key is prefixed with czone_slug so
  // groups cannot span two commercial zones by construction.
  it("D.3 STATIC — identity_key prefixed with czone_slug (cross-zone impossible)", () => {
    expect(MIGRATION).toMatch(/czone_slug\s*\|\|\s*'\|C:'/);
    expect(MIGRATION).toMatch(/czone_slug\s*\|\|\s*'\|G:'/);
    // Diagnostic explicitly reports 0 by construction.
    expect(MIGRATION).toMatch(/'excluded_cross_zone_groups',\s*0/);
  });

  // D.4 esclusione expired
  it("D.4 STATIC — recompute filters p.expired_at IS NULL", () => {
    expect(MIGRATION).toMatch(/p\.expired_at\s+IS\s+NULL/);
  });

  // D.5 esclusione comune diverso da Padova
  it("D.5 STATIC — recompute filters lower(coalesce(p.comune,''))='padova'", () => {
    expect(MIGRATION).toMatch(/lower\(coalesce\(p\.comune,\s*''\)\)\s*=\s*'padova'/);
  });

  // D.6 UPSERT con ID stabile
  it("D.6 STATIC — UPSERT on chiave_match (id/created_at preserved)", () => {
    expect(MIGRATION).toMatch(/INSERT\s+INTO\s+public\.padova_contendibili[\s\S]+ON\s+CONFLICT\s*\(chiave_match\)\s*DO\s+UPDATE/);
    expect(MIGRATION).toMatch(/INSERT\s+INTO\s+public\.padova_multi_portale[\s\S]+ON\s+CONFLICT\s*\(chiave_match\)\s*DO\s+UPDATE/);
    // No TRUNCATE ... RESTART IDENTITY on the derived tables.
    expect(MIGRATION).not.toMatch(/TRUNCATE\s+TABLE\s+public\.padova_contendibili\s+RESTART\s+IDENTITY/i);
    expect(MIGRATION).not.toMatch(/TRUNCATE\s+TABLE\s+public\.padova_multi_portale\s+RESTART\s+IDENTITY/i);
    // UNIQUE index backs the ON CONFLICT.
    expect(MIGRATION).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+padova_contendibili_chiave_match_uniq/);
  });

  // D.7 rimozione controllata dei gruppi non più validi (delete only stale)
  it("D.7 STATIC — stale-only DELETE (never a mass wipe)", () => {
    expect(MIGRATION).toMatch(
      /DELETE\s+FROM\s+public\.padova_contendibili\s+pc\s+WHERE\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+_fg_cont\s+f\s+WHERE\s+f\.chiave_match\s*=\s*pc\.chiave_match\s*\)/,
    );
    expect(MIGRATION).toMatch(
      /DELETE\s+FROM\s+public\.padova_multi_portale\s+mp\s+WHERE[\s\S]{0,200}NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+_fg_mp\s+f\s+WHERE\s+f\.chiave_match\s*=\s*mp\.chiave_match/,
    );
    // No unconditional wipe.
    expect(MIGRATION).not.toMatch(/DELETE\s+FROM\s+public\.padova_contendibili\s*;/);
    expect(MIGRATION).not.toMatch(/DELETE\s+FROM\s+public\.padova_multi_portale\s*;/);
  });

  // D.8 multi_portale populated within the same recompute
  it("D.8 STATIC — recompute populates padova_multi_portale in same function", () => {
    // The function body contains both INSERTs.
    const fnBody = MIGRATION.slice(
      MIGRATION.indexOf("CREATE OR REPLACE FUNCTION public.recompute_padova_listings_contendibili"),
      MIGRATION.indexOf("$function$;"),
    );
    expect(fnBody).toMatch(/INSERT\s+INTO\s+public\.padova_contendibili/);
    expect(fnBody).toMatch(/INSERT\s+INTO\s+public\.padova_multi_portale/);
  });

  // D.9 viste by_zone filtrabili prima di paginazione/count
  it("D.9 STATIC — feed applies commercial_zone_slug = assignedSlug at DB level for both by_zone views", () => {
    for (const view of ["padova_contendibili_by_zone_v", "padova_multi_portale_by_zone_v"]) {
      const idx = FEED.indexOf(`.from("${view}")`);
      expect(idx, `view ${view} not found in feed`).toBeGreaterThan(-1);
      const chunk = FEED.slice(idx, idx + 800);
      expect(chunk).toMatch(/\.eq\(\s*["']commercial_zone_slug["']\s*,\s*assignedSlug\s*\)/);
    }
    // Views are (re)created explicitly (DROP + CREATE) — signature-safe.
    expect(MIGRATION).toMatch(/DROP\s+VIEW\s+IF\s+EXISTS\s+public\.padova_contendibili_by_zone_v/);
    expect(MIGRATION).toMatch(/CREATE\s+VIEW\s+public\.padova_contendibili_by_zone_v/);
    expect(MIGRATION).toMatch(/DROP\s+VIEW\s+IF\s+EXISTS\s+public\.padova_multi_portale_by_zone_v/);
    expect(MIGRATION).toMatch(/CREATE\s+VIEW\s+public\.padova_multi_portale_by_zone_v/);
  });

  // D.10 ribasso calcolato cronologicamente
  it("D.10 STATIC — v2 RPC computes drops chronologically (LAG over snapshot_date, no MIN/MAX)", () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf("get_padova_verified_price_drops_by_zone_v2"));
    expect(fn).toMatch(/row_number\(\)\s+OVER\s*\(\s*PARTITION\s+BY\s+pl\.id\s+ORDER\s+BY\s+h\.snapshot_date\s+ASC/i);
    expect(fn).toMatch(/LAG\(prezzo\)\s+OVER\s*\(\s*ORDER\s+BY\s+snapshot_date\s+ASC/i);
    // first_price / last_price selected via rn_asc=1 / rn_desc=1, not MIN/MAX(prezzo).
    expect(fn).toMatch(/max\(prezzo\)\s+FILTER\s+\(WHERE\s+rn_asc\s*=\s*1\)\s+AS\s+first_price/);
    expect(fn).toMatch(/max\(prezzo\)\s+FILTER\s+\(WHERE\s+rn_desc\s*=\s*1\)\s+AS\s+last_price/);
  });

  // D.11 no MIN/MAX-based false drops
  it("D.11 STATIC — no MIN(prezzo)/MAX(prezzo) drift used as first/last price", () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf("get_padova_verified_price_drops_by_zone_v2"));
    // The v2 RPC does compute prezzo_min/prezzo_max for the CONTENDIBILI branch on _fg,
    // but the drops calculation in this RPC must never derive first/last price from MIN/MAX.
    expect(fn).not.toMatch(/first_price\s*=\s*MIN\(/i);
    expect(fn).not.toMatch(/last_price\s*=\s*MAX\(/i);
  });

  // D.12 filtro obbligatorio sugli 8 slug nella RPC
  it("D.12 STATIC — RPC v2 enforces the 8-slug whitelist via civiko_commercial_zones", () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf("get_padova_verified_price_drops_by_zone_v2"));
    expect(fn).toMatch(/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public\.civiko_commercial_zones\s+z\s+WHERE\s+z\.slug\s*=\s*p_commercial_zone_slug\s*\)/i);
    // Fail-closed when slug is NULL.
    expect(fn).toMatch(/p_commercial_zone_slug\s+IS\s+NOT\s+NULL/i);
  });

  // D.13 off-market non verificato escluso (trigger fail-closed → quartiere NULL)
  it("D.13 STATIC — EOSC trigger sets NEW.quartiere := NULL when resolution fails", () => {
    const trg = MIGRATION.slice(MIGRATION.indexOf("eosc_resolve_quartiere_trg"));
    expect(trg).toMatch(/NEW\.quartiere\s*:=\s*NULL/);
    // Feed must exclude items whose commercial_zone_slug does not equal the authorized slug.
    // The EOSC by-zone view derives commercial_zone_slug from quartiere via the resolver;
    // a NULL quartiere yields NULL slug, hence not equal to assignedSlug → excluded.
    const idx = FEED.indexOf('.from("early_offmarket_signal_candidates_by_zone_v")');
    expect(idx).toBeGreaterThan(-1);
    const chunk = FEED.slice(idx, idx + 800);
    expect(chunk).toMatch(/\.eq\(\s*["']commercial_zone_slug["']\s*,\s*assignedSlug\s*\)/);
  });

  // D.14 off-market verificato incluso solo nella propria zona
  it("D.14 STATIC — earlyOffmarketRunner persists quartiere only when zone matches exactly", () => {
    expect(RUNNER).toMatch(/commercialZoneForQuartiere/);
    // The runner must NOT persist an arbitrary quartiere unconditionally.
    expect(RUNNER).not.toMatch(/quartiere:\s*rawQuartiere\s*[,}]/);
  });

  // D.15 feed fail-closed quando RPC/view manca o restituisce errore
  it("D.15 STATIC — feed emits diagnostic and zero ribassi on v2 error (no silent fallback)", () => {
    expect(FEED).toContain("rpc_missing_no_fallback");
    expect(FEED).not.toMatch(/rpc\(\s*"get_padova_verified_price_drops_by_zone"\s*,/);
    // Views/tables absent → sourceErrors is populated for contendibili and multi_portale queries.
    expect(FEED).toMatch(/source:\s*"padova_contendibili_by_zone_v"[\s\S]{0,200}category:\s*"query_error"/);
    expect(FEED).toMatch(/source:\s*"padova_multi_portale_by_zone_v"[\s\S]{0,200}category:\s*"query_error"/);
  });

  // D.16 nessun fallback globale, no v1 fallback, no item NULL/cross-zone
  it("D.16 STATIC — feed has no global fallback and forces commercial_zone_slug = authorizedSlug per item", () => {
    // Every built item is stamped with the authorized zone slug (server-side).
    expect(FEED).toContain("commercial_zone_slug: authorizedSlug");
    // No v1 RPC as runtime fallback (already covered by D.15, asserted again for defensiveness).
    expect(FEED).not.toMatch(/rpc\(\s*"get_padova_verified_price_drops_by_zone"\s*,/);
    // No global "fallback_*" or permissive branches.
    expect(FEED).not.toMatch(/fallback_collect_v2/);
  });
});

// ─────────────────────────────────────────────────────────────
// Runtime checks that require the migration to be applied.
// These are DELIBERATELY SKIPPED — do NOT convert them to PASS.
// After the migration is applied, remove `.skip` and run against
// the live DB (with $PGHOST set).
// ─────────────────────────────────────────────────────────────
describe.skip("D — real signal sources v1 (RUNTIME — NON ESEGUITO — richiede migration applicata)", () => {
  it("D.1r contendibili live: every row has agency_count_distinct >= 2", () => { /* runtime */ });
  it("D.3r no live contendibile group spans two commercial zones", () => { /* runtime */ });
  it("D.5r no live contendibile references a listing outside Padova", () => { /* runtime */ });
  it("D.6r double recompute preserves id and created_at for surviving chiave_match", () => { /* runtime */ });
  it("D.8r padova_multi_portale live count > 0 after recompute (given current DB)", () => { /* runtime */ });
  it("D.10r RPC v2 chronologically matches padova_listings_price_history for a sample listing", () => { /* runtime */ });
  it("D.13r EOSC row with unresolvable location_detail lands with quartiere = NULL", () => { /* runtime */ });
});
