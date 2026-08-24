import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  extractNoticeLinks,
  isNoticeLikeUrl,
  isOfficialListingUrl,
} from "../../supabase/functions/trovabandi-engine/notice-resolve.ts";

const ENGINE = readFileSync(
  "supabase/functions/trovabandi-engine/index.ts",
  "utf8",
);

describe("isOfficialListingUrl", () => {
  it("riconosce index, elenco, home e /bandi", () => {
    expect(isOfficialListingUrl("https://www.invitalia.it/")).toBe(true);
    expect(isOfficialListingUrl("https://www.pd.camcom.it/bandi")).toBe(true);
    expect(isOfficialListingUrl("https://www.pd.camcom.it/it/bandi")).toBe(true);
    expect(
      isOfficialListingUrl("https://bandi.regione.veneto.it/elenco"),
    ).toBe(true);
    expect(
      isOfficialListingUrl(
        "https://www.regione.veneto.it/web/attivita-produttive/bandi",
      ),
    ).toBe(true);
  });

  it("non tratta una scheda avviso come elenco", () => {
    expect(
      isOfficialListingUrl(
        "https://www.pd.camcom.it/bandi/digitalizzazione-2026",
      ),
    ).toBe(false);
    expect(
      isOfficialListingUrl(
        "https://www.regione.veneto.it/avvisi/bando-pmi-2026",
      ),
    ).toBe(false);
    expect(isNoticeLikeUrl("https://www.regione.veneto.it/avvisi/bando-pmi-2026"))
      .toBe(true);
  });
});

describe("extractNoticeLinks", () => {
  const html = `
    <a href="/bandi">Tutti i bandi</a>
    <a href="/bandi/avviso-pmi-2026">Avviso pubblico PMI 2026</a>
    <a href="/documenti/decreto-approvazione.pdf">Decreto</a>
    <a href="https://bandiora.it/bando">Scheda Bandiora</a>
    <a href="https://altroente.it/avviso">Avviso esterno</a>
    <a href="/privacy">Privacy</a>
  `;

  it("tiene solo link stesso-host che sembrano un avviso", () => {
    const links = extractNoticeLinks(
      html,
      "",
      "https://www.pd.camcom.it/bandi",
      "pd.camcom.it",
    );
    const urls = links.map((link) => link.url);
    expect(urls).toContain("https://www.pd.camcom.it/bandi/avviso-pmi-2026");
    expect(urls).toContain(
      "https://www.pd.camcom.it/documenti/decreto-approvazione.pdf",
    );
    expect(urls.join(" ")).not.toContain("bandiora.it");
    expect(urls.join(" ")).not.toContain("altroente.it");
    expect(urls).not.toContain("https://www.pd.camcom.it/bandi");
  });

  it("legge anche i link markdown", () => {
    const links = extractNoticeLinks(
      "",
      "[Avviso misura digitale](https://www.regione.veneto.it/misura-digitale-2026)",
      "https://www.regione.veneto.it/bandi",
      "regione.veneto.it",
    );
    expect(links.map((link) => link.url)).toContain(
      "https://www.regione.veneto.it/misura-digitale-2026",
    );
  });
});

describe("motore — follow notice e backfill write", () => {
  it("segue gli elenchi invece di fermarsi e scrive di default", () => {
    expect(ENGINE).toContain("resolveOfficialNoticePage");
    expect(ENGINE).toContain("extractNoticeLinks");
    expect(ENGINE).toContain("officialVerificationStatus");
    expect(ENGINE).toContain("SKIPPED_BANDIORA");
    expect(ENGINE).toContain("const dryRun = body.dry_run === true");
    expect(ENGINE).toContain("BACKFILL_DEFAULT_BATCH");
    expect(ENGINE).toMatch(/BACKFILL_DEFAULT_BATCH = [2-9]\d{2}/);
    expect(ENGINE).not.toContain(
      "Math.min(20, Math.max(1, Number(body.max_batch) || 12))",
    );
    expect(ENGINE).not.toContain("body.dry_run !== false; // default TRUE");
  });

  it("VERIFICATO richiede scadenza e contributo massimo attestati", () => {
    expect(ENGINE).toContain("maxGrantAmount: maxGrant");
    expect(ENGINE).toContain("maxGrantAmount: newMaxGrant");
    expect(ENGINE).toContain("eligible_ateco_prefixes: localExtractAteco(proofText)");
  });
});
