import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const feed = readFileSync(
  "supabase/functions/civiko-one-signals-feed/index.ts",
  "utf8",
);

describe("Civiko Contesi 3+ feed hardening", () => {
  it("uses only the distinct-agency field for Contesi", () => {
    expect(feed).toContain('.gte("agency_count_distinct", MIN_AGENZIE_CONTESI)');
    expect(feed).toContain("Number(row.agency_count_distinct) || 0");
    expect(feed).not.toContain("agency_count_distinct ?? row.n_agenzie");
    expect(feed).not.toContain("agency_count_distinct.is.null,n_agenzie");
  });

  it("does not merge raw multi-portale rows into Contesi", () => {
    expect(feed).toContain('if (includeSet.has("multi_portale"))');
    expect(feed).not.toContain(
      'if (includeSet.has("contendibili") || includeSet.has("multi_portale"))',
    );
    expect(feed).toContain('signal_type: "multi_portale"');
  });

  it("requires three distinct agencies even for explicit multi-portale reads", () => {
    const start = feed.indexOf("// ── MULTI-PORTALE");
    const end = feed.indexOf("// ── RIBASSI", start);
    const block = feed.slice(start, end);
    expect(block).toContain('.gte("portal_count", 2)');
    expect(block).toContain('.gte("agency_count_distinct", MIN_AGENZIE_CONTESI)');
  });
});
