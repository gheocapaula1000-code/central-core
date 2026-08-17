import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  SOURCE_PLAN,
  CLASS_C_PORTAL_CODES,
  PREMIUM_ON_DEMAND_CODES,
  isOfficialPipelineCode,
  assertManifestComplete,
} from "../../supabase/functions/_shared/sourceScheduler.ts";
import {
  eligibleSourcePlans,
  runScheduledSources,
  extractRecordsProcessed,
  FORBIDDEN_SCHEDULER_CODES,
} from "../../supabase/functions/_shared/sourceJobs.ts";
import {
  parseVenetoFlat,
  parseOfficialCiviciPayload,
  normalizeStreet,
  civicFingerprint,
} from "../../supabase/functions/_shared/padovaCivici.ts";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

function fakeSupabase() {
  const patches: Record<string, Record<string, unknown>> = {};
  return {
    patches,
    from() {
      return {
        select() {
          return {
            then(onFulfilled: (v: unknown) => unknown) {
              return Promise.resolve({ data: [], error: null }).then(onFulfilled);
            },
          };
        },
        update(patch: Record<string, unknown>) {
          return {
            async eq(_col: string, val: string) {
              patches[val] = { ...(patches[val] ?? {}), ...patch };
              return { data: null, error: null };
            },
          };
        },
      };
    },
  };
}

describe("Official vs portal pipeline classes", () => {
  it("F1–F22 remain complete", () => {
    assertManifestComplete();
  });

  it("OMI, ISTAT, OSM, civici are Class A official", () => {
    expect(SOURCE_PLAN.F1.pipeline_class).toBe("A");
    expect(SOURCE_PLAN.F2.pipeline_class).toBe("A");
    expect(SOURCE_PLAN.F5.pipeline_class).toBe("A");
    expect(SOURCE_PLAN.CIVICI.pipeline_class).toBe("A");
    expect(SOURCE_PLAN.CIVICI.write_table).toBe("padova_civici");
    expect(SOURCE_PLAN.F2.write_table).toBe("istat_comuni");
    expect(SOURCE_PLAN.F5.write_table).toBe("raw_sources_ingest");
  });

  it("Immobiliare quotations and portal scrapers are Class C", () => {
    expect(SOURCE_PLAN.F13.pipeline_class).toBe("C");
    expect(SOURCE_PLAN.F21.pipeline_class).toBe("C");
    expect(CLASS_C_PORTAL_CODES.has("F13")).toBe(true);
    expect(CLASS_C_PORTAL_CODES.has("F21")).toBe(true);
  });

  it("Catasto and Conservatoria stay premium on-demand", () => {
    for (const code of ["F14", "F15"]) {
      expect(PREMIUM_ON_DEMAND_CODES.has(code)).toBe(true);
      expect(SOURCE_PLAN[code].pipeline_class).toBe("premium");
      expect(SOURCE_PLAN[code].scheduler_frequency).toBe("on_demand");
      expect(FORBIDDEN_SCHEDULER_CODES.has(code)).toBe(true);
    }
  });

  it("Class A eligible plans never include portals or premium", () => {
    const codes = eligibleSourcePlans({ pipeline_class: "A" }).map((p) => p.code);
    expect(codes).toContain("F2");
    expect(codes).toContain("F5");
    expect(codes).toContain("CIVICI");
    expect(codes).not.toContain("F13");
    expect(codes).not.toContain("F21");
    expect(codes).not.toContain("F14");
    expect(codes).not.toContain("F15");
  });

  it("Class C eligible plans are only portal sources", () => {
    const codes = new Set(eligibleSourcePlans({ pipeline_class: "C" }).map((p) => p.code));
    expect([...codes].every((c) => CLASS_C_PORTAL_CODES.has(c))).toBe(true);
    expect(codes.has("F21")).toBe(true);
  });

  it("isOfficialPipelineCode matches Class A only", () => {
    expect(isOfficialPipelineCode("F2")).toBe(true);
    expect(isOfficialPipelineCode("CIVICI")).toBe(true);
    expect(isOfficialPipelineCode("F21")).toBe(false);
    expect(isOfficialPipelineCode("F14")).toBe(false);
  });
});

describe("runScheduledSources defaults to official Class A", () => {
  it("does not POST portal scraper endpoints", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ ok: true, records_processed: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    await runScheduledSources({
      supabase: fakeSupabase(),
      baseUrl: "https://jpunnzgixcghuydstdlt.supabase.co/functions/v1",
      jobSecret: "job",
      fetchImpl,
      secrets: { AI_CORE_SECRET_CIVIKO: "civiko", SUPABASE_SERVICE_ROLE_KEY: "srv" },
      resolveCoords: async () => ({ lat: 45.4064, lng: 11.8768 }),
      attachEvidenceWriter: false,
    }, {});

    expect(seen.some((u) => u.includes("portalScrapers"))).toBe(false);
    expect(seen.some((u) => u.includes("istat-sdmx-fetch") || u.includes("connector-osm-cantieri") || u.includes("padova-civici-ingest"))).toBe(true);
    expect(seen.some((u) => u.includes("egjvullvkwpzyyworeml"))).toBe(false);
  });

  it("pipeline_class=all is available for catalog tests but still blocks F14/F15", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ ok: true, records_processed: 0 }), { status: 200 });
    }) as unknown as typeof fetch;

    await runScheduledSources({
      supabase: fakeSupabase(),
      baseUrl: "https://x.test",
      jobSecret: "job",
      fetchImpl,
      secrets: { AI_CORE_SECRET_CIVIKO: "x", SUPABASE_SERVICE_ROLE_KEY: "y" },
      resolveCoords: async () => ({ lat: 45.4, lng: 11.8 }),
      attachEvidenceWriter: false,
    }, { pipeline_class: "all" });

    expect(seen.some((u) => u.includes("civiko-premium-catasto"))).toBe(false);
    expect(seen.some((u) => u.includes("civiko-premium-conservatoria"))).toBe(false);
  });
});

describe("extractRecordsProcessed — official response shapes", () => {
  it("reads top-level, data.records_processed, OSM normalized, ISTAT totals", () => {
    expect(extractRecordsProcessed({ records_processed: 4 })).toBe(4);
    expect(extractRecordsProcessed({ data: { records_processed: 9 } })).toBe(9);
    expect(extractRecordsProcessed({ data: { normalized: 12 } })).toBe(12);
    expect(extractRecordsProcessed({ totals: { inserted: 75 } })).toBe(75);
    expect(extractRecordsProcessed({ records_upserted: 3 })).toBe(3);
    expect(extractRecordsProcessed({})).toBe(0);
  });
});

describe("padova civici official parser", () => {
  it("parses Veneto flat JSON and fingerprints via+civico", () => {
    const rows = parseVenetoFlat([
      { "Nome Via": "Via Roma", Civico: "12.00000000", Esponente: "-", Latitudine: 45.4, Longitudine: 11.87 },
      { "Nome Via": "", Civico: "1" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].civic_number).toBe("12");
    expect(rows[0].civic_suffix).toBeNull();
    const fp = civicFingerprint(normalizeStreet(rows[0].street_name), rows[0].civic_number, rows[0].civic_suffix);
    expect(fp).toBe("padova|via roma|12|");
  });

  it("rejects unknown payload shapes", () => {
    expect(() => parseOfficialCiviciPayload({ nope: true }, "auto")).toThrow(/unknown_payload_shape/);
  });
});

describe("Official cron migration — isolated from portals", () => {
  const sql = read("supabase/migrations/20260817140000_official_pipeline_separate_from_portals.sql");
  const scheduler = read("supabase/functions/civiko-scheduler/index.ts");
  const allSql = readdirSync(resolve(root, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => read(`supabase/migrations/${f}`))
    .join("\n");

  it("unschedules the mixed master and schedules official ingest + recompute", () => {
    expect(sql).toContain("nightly-data-refresh-master");
    expect(sql).toContain("official-data-refresh");
    expect(sql).toContain("official-padova-listings-recompute");
    expect(sql).toContain("pipeline_class");
    expect(sql).toContain("jpunnzgixcghuydstdlt");
    expect(sql).not.toContain("egjvullvkwpzyyworeml");
    expect(sql).toContain("recompute_padova_listings_contendibili");
  });

  it("does not schedule F14/F15 paid on-demand jobs", () => {
    expect(sql).not.toContain("civiko-premium-catasto");
    expect(sql).not.toContain("civiko-premium-conservatoria");
    expect(sql).not.toContain("F14");
    expect(sql).not.toContain("F15");
  });

  it("does not rewrite or invoke portal scrapers", () => {
    expect(sql).not.toContain("cron-apify-immobiliare-nightly");
    expect(sql).not.toContain("cron-apify-idealista-nightly");
    expect(sql).not.toContain("cron-apify-subito-nightly");
    expect(sql).not.toContain("cron-apify-casa-nightly");
    expect(sql).not.toContain("portalScrapers");
  });

  it("scheduler refuses Class C", () => {
    expect(scheduler).toContain("PORTAL_PIPELINE_REFUSED");
    expect(scheduler).toContain('PipelineClass = "A"');
    expect(scheduler).toContain("jpunnzgixcghuydstdlt");
  });

  it("matcher 2+ agencies / 3 = caldo rule is unchanged in later migrations", () => {
    expect(allSql).toMatch(/p_n_agenzie >= 2/);
    expect(allSql).toMatch(/n_agenzie >= 2/);
  });
});

describe("config.toml lists official runner functions", () => {
  const cfg = read("supabase/config.toml");
  it("registers civiko-scheduler, istat-sdmx-fetch, padova-civici-ingest", () => {
    expect(cfg).toContain("[functions.civiko-scheduler]");
    expect(cfg).toContain("[functions.istat-sdmx-fetch]");
    expect(cfg).toContain("[functions.padova-civici-ingest]");
    expect(cfg).toContain('project_id = "jpunnzgixcghuydstdlt"');
    expect(cfg).not.toContain("egjvullvkwpzyyworeml");
  });
});
