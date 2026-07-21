// Static hardening test for supabase/functions/civiko-one-signals-feed/index.ts
// Verifica per grep del file sorgente che il perimetro zona sia rispettato.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(__dirname, "../../supabase/functions/civiko-one-signals-feed/index.ts"),
  "utf8",
);

describe("civiko-one-signals-feed — static zone-isolation contract", () => {
  it("valida x-tenant-id come UUID (workspace) server-side", () => {
    expect(SRC).toMatch(/UUID_RE\s*=\s*\/\^\[0-9a-f\]/);
    expect(SRC).toMatch(/UUID_RE\.test\(workspaceId\)/);
    expect(SRC).toContain("INVALID_WORKSPACE");
  });

  it("risolve una sola zona autorizzata da civiko_commercial_zones (occupata/in_trial + trial scaduto)", () => {
    expect(SRC).toContain('from("civiko_commercial_zones")');
    expect(SRC).toContain("status.eq.occupata");
    expect(SRC).toContain("status.eq.in_trial");
    expect(SRC).toContain("trial_reserved_until");
    expect(SRC).toContain("NO_ZONE_ASSIGNED");
    expect(SRC).toContain("MULTIPLE_ZONES_ASSIGNED");
    expect(SRC).toContain("SLUG_OUT_OF_CONTRACT");
    expect(SRC).toContain("isCivikoCommercialZoneSlug");
  });

  it("forza Padova/PD server-side, ignora city/province/workspace_id/commercial_zone_slug dal body", () => {
    expect(SRC).toContain('FORCED_CITY = "Padova"');
    expect(SRC).toContain('FORCED_PROVINCE = "PD"');
    // Non deve più leggere body.city o body.province
    expect(SRC).not.toMatch(/body\.city/);
    expect(SRC).not.toMatch(/body\.province/);
    expect(SRC).not.toMatch(/body\.workspace_id/);
    expect(SRC).not.toMatch(/body\.commercial_zone_slug/);
  });

  it("ogni query passa dalle viste zone-scoped con filtro DB su commercial_zone_slug", () => {
    for (const view of [
      "padova_contendibili_by_zone_v",
      "padova_multi_portale_by_zone_v",
      "padova_collect_v2_items_by_zone_v",
    ]) {
      expect(SRC).toContain(`from("${view}")`);
    }
    // Ogni from(...by_zone_v) deve essere seguito da .eq("commercial_zone_slug", assignedSlug)
    const regex = /from\("(padova_[a-z_]+_by_zone_v)"\)([\s\S]*?)(?=\bfrom\(|serve\(|$)/g;
    const matches = [...SRC.matchAll(regex)];
    expect(matches.length).toBeGreaterThanOrEqual(3);
    for (const m of matches) {
      expect(m[2]).toMatch(/\.eq\(\s*["']commercial_zone_slug["']\s*,\s*assignedSlug\s*\)/);
    }
  });

  it("RPC ribassi usa la variante _by_zone con p_commercial_zone_slug", () => {
    expect(SRC).toContain('"get_padova_verified_price_drops_by_zone"');
    expect(SRC).toContain("p_commercial_zone_slug: assignedSlug");
    // La vecchia RPC non deve più essere invocata
    expect(SRC).not.toMatch(/rpc\(\s*"get_padova_verified_price_drops"[^_]/);
  });

  it("nessun fallback permissivo: no branch padova_collect_v2_items per ribassi", () => {
    // Nessun blocco 'fallback_collect_v2' o simile
    expect(SRC).not.toMatch(/fallback_collect_v2/);
    expect(SRC).not.toMatch(/rpcOk\s*=\s*false/);
    // Off-market disabilitato fail-closed
    expect(SRC).toContain("no_reliable_zone_column_fail_closed");
    expect(SRC).not.toContain('from("early_offmarket_signal_candidates")');
  });

  it("nessuna fetch globale (senza filtro zona) su tabelle sorgente sensibili", () => {
    // Le tabelle base NON devono comparire senza vista by_zone
    for (const raw of ["padova_contendibili", "padova_multi_portale", "padova_collect_v2_items"]) {
      // consenti solo la forma <raw>_by_zone_v
      const bareRegex = new RegExp(`from\\("${raw}"\\)`);
      expect(SRC).not.toMatch(bareRegex);
    }
  });

  it("commercial_zone_slug degli item = assignedSlug, non client-driven", () => {
    // buildItem riceve sempre authorizedSlug e lo assegna a commercial_zone_slug
    expect(SRC).toContain("commercial_zone_slug: authorizedSlug");
    // Assert finale filtra tutto ciò che non porta lo slug autorizzato
    expect(SRC).toContain("it.commercial_zone_slug === assignedSlug");
    // Nessuna vecchia propagazione OMI→slug con buildOmiToSlugMap
    expect(SRC).not.toContain("buildOmiToSlugMap");
    expect(SRC).not.toContain("omiToSlug");
  });

  it("agency coverage e freshness probes sono zone-scoped", () => {
    // La coverage per portale è filtrata via commercial_zone_slug
    expect(SRC).toMatch(/agencyCoverage[\s\S]{0,600}\.eq\(\s*["']commercial_zone_slug["']\s*,\s*assignedSlug/);
    // Il probe di freshness usa la vista by_zone + filtro
    expect(SRC).toContain("probeFreshnessByZone");
    expect(SRC).not.toMatch(/probeFreshness\(\s*"padova_/);
  });

  it("errori HTTP coerenti per auth/workspace/zona", () => {
    for (const code of [
      "MISSING_TENANT",
      "INVALID_WORKSPACE",
      "NO_ZONE_ASSIGNED",
      "MULTIPLE_ZONES_ASSIGNED",
      "SLUG_OUT_OF_CONTRACT",
    ]) {
      expect(SRC).toContain(code);
    }
  });
});
