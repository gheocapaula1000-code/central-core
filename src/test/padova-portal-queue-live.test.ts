import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ALL_PORTALS,
  PORTAL_LIVE_PATH,
  buildPortalPageUrl,
} from "../../supabase/functions/_shared/queue-processors/padovaPortalPages.ts";
import {
  ALLOWED_PORTALS,
  parseFirecrawlResult,
} from "../../supabase/functions/_shared/queue-processors/padovaPortalParser.ts";
import {
  encodeApifyWebhooksParam,
  buildCollectPendingWebhook,
  collectPendingUrl,
  CASA_LIVE_CORE_REF,
} from "../../supabase/functions/_shared/casaCollect.ts";
import { evaluateRunOutcome, isSameUtcDay } from "../../supabase/functions/cron-radar-padova-nightly/outcome.ts";
import { defaultMultiLaunchBody } from "../../supabase/functions/_shared/padovaPortalLaunch.ts";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("Firecrawl queue includes Bakeca", () => {
  it("lists bakeca.it in ALL_PORTALS / ALLOWED_PORTALS with a deterministic URL", () => {
    expect(ALL_PORTALS).toContain("bakeca.it");
    expect(ALLOWED_PORTALS).toContain("bakeca.it");
    expect(buildPortalPageUrl("bakeca.it", 1)).toBe(
      "https://www.bakeca.it/annunci/immobili-vendita/padova/",
    );
    expect(buildPortalPageUrl("bakeca.it", 2)).toBe(
      "https://www.bakeca.it/annunci/immobili-vendita/padova/?page=2",
    );
    expect(PORTAL_LIVE_PATH["bakeca.it"]).toBe("firecrawl");
  });

  it("parses Bakeca markdown cards without inventing listings", () => {
    const md = [
      "[Appartamento Padova centro](https://www.bakeca.it/dettaglio/immobile-vendita/padova/1234567) € 250.000 85 mq 3 locali Privato Via Roma 12",
      "[Lista vendita](https://www.bakeca.it/annunci/immobili-vendita/padova/)",
    ].join("\n");
    const rows = parseFirecrawlResult({ markdown: md }, {
      municipality: "Padova",
      province: "PD",
      portal: "bakeca.it",
      mode: "soft",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].listing_id).toBe("bak-1234567");
    expect(rows[0].source).toBe("bakeca.it");
    expect(rows[0].price_eur).toBe(250000);
    expect(rows[0].is_private).toBe(true);
  });

  it("enqueue + SQL allowlist mention bakeca.it", () => {
    const enqueue = read("supabase/functions/enqueue-padova-portal-scrapes/index.ts");
    const sql = read("supabase/migrations/20260820100000_bakeca_queue_and_firecrawl_primary.sql");
    expect(enqueue).toContain("bakeca.it");
    expect(enqueue).toContain("ALL_PORTALS");
    expect(sql).toContain("bakeca.it");
    expect(sql).toContain("jpunnzgixcghuydstdlt");
    expect(sql).not.toContain("egjvullvkwpzyyworeml");
  });
});

describe("Casa Apify webhook query is base64 JSON", () => {
  it("decodes to JSON and never embeds a raw array that Apify would treat as binary", () => {
    const url = collectPendingUrl(`https://${CASA_LIVE_CORE_REF}.supabase.co`);
    const wh = buildCollectPendingWebhook(url, "test-job-secret-value-32chars-ok");
    const encoded = encodeApifyWebhooksParam([wh!]);
    expect(() => JSON.parse(encoded)).toThrow();
    const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    expect(decoded[0].ignoreSsl).toBe(false);
    expect(decoded[0].headersTemplate).toContain("x-job-secret");
  });
});

describe("portal live path honesty", () => {
  it("marks Firecrawl primary for Immobiliare/Idealista/Subito-soft", () => {
    expect(PORTAL_LIVE_PATH["immobiliare.it"]).toBe("firecrawl");
    expect(PORTAL_LIVE_PATH["idealista.it"]).toBe("firecrawl");
    expect(PORTAL_LIVE_PATH["subito.it"]).toBe("firecrawl_soft");
    expect(PORTAL_LIVE_PATH["casa.it"]).toBe("apify");
    expect(defaultMultiLaunchBody().subito_full).toMatchObject({ disabled: true });
    const immo = read("supabase/functions/cron-apify-immobiliare-nightly/index.ts");
    const idea = read("supabase/functions/cron-apify-idealista-nightly/index.ts");
    expect(immo).toContain("firecrawl_is_primary");
    expect(idea).toContain("firecrawl_is_primary");
  });
});

describe("radar full retry-safe outcome", () => {
  it("does not fail the job when a same-UTC-day success already exists", () => {
    expect(isSameUtcDay("2026-08-20T03:45:00Z", new Date("2026-08-20T05:10:00Z"))).toBe(true);
    expect(isSameUtcDay("2026-08-19T03:45:00Z", new Date("2026-08-20T05:10:00Z"))).toBe(false);
    expect(evaluateRunOutcome(false, 0, "full", true, true).ok).toBe(true);
    expect(evaluateRunOutcome(false, 0, "full", true, false).ok).toBe(false);
  });
});
