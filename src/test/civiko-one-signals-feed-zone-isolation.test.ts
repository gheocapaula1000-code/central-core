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
    expect(SRC).toContain("WORKSPACE_REQUIRED");
  });

  it("risolve una sola zona autorizzata da civiko_commercial_zones (occupata/in_trial + trial scaduto)", () => {
    expect(SRC).toContain('from("civiko_commercial_zones")');
    expect(SRC).toContain("status.eq.occupata");
    expect(SRC).toContain("status.eq.in_trial");
    expect(SRC).toContain("trial_reserved_until");
    expect(SRC).toContain("NO_ZONE_ASSIGNED");
    expect(SRC).toContain("SLUG_OUT_OF_CONTRACT");
    expect(SRC).toContain("isCivikoCommercialZoneSlug");
    // 11B-A: il gate a zona singola vive nel modulo condiviso.
    expect(SRC).toContain("applyCivikoSingleZoneGate");
  });

  it("forza Padova/PD server-side, ignora city/province/workspace_id/commercial_zone_slug dal body", () => {
    expect(SRC).toContain('FORCED_CITY = "Padova"');
    expect(SRC).toContain('FORCED_PROVINCE = "PD"');
    // Non deve leggere/assegnare da body.city|province|workspace_id|commercial_zone_slug
    // (i commenti descrittivi non contano — controlliamo pattern operativi).
    expect(SRC).not.toMatch(/=\s*body\.city/);
    expect(SRC).not.toMatch(/=\s*body\.province/);
    expect(SRC).not.toMatch(/body\.workspace_id\b/);
    expect(SRC).not.toMatch(/body\.commercial_zone_slug\b/);
    expect(SRC).not.toMatch(/body\.city\s+as/);
    expect(SRC).not.toMatch(/body\.province\s+as/);
  });

  it("ogni query passa dalle viste zone-scoped con filtro DB su commercial_zone_slug", () => {
    for (const view of [
      "padova_contendibili_by_zone_v",
      "padova_multi_portale_by_zone_v",
      "padova_collect_v2_items_by_zone_v",
    ]) {
      expect(SRC).toContain(`from("${view}")`);
    }
    // Ogni from("<view>_by_zone_v") deve avere un .eq("commercial_zone_slug", assignedSlug)
    // nei ~800 caratteri successivi (stessa query-chain).
    const regex = /from\("(padova_[a-z0-9_]+_by_zone_v)"\)/g;
    const matches = [...SRC.matchAll(regex)];
    expect(matches.length).toBeGreaterThanOrEqual(3);
    for (const m of matches) {
      const start = m.index ?? 0;
      const chunk = SRC.slice(start, start + 800);
      expect(chunk).toMatch(/\.in\(\s*["']commercial_zone_slug["']\s*,\s*zoneFilter\s*\)/);
    }
  });

  it("RPC ribassi usa esclusivamente la variante v2 (no silent fallback v1)", () => {
    expect(SRC).toContain("get_padova_verified_price_drops_by_zone_v2");
    expect(SRC).toMatch(/p_commercial_zone_slug:\s*slug/);
    // v1 RPC must NOT be invoked as a runtime fallback.
    expect(SRC).not.toMatch(/rpc\(\s*"get_padova_verified_price_drops_by_zone"\s*,/);
    // Explicit diagnostic marker when v2 is missing.
    expect(SRC).toContain("rpc_missing_no_fallback");
  });

  it("nessun fallback permissivo: no branch padova_collect_v2_items per ribassi", () => {
    // Nessun blocco 'fallback_collect_v2' o simile
    expect(SRC).not.toMatch(/fallback_collect_v2/);
    expect(SRC).not.toMatch(/rpcOk\s*=\s*false/);
    // Off-market ora legge dalla vista server-only by_zone_v (DB-side zone filter).
    expect(SRC).toContain("early_offmarket_signal_candidates_by_zone_v");
    // La tabella base NON deve mai comparire senza suffisso _by_zone_v
    expect(SRC).not.toMatch(/from\("early_offmarket_signal_candidates"\)/);
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
    expect(SRC).toContain("zoneFilter.includes(it.commercial_zone_slug ?? \"\")");
    // Nessuna vecchia propagazione OMI→slug con buildOmiToSlugMap
    expect(SRC).not.toContain("buildOmiToSlugMap");
    expect(SRC).not.toContain("omiToSlug");
  });

  it("agency coverage e freshness probes sono zone-scoped", () => {
    // La coverage per portale è filtrata via commercial_zone_slug
    expect(SRC).toMatch(/agencyCoverage[\s\S]{0,600}\.in\(\s*["']commercial_zone_slug["']\s*,\s*zoneFilter/);
    // Il probe di freshness usa la vista by_zone + filtro
    expect(SRC).toContain("probeFreshnessByZone");
    expect(SRC).not.toMatch(/probeFreshness\(\s*"padova_/);
  });

  it("errori HTTP coerenti per auth/workspace/zona", () => {
    for (const code of [
      "WORKSPACE_REQUIRED",
      "NO_ZONE_ASSIGNED",
      "ZONE_NOT_ASSIGNED",
      "SLUG_OUT_OF_CONTRACT",
    ]) {
      expect(SRC).toContain(code);
    }
  });
});
