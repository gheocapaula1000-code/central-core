import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SQL = readFileSync(
  "supabase/migrations/20260820120000_trovabandi_depth_cheap_crons.sql",
  "utf8",
);
const ENGINE = readFileSync("supabase/functions/trovabandi-engine/index.ts", "utf8");
const DOCS = readFileSync("docs/TROVABANDI_REPLIT_CRON.md", "utf8");

describe("TrovaBandi cheap-first nightly crons", () => {
  it("punta solo al live Core jpunn e non al progetto vuoto", () => {
    expect(SQL).toContain("jpunnzgixcghuydstdlt.supabase.co/functions/v1/trovabandi-engine");
    expect(SQL).not.toContain("egjvullvkwpzyyworeml");
  });

  it("usa CENTRAL_CORE_JOB_SECRET dal vault e non stampa il valore", () => {
    expect(SQL).toContain("CENTRAL_CORE_JOB_SECRET");
    expect(SQL).toContain("x-internal-secret");
    expect(SQL).toContain("x-job-secret");
    expect(SQL).not.toMatch(/CENTRAL_CORE_JOB_SECRET\s*=\s*'/);
    expect(SQL).not.toMatch(/decrypted_secret\s*=\s*'/);
  });

  it("unschedula soltanto job trovabandi e non tocca Civiko/Padova", () => {
    expect(SQL).toContain("trovabandi-collect-supabase");
    expect(SQL).toContain("trovabandi-night-1");
    expect(SQL).not.toMatch(/cron\.unschedule\('padova/);
    expect(SQL).not.toMatch(/cron\.unschedule\('civiko/);
    expect(SQL).not.toMatch(/cron\.unschedule\('official-/);
  });

  it("schedula backfill free prima della discovery e le 8 corsie notturne", () => {
    expect(SQL).toContain("'trovabandi-night-backfill'");
    expect(SQL).toContain("'10 23 * * *'");
    expect(SQL).toContain('"allow_paid_extract":false');
    for (const lane of [
      "locale",
      "camerale",
      "regionale",
      "nazionale",
      "pnrr",
      "ue",
      "femminile",
      "giovanile",
    ]) {
      expect(SQL).toContain(`"lane":"${lane}"`);
    }
    expect(SQL).toContain("'trovabandi-day-cheap'");
    expect(SQL).toContain('"allow_paid":false');
    expect(SQL).not.toMatch(/\*\/20 \* \* \* \*/);
    expect(SQL).not.toContain("max_pages\":4");
  });

  it("riabilita albo, femminile e regioni ufficiali disabilitate", () => {
    expect(SQL).toContain("padovanet.it");
    expect(SQL).toContain("pariopportunita.gov.it");
    expect(SQL).toContain("regione.sicilia.it");
  });
});

describe("TrovaBandi engine cheap-first wiring", () => {
  it("accetta x-job-secret come alias e non rompe x-internal-secret", () => {
    expect(ENGINE).toContain("readIncomingEngineSecret(req.headers)");
    expect(ENGINE).toContain("AI_CORE_SECRET_TROVABANDI");
    expect(ENGINE).toContain("CENTRAL_CORE_JOB_SECRET");
  });

  it("il collect filtra per lane, cap paid e salta SCADUTO/VERIFICATO completi", () => {
    expect(ENGINE).toContain("filterSourcesByLane");
    expect(ENGINE).toContain("parseAllowPaid(body.allow_paid, true)");
    expect(ENGINE).toContain("shouldSkipExpiredRecrawl");
    expect(ENGINE).toContain("isCompleteVerified");
    expect(ENGINE).toContain("localOpportunityDraft");
    expect(ENGINE).toContain("paid_blocked_concurrent_run");
    expect(ENGINE).toContain("SKIPPED_BUDGET");
  });

  it("backfill usa excerpt persistito e non esclude i PDF", () => {
    expect(ENGINE).toContain("usableStoredEvidence(row.raw_excerpt)");
    expect(ENGINE).not.toContain('.not("official_url", "ilike", "%.pdf")');
    expect(ENGINE).toContain("localExtractAteco");
    expect(ENGINE).toContain("localExtractProtocolEmail");
    expect(ENGINE).toContain("resolveOfficialApplyUrls");
    expect(ENGINE).toContain("resolveOpportunityGeo");
    expect(ENGINE).toContain("region.is.null,province.is.null,municipality.is.null");
  });

  it("estrae modulistica/domanda in collect e ha enrich_apply_urls fail-closed", () => {
    expect(ENGINE).toContain("enrich_apply_urls");
    expect(ENGINE).toContain("modulistica_url");
    expect(ENGINE).toContain("SKIPPED_FVG_BUR");
    expect(ENGINE).toContain("SKIPPED_INDEX_LISTING");
    expect(ENGINE).toContain("isEligibleOfficialOpportunity");
    expect(ENGINE).toContain("shouldSkipApplyFetch");
    expect(ENGINE).not.toContain("egjvullvkwpzyyworeml");
  });

  it("dry-run resta senza lease/provider e include lane", () => {
    const start = ENGINE.indexOf("const sourceId = normalizeText(body.source_id)");
    const end = ENGINE.indexOf("const warnings: string[] = []");
    const selection = ENGINE.slice(start, end);
    expect(selection).toContain("would_collect");
    expect(selection).toContain("allow_paid: allowPaid");
    expect(selection).not.toContain("firecrawlSearch(");
    expect(selection).not.toContain("perplexitySearch(");
  });

  it("scava in BFS fino a 20 fetch per hit e usa collectDetailTargets", () => {
    expect(ENGINE).toContain("DETAIL_MAX_FETCH_PER_HIT = 20");
    expect(ENGINE).toContain("DETAIL_MAX_FETCH_PER_RUN = 60");
    expect(ENGINE).toContain("DETAIL_MAX_HOPS = 6");
    expect(ENGINE).toContain("collectDetailTargets");
    expect(ENGINE).toContain("walkDetailTargets");
  });
});

describe("TrovaBandi cron docs Europe/Rome", () => {
  it("documenta free vs paid e lo scheduler pg_cron su jpunn", () => {
    expect(DOCS).toContain("Europe/Rome");
    expect(DOCS).toContain("trovabandi-night-backfill");
    expect(DOCS).toContain("FREE");
    expect(DOCS).toContain("jpunnzgixcghuydstdlt");
    expect(DOCS).not.toContain("Reserved VM Replit è l'unico scheduler");
  });
});

describe("GitHub Actions TrovaBandi backfill fallback", () => {
  const yml = readFileSync(".github/workflows/cron-trovabandi-backfill.yml", "utf8");

  it("invokes trovabandi-engine backfill_nulls only on live Core jpunn", () => {
    expect(yml).toContain("trovabandi-engine");
    expect(yml).toContain("backfill_nulls");
    expect(yml).toContain("jpunnzgixcghuydstdlt");
    expect(yml).not.toContain("egjvullvkwpzyyworeml");
  });

  it("runs weekday hourly plus overnight backup; live default packet is 1", () => {
    expect(yml).toContain('default: "1"');
    expect(yml).toContain("packet size not PDF depth");
    expect(yml).toContain("rounds");
    expect(yml).toContain("50 6-16 * * 1-5");
    expect(yml).toContain("20 6-16 * * 1-5");
    expect(yml).toContain("20 23 * * 0-4");
    expect(yml).toContain("Capping max_batch");
    expect(yml).toContain("OK_ROUNDS");
    expect(yml).toContain("timeout-minutes: 22");
  });

  it("stops only on processed=0 so cookie rotates continue, sleeps 20s, defaults 12 rounds", () => {
    expect(yml).toContain('default: "12"');
    expect(yml).toContain("sleep 20");
    expect(yml).toContain('[ "${PROCESSED}" = "0" ]');
    expect(yml).not.toContain('[ "${UPDATED}" = "0" ]');
    expect(yml).toContain("skipped");
    expect(yml).toContain("Continue if skipped>0 even when updated=0");
    expect(yml).toContain("jpunnzgixcghuydstdlt");
    expect(yml).not.toContain("egjvullvkwpzyyworeml");
    expect(yml).toContain("max_batch is a packet size, not official-PDF BFS depth");
    expect(yml).toContain("WORKER_RESOURCE_LIMIT");
    expect(yml).toContain("SKIPPING backfill_nulls");
    expect(yml).toContain("status still not 200 after 3 attempts");
  });
});
