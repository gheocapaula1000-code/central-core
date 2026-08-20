import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  isLikelyJwt,
  jobSecretAuthorized,
  readIncomingJobSecret,
} from "../../supabase/functions/_shared/jobSecretAuth";
import {
  BAKECA_LISTING_PAGES,
  bakecaPageUrl,
  detectPrivato,
  isBakecaListingUrl,
  parseEuro,
  parseListingsFromMarkdown,
  parseRelativeAge,
} from "../../supabase/functions/civiko-bakeca-scrape/parse";
import { extractFromContent, isValidItalianPhone, looksLikeAgencyName } from "../../supabase/functions/padova-firecrawl-detail-collect/extract";
import {
  SOURCE_JOB_ID,
  isClaimableDetailRow,
  remainingQueueOrFilter,
  shouldContinueChaining,
  storedStatus,
} from "../../supabase/functions/padova-firecrawl-detail-collect/queue";
import {
  COMUNI_PD,
  JOB_NAMES,
  LIVE_CORE_REF,
  buildBody,
  isJobSlug,
  radarJobPath,
  targetTimeoutMs,
} from "../../supabase/functions/cron-offmarket-padova-nightly/jobs";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

function headers(map: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

describe("job secret auth (production headers)", () => {
  it("accepts x-job-secret first", () => {
    expect(readIncomingJobSecret(headers({
      "x-job-secret": "job-a",
      "x-internal-secret": "job-b",
      authorization: "Bearer job-c",
    }))).toBe("job-a");
  });

  it("falls back to x-internal-secret then non-JWT Bearer", () => {
    expect(readIncomingJobSecret(headers({ "x-internal-secret": "job-b" }))).toBe("job-b");
    expect(readIncomingJobSecret(headers({ authorization: "Bearer job-c" }))).toBe("job-c");
  });

  it("ignores JWT bearers so anon/service tokens are not the job secret", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.signature";
    expect(isLikelyJwt(jwt)).toBe(true);
    expect(readIncomingJobSecret(headers({ authorization: `Bearer ${jwt}` }))).toBe("");
  });

  it("fail-closed on empty/mismatch", () => {
    expect(jobSecretAuthorized("", "x")).toBe(false);
    expect(jobSecretAuthorized("abc", "abd")).toBe(false);
    expect(jobSecretAuthorized("abc", "abc")).toBe(true);
  });
});

describe("Bakeca parser", () => {
  const now = new Date(Date.UTC(2026, 7, 19));
  const md = `
[Appartamento Padova centro](https://www.bakeca.it/dettaglio/immobile-vendita/padova/1234567) € 250.000 85 mq 3 locali Privato 3 mesi fa Via Roma 12
[Agenzia Tecnocasa](https://www.bakeca.it/dettaglio/immobile-vendita/padova/999) € 180.000 70 mq Agenzia
[Lista vendita](https://www.bakeca.it/annunci/immobili-vendita/padova/)
https://www.bakeca.it/annunci/immobile/7654321/ Bilocale € 160.000 55 mq Privato ieri
`;

  it("keeps listing URLs and drops search pages", () => {
    expect(isBakecaListingUrl("https://www.bakeca.it/dettaglio/immobile-vendita/padova/123")).toBe(true);
    expect(isBakecaListingUrl("https://www.bakeca.it/annunci/immobili-vendita/padova/")).toBe(false);
    expect(BAKECA_LISTING_PAGES.every((u) => u.includes("bakeca.it"))).toBe(true);
    expect(bakecaPageUrl(BAKECA_LISTING_PAGES[0], 2)).toContain("page=2");
  });

  it("parses private cards and relative age", () => {
    const items = parseListingsFromMarkdown(md, now);
    const priv = items.filter((i) => i.isPrivato);
    expect(priv.length).toBeGreaterThanOrEqual(2);
    expect(priv[0].prezzo).toBe(250000);
    expect(priv[0].mq).toBe(85);
    expect(priv[0].locali).toBe(3);
    expect(priv[0].firstSeenAt).toBe(parseRelativeAge("3 mesi fa", now));
    expect(items.some((i) => !i.isPrivato)).toBe(true);
  });

  it("classifies privato vs agenzia and parses euro", () => {
    expect(detectPrivato("€ 200.000 Privato")).toBe(true);
    expect(detectPrivato("€ 200.000 Agenzia Tecnocasa")).toBe(false);
    expect(parseEuro("€ 1.250.000")).toBe(1250000);
  });
});

describe("Firecrawl detail extract + queue", () => {
  it("extracts mq/locali/agency/phone from markdown+html", () => {
    const md = "Appartamento 92 mq 3 locali piano: 2  [Studio Rossi](https://www.immobiliare.it/agenzie-immobiliari/11/studio-rossi/)";
    const html = `<a href="tel:0491234567">chiama</a><script type="application/ld+json">{"@type":"Residence","floorSize":{"value":92},"numberOfRooms":3}</script>`;
    const out = extractFromContent(md, html);
    expect(out.mq).toBe(92);
    expect(out.locali).toBe(3);
    expect(out.agency).toBe("Studio Rossi");
    expect(out.agency_phone).toBe("0491234567");
  });

  it("rejects fake agency names and portal P.IVA phones", () => {
    expect(looksLikeAgencyName("Agenzia")).toBe(false);
    expect(looksLikeAgencyName("Studio Rossi Immobiliare")).toBe(true);
    expect(isValidItalianPhone("08435221000")).toBe(false);
    expect(isValidItalianPhone("0491234567")).toBe(true);
  });

  it("claimable rows match claim_padova_detail_batch, not mq/raw_json null", () => {
    expect(isClaimableDetailRow({ url: "https://x", attempts: 0, processed_at: null })).toBe(true);
    expect(isClaimableDetailRow({
      url: "https://x", attempts: 1, processed_at: "2026-08-19T00:00:00Z", parse_status: "error",
    })).toBe(true);
    expect(isClaimableDetailRow({
      url: "https://x", attempts: 1, processed_at: "2026-08-19T00:00:00Z", parse_status: "done_ok",
    })).toBe(false);
    expect(isClaimableDetailRow({ url: "https://x", attempts: 2, processed_at: null })).toBe(false);
    expect(remainingQueueOrFilter()).toContain("failed_processed_unknown");
    expect(storedStatus("timeout", 1)).toBe("error");
    expect(storedStatus("timeout", 2)).toBe("dead_unrecoverable");
    expect(shouldContinueChaining(8, 12, null)).toBe(true);
    expect(shouldContinueChaining(8, 0, null)).toBe(false);
    expect(SOURCE_JOB_ID).toBe("e9709a73-e91f-49c4-bc11-a8bf27829875");
  });
});

describe("offmarket Padova nightly job table", () => {
  it("covers the four slugs with Padova-only write bodies", () => {
    expect(isJobSlug("offmarket-padova")).toBe(true);
    expect(isJobSlug("nope")).toBe(false);
    expect(COMUNI_PD).toEqual(["Padova"]);
    expect(LIVE_CORE_REF).toBe("jpunnzgixcghuydstdlt");
    const discover = buildBody("discover-early-offmarket-signals");
    expect(discover.saveCandidates).toBe(true);
    expect(discover.dryRun).toBe(false);
    expect(discover.comuni).toEqual(["Padova"]);
    expect(buildBody("offmarket-padova").comuni).toEqual(["Padova"]);
    expect(radarJobPath("offmarket-padova")).toContain("/jobs/offmarket-padova");
    expect(targetTimeoutMs("offmarket-padova")).toBeGreaterThanOrEqual(90_000);
    expect(targetTimeoutMs("discover-early-offmarket-signals")).toBeGreaterThanOrEqual(90_000);
    expect(Object.values(JOB_NAMES).every((n) => n.startsWith("central-core-"))).toBe(true);
  });
});

describe("static contracts — no secrets, live Core, verify_jwt false", () => {
  const bakeca = read("supabase/functions/civiko-bakeca-scrape/index.ts");
  const firecrawl = read("supabase/functions/padova-firecrawl-detail-collect/index.ts");
  const nightly = read("supabase/functions/cron-offmarket-padova-nightly/index.ts");
  const cfg = read("supabase/config.toml");
  const sql = read("supabase/migrations/20260819180000_bakeca_firecrawl_offmarket_nightly.sql");

  it("Bakeca scrape is live (no disabled short-circuit) and job-secret gated", () => {
    expect(bakeca).not.toMatch(/DISATTIVATA 2026-06-20/);
    expect(bakeca).not.toMatch(/disabled: true/);
    expect(bakeca).toContain("readIncomingJobSecret");
    expect(bakeca).toContain("CENTRAL_CORE_JOB_SECRET");
    expect(bakeca).toContain("parseListingsFromMarkdown");
    expect(bakeca).toContain("BAKECA_PAGE_TIMEOUT_MS");
    expect(bakeca).toContain("AbortSignal.timeout");
    expect(bakeca).toContain("job_timeout");
    expect(bakeca).not.toMatch(/body\s*[?.].*job_secret/);
  });

  it("Firecrawl collect uses the claimable remaining filter and job-secret auth", () => {
    expect(firecrawl).toContain("applyRemainingQueueFilter");
    expect(firecrawl).toContain("readIncomingJobSecret");
    expect(firecrawl).not.toMatch(/\.is\("mq", null\)\.is\("raw_json", null\)/);
    expect(firecrawl).toContain("x-job-secret");
  });

  it("offmarket nightly uses extracted timeouts/bodies and job-secret auth", () => {
    expect(nightly).toContain("targetTimeoutMs");
    expect(nightly).toContain("buildBody");
    expect(nightly).toContain("readIncomingJobSecret");
    expect(nightly).not.toMatch(/35_000/);
  });

  it("config.toml disables gateway JWT for the three functions", () => {
    expect(cfg).toContain('project_id = "jpunnzgixcghuydstdlt"');
    expect(cfg).toContain("[functions.civiko-bakeca-scrape]");
    expect(cfg).toContain("[functions.padova-firecrawl-detail-collect]");
    expect(cfg).toContain("[functions.cron-offmarket-padova-nightly]");
  });

  it("migration schedules live Core wrappers via log_cron_http_invocation, no JWT", () => {
    expect(sql).toContain("jpunnzgixcghuydstdlt");
    expect(sql).not.toContain("egjvullvkwpzyyworeml");
    expect(sql).toContain("log_cron_http_invocation");
    expect(sql).toContain("civiko-bakeca-scrape");
    expect(sql).toContain("padova-firecrawl-detail-collect");
    expect(sql).toContain("job=offmarket-padova");
    expect(sql).toContain("job=discover-early-offmarket-signals");
    expect(sql).toContain("CENTRAL_CORE_JOB_SECRET");
    expect(sql).toContain("failed_processed_unknown");
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(existsSync(resolve(root, "supabase/functions/civiko-bakeca-scrape/parse.ts"))).toBe(true);
  });
});
