import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CAMBI = readFileSync(
  "supabase/functions/civiko-cambi-agenzia-list/index.ts",
  "utf8",
);
const OFFMARKET = readFileSync(
  "supabase/functions/core-offmarket-list-public/index.ts",
  "utf8",
);
const CONFIG = readFileSync("supabase/config.toml", "utf8");

describe("Civiko list contracts — authoritative totals", () => {
  it("pagina cambi agenzia con count exact e senza placeholder", () => {
    expect(CONFIG).toMatch(/\[functions\.civiko-cambi-agenzia-list\]\nverify_jwt = false/);
    expect(CAMBI).toContain('{ count: "exact" }');
    expect(CAMBI).toContain(".range(offset, offset + limit - 1)");
    expect(CAMBI).toContain("const hasMore = offset + itemsCount < total");
    expect(CAMBI).toContain("snapshot_complete: true");
    expect(CAMBI).toContain("data: snapshot");
    expect(CAMBI).not.toContain('r.titolo ?? "Immobile a Padova"');
    expect(CAMBI).not.toContain('r.indirizzo ?? "Padova"');
    expect(CAMBI).toContain("titolo: r.titolo ?? null");
    expect(CAMBI).toContain("indirizzo: r.indirizzo ?? null");
  });

  it("pagina tutte le quattro sorgenti offmarket e fallisce sul cap", () => {
    expect(OFFMARKET).toContain("async function fetchAllSourceRows");
    expect(OFFMARKET).toContain(".range(from, to)");
    expect(OFFMARKET).toContain("source_snapshot_cap_reached");
    expect(OFFMARKET).toContain("distress_snapshot_cap_reached");
    expect(OFFMARKET).not.toContain(".limit(500)");
    for (const key of [
      "legal_life_events",
      "successioni",
      "distress",
      "patrimonio_comunale",
    ]) {
      expect(OFFMARKET).toContain(`${key}: 0`);
    }
  });

  it("espone snapshot completo top/data con totale somma e pagina finale", () => {
    expect(OFFMARKET).toContain("it.commercial_zone_slug !== null && access.slugs.includes");
    expect(OFFMARKET).toContain("totals.total !== total");
    expect(OFFMARKET).toContain(
      "totals.legal_life_events + totals.successioni + totals.distress + totals.patrimonio_comunale",
    );
    expect(OFFMARKET).toContain("const pageItems = outItems.slice(offset, offset + limit)");
    expect(OFFMARKET).toContain("snapshot_complete: true");
    expect(OFFMARKET).toContain("source_counts: sourceCounts");
    expect(OFFMARKET).toContain("source_caps: sourceCaps");
    expect(OFFMARKET).toContain("data: snapshot");
    expect(OFFMARKET).toContain("snapshot_complete: false");
  });
});
