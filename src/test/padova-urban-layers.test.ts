import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  CKAN_CATALOGS,
  LIVE_CORE_REF,
  OFFICIAL_ZONE_SLUGS,
  PIANO_GEOPORTALE_URL,
  PIANO_SOURCE_PAGES,
  SUE_SOURCE_PAGES,
  WFS_REGIONE_VENETO,
  computeZoneSentiment,
  extractOfficialElaborati,
  inferZoneFromText,
  isOfficialZoneSlug,
  isUrbanisticaWfsLayer,
  mapCsvToPermit,
  mapOsmToPermit,
  mapWfsFeatureToPiano,
  parseCsvRows,
  parseWfsFeatureTypes,
  requireZoneSlug,
  selectPadovaEdiliziaPackages,
} from "../../supabase/functions/_shared/padovaUrbanLayers.ts";
import { SOURCE_PLAN, AUTOMATED_TRIGGERS } from "../../supabase/functions/_shared/sourceScheduler.ts";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const allSql = () =>
  readdirSync(resolve(root, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => read(`supabase/migrations/${f}`))
    .join("\n\n");

const MIGRATION = "supabase/migrations/20260820080000_padova_urban_layers_and_portal_timeouts.sql";
const SUE_FN = "supabase/functions/civiko-sue-padova-collect/index.ts";
const PIANO_FN = "supabase/functions/civiko-piano-regolatore-collect/index.ts";
const SENT_FN = "supabase/functions/civiko-sentiment-refresh/index.ts";
const READ_FN = "supabase/functions/civiko-urban-layers/index.ts";

describe("official commercial zone slugs", () => {
  it("matches the eight Comune commercial zones only", () => {
    expect([...OFFICIAL_ZONE_SLUGS].sort()).toEqual([
      "centro-storico",
      "est-brenta",
      "nord-arcella",
      "nord-est",
      "ovest-chiesanuova-brentelle",
      "sud-est-sant-osvaldo",
      "sud-ovest-mandria",
      "sud-voltabarozzo-guizza",
    ].sort());
    expect(isOfficialZoneSlug("centro-storico")).toBe(true);
    expect(isOfficialZoneSlug("est-forcellini-camin")).toBe(false);
    expect(isOfficialZoneSlug("padova")).toBe(false);
  });

  it("requireZoneSlug fail-closes unknown / wildcard slugs", () => {
    expect(requireZoneSlug("nord-arcella")).toEqual({ ok: true, slug: "nord-arcella" });
    expect(requireZoneSlug("modena").ok).toBe(false);
    expect(requireZoneSlug("centro%storico").ok).toBe(false);
    expect(requireZoneSlug("").ok).toBe(false);
    expect(requireZoneSlug(null).ok).toBe(false);
  });
});

describe("CKAN Padova-only filter", () => {
  it("keeps Comune di Padova edilizia packages", () => {
    const kept = selectPadovaEdiliziaPackages([
      {
        title: "Permessi di costruire — Comune di Padova",
        name: "permessi-costruire-padova",
        notes: "Pratiche SUE edilizia residenziale",
        organization: { title: "Comune di Padova", name: "comune-di-padova" },
      },
    ]);
    expect(kept).toHaveLength(1);
  });

  it("drops Modena / Emilia-Romagna banca-dati-pratiche-edilizie even if query mentions Padova", () => {
    const dropped = selectPadovaEdiliziaPackages([
      {
        title: "Banca dati pratiche edilizie",
        name: "banca-dati-pratiche-edilizie",
        notes: "Dataset regionale Emilia-Romagna — Comune di Modena",
        organization: { title: "Comune di Modena", name: "comune-di-modena" },
      },
      {
        title: "Elenco cantieri aperti",
        name: "cantieri-modena",
        notes: "SUE Modena. Mentions Padova only in passing as a comparison city.",
        organization: { title: "Regione Emilia-Romagna" },
      },
    ]);
    expect(dropped).toHaveLength(0);
  });

  it("drops packages that do not mention Padova", () => {
    expect(selectPadovaEdiliziaPackages([
      { title: "Permessi di costruire Veneto", notes: "edilizia regionale", organization: { title: "Regione Veneto" } },
    ])).toHaveLength(0);
  });
});

describe("CSV → permit mapping", () => {
  it("maps a Padova SUE CSV row and infers Arcella → nord-arcella", () => {
    const rows = parseCsvRows(
      "protocollo;indirizzo;quartiere;tipo;stato;data\n" +
      "SUE-2026-11;Via Arcella 12;Arcella;SCIA;rilasciato;15/03/2026\n",
    );
    expect(rows).toHaveLength(1);
    const rec = mapCsvToPermit(rows[0], "https://example.test/sue.csv", "ckan-padova", "2026-08-20T00:00:00.000Z", true);
    expect(rec).not.toBeNull();
    expect(rec!.external_id).toBe("SUE-2026-11");
    expect(rec!.address_public).toBe("Via Arcella 12");
    expect(rec!.practice_type).toBe("SCIA");
    expect(rec!.practice_date).toBe("2026-03-15");
    expect(rec!.commercial_zone_slug).toBe("nord-arcella");
    expect(rec!.source_url).toBe("https://example.test/sue.csv");
    expect(rec!.fetched_at).toBe("2026-08-20T00:00:00.000Z");
  });

  it("does not invent a zone from free text that is not a quartiere", () => {
    expect(inferZoneFromText("qualche cantiere in città")).toBeNull();
    expect(inferZoneFromText("Modena centro")).toBeNull();
    const rec = mapCsvToPermit(
      { indirizzo: "Via Sconosciuta 1", tipo: "CILA" },
      "https://example.test/x.csv",
      "ckan",
      "2026-08-20T00:00:00.000Z",
      false,
    );
    expect(rec!.commercial_zone_slug).toBeNull();
  });

  it("returns null when a row has no address and no identifier", () => {
    expect(mapCsvToPermit({}, "https://example.test/x.csv", "ckan", "2026-08-20T00:00:00.000Z", false)).toBeNull();
  });
});

describe("OSM construction → permit", () => {
  it("maps an Overpass element with official OSM url and no invented zone", () => {
    const rec = mapOsmToPermit({
      type: "way",
      id: 424242,
      tags: { building: "construction", name: "Nuovo edificio" },
    }, "2026-08-20T05:00:00.000Z");
    expect(rec.source_url).toBe("https://www.openstreetmap.org/way/424242");
    expect(rec.external_id).toBe("osm:way/424242");
    expect(rec.practice_type).toBe("cantiere_edilizio");
    expect(rec.commercial_zone_slug).toBeNull();
    expect(rec.compliance_verified).toBe(false);
    expect(rec.practice_date).toBeNull();
  });

  it("infers zone only from an exact quartiere tag", () => {
    const rec = mapOsmToPermit({
      type: "node",
      id: 7,
      tags: { landuse: "construction", "addr:suburb": "Arcella", "addr:street": "Via Test" },
    }, "2026-08-20T05:00:00.000Z");
    expect(rec.commercial_zone_slug).toBe("nord-arcella");
    expect(rec.practice_type).toBe("area_cantiere");
  });
});

describe("piano regolatore extractors", () => {
  it("returns no elaborati when HTML is not an official PAT/PI page", () => {
    expect(extractOfficialElaborati("<html><p>Cookie policy</p></html>", "https://example.test", "2026-08-20T00:00:00.000Z")).toEqual([]);
  });

  it("records centro-storico tavole and geoportale only when the official page names them", () => {
    const html = `
      <h1>Piano degli Interventi</h1>
      <p>Tavole del centro storico — elaborati vigenti.</p>
      <p>Geoportale: cartografia.comune.padova.it</p>
    `;
    const rows = extractOfficialElaborati(html, PIANO_SOURCE_PAGES[1], "2026-08-20T00:00:00.000Z");
    expect(rows.some((r) => r.commercial_zone_slug === "centro-storico")).toBe(true);
    expect(rows.some((r) => r.title.includes("Geoportale"))).toBe(true);
    expect(rows.every((r) => r.source_url === PIANO_SOURCE_PAGES[1])).toBe(true);
    expect(rows.every((r) => r.fetched_at === "2026-08-20T00:00:00.000Z")).toBe(true);
    expect(PIANO_GEOPORTALE_URL).toContain("cartografia.comune.padova.it");
  });

  it("filters WFS feature types to urbanistica layers only", () => {
    const xml = `
      <FeatureTypeList>
        <FeatureType><Name>rv:pat_zto</Name><Title>PAT zone territoriali omogenee</Title></FeatureType>
        <FeatureType><Name>rv:strade</Name><Title>Rete stradale</Title></FeatureType>
      </FeatureTypeList>
    `;
    expect(isUrbanisticaWfsLayer("rv:pat_zto", "PAT zone")).toBe(true);
    expect(isUrbanisticaWfsLayer("rv:strade", "Rete stradale")).toBe(false);
    expect(parseWfsFeatureTypes(xml).map((l) => l.name)).toEqual(["rv:pat_zto"]);
  });

  it("drops WFS features that are not Padova / 028027", () => {
    const other = mapWfsFeatureToPiano("rv:pat_zto", "PAT", {
      id: "x1",
      properties: { nome: "Comune di Vicenza", codice: "024116" },
    }, "2026-08-20T00:00:00.000Z");
    expect(other).toBeNull();

    const padova = mapWfsFeatureToPiano("rv:pat_zto", "PAT", {
      id: "p1",
      properties: { nome: "Padova", codice_istat: "028027", zto: "A2" },
    }, "2026-08-20T00:00:00.000Z");
    expect(padova).not.toBeNull();
    expect(padova!.zone_code).toBe("A2");
    expect(padova!.source_url).toContain(WFS_REGIONE_VENETO);
    expect(padova!.fetched_at).toBe("2026-08-20T00:00:00.000Z");
  });
});

describe("computeZoneSentiment — no fabricated scores", () => {
  const now = "2026-08-20T05:40:00.000Z";

  it("leaves total null and quality parziale when no inputs exist", () => {
    const row = computeZoneSentiment("centro-storico", {}, now);
    expect(row.sentiment_score_total).toBeNull();
    expect(row.environment_score).toBeNull();
    expect(row.air_quality_score).toBeNull();
    expect(row.services_score).toBeNull();
    expect(row.confidence_score).toBe(0);
    expect(row.quality).toBe("parziale");
    expect(row.fingerprint).toBe("mzs:PD:padova:centro-storico");
    expect(row.commercial_zone_slug).toBe("centro-storico");
  });

  it("does not invent a services score from zero listings or zero permits", () => {
    const row = computeZoneSentiment("nord-arcella", { listing_count: 0, permit_count: 0 }, now);
    expect(row.services_score).toBeNull();
    expect(row.urban_decay_risk_score).toBeNull();
    expect(row.sentiment_score_total).toBeNull();
  });

  it("uses only provided axes and records their data_basis", () => {
    const row = computeZoneSentiment("est-brenta", {
      air_quality_score: 70,
      listing_count: 8,
    }, now);
    expect(row.air_quality_score).toBe(70);
    expect(row.services_score).not.toBeNull();
    expect(row.sentiment_score_total).not.toBeNull();
    expect(row.data_basis).toContain("air_quality_score");
    expect(row.data_basis).toContain("padova_listings");
    expect(row.source_refs.some((r) => r.source_name === "padova_listings")).toBe(true);
  });
});

describe("migration — live Core urban layers + portal timeouts", () => {
  const sql = read(MIGRATION);
  const all = allSql();

  it("targets live Core only and never central-core-prod", () => {
    expect(sql).toContain(LIVE_CORE_REF);
    expect(sql).toContain("jpunnzgixcghuydstdlt.supabase.co");
    expect(sql).not.toContain("egjvullvkwpzyyworeml");
    expect(sql).toContain("Does not target central-core-prod");
    expect(sql).not.toMatch(/egjvullvkwpzyyworeml|central-core-prod\.supabase/);
  });

  it("looks up vault CENTRAL_CORE_JOB_SECRET (uppercase) only", () => {
    expect(sql).toContain("WHERE name = 'CENTRAL_CORE_JOB_SECRET'");
    expect(sql).not.toMatch(/name = 'central_core_job_secret'/);
    expect(sql).not.toMatch(/C1v1k0C0r3|sk_live|eyJhbGci/);
  });

  it("creates piano table + zone views and does not invent permit rows", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.padova_piano_regolatore");
    expect(sql).toContain("source_url text NOT NULL");
    expect(sql).toContain("fetched_at timestamptz NOT NULL");
    expect(sql).toContain("sue_padova_permits_by_zone_v");
    expect(sql).toContain("padova_piano_regolatore_by_zone_v");
    expect(sql).toContain("microzone_sentiment_by_zone_v");
    expect(sql).toContain("REVOKE ALL ON public.sue_padova_permits_by_zone_v FROM PUBLIC, anon");
    expect(sql).not.toMatch(/INSERT INTO public\.sue_padova_permits/);
    expect(sql).not.toMatch(/INSERT INTO public\.padova_piano_regolatore/);
    expect(sql).not.toMatch(/INSERT INTO public\.microzone_sentiment/);
  });

  it("keeps collect-pending drain and scrape watchdog scheduled", () => {
    expect(sql).not.toContain("unschedule('portal-collect-pending-drain')");
    expect(sql).not.toContain("unschedule('expire-stale-scrape-jobs')");
    expect(all).toContain("'portal-collect-pending-drain'");
    expect(all).toContain("'expire-stale-scrape-jobs'");
    expect(all).toContain("expire_stale_scrape_jobs");
  });

  it("schedules every listing portal plus SUE / piano / sentiment with timeouts", () => {
    for (const name of [
      "portal-immobiliare-padova",
      "portal-idealista-padova",
      "portal-subito-padova",
      "portal-casa-padova",
      "civiko-bakeca-scrape",
      "portal-collect-pending",
      "official-sue-padova",
      "official-piano-regolatore",
      "official-sentiment-refresh",
    ]) {
      expect(sql).toContain(`'${name}'`);
    }
    expect(sql).toContain('{"max_items":500}');
    expect(sql).toContain('"max_runs":30');
    expect(sql).toMatch(/60000|100000|120000|90000/);
  });
});

describe("collectors + read API contracts", () => {
  const cfg = read("supabase/config.toml");
  const sue = read(SUE_FN);
  const piano = read(PIANO_FN);
  const sent = read(SENT_FN);
  const api = read(READ_FN);

  it("registers the four functions with verify_jwt = false on live Core", () => {
    expect(cfg).toContain(`project_id = "${LIVE_CORE_REF}"`);
    for (const name of [
      "civiko-sue-padova-collect",
      "civiko-piano-regolatore-collect",
      "civiko-sentiment-refresh",
      "civiko-urban-layers",
    ]) {
      const block = cfg.match(new RegExp(`\\[functions\\.${name}\\]([\\s\\S]*?)(?:\\n\\[|$)`));
      expect(block, `${name} missing from config.toml`).not.toBeNull();
      expect(block![1]).toMatch(/verify_jwt\s*=\s*false/);
      expect(existsSync(resolve(root, `supabase/functions/${name}/index.ts`))).toBe(true);
    }
  });

  it("job collectors require CENTRAL_CORE_JOB_SECRET and fail-closed", () => {
    for (const [label, src] of [["sue", sue], ["piano", piano], ["sentiment", sent]] as const) {
      expect(src, label).toContain('Deno.env.get("CENTRAL_CORE_JOB_SECRET")');
      expect(src, label).toContain("isJobSecretAuthorized");
      expect(src, label).toContain("jobAuthFailure");
      expect(src, label).not.toMatch(/body\s*[?.]*\.?(job_secret|jobSecret)/);
      expect(src, label).not.toMatch(/central_core_job_secret/);
      expect(src, label).not.toMatch(/C1v1k0C0r3|eyJhbGci/);
    }
  });

  it("SUE / piano fail-closed when official sources cannot be read", () => {
    expect(sue).toContain("official_sources_unreadable");
    expect(sue).toContain("sourcesRead === 0");
    expect(sue).toContain("Do not invent rows");
    expect(sue).toContain("sue_padova_permits");
    expect(sue).toContain("onConflict: \"source_url,external_id\"");
    expect(sue).toContain("upsert_failed");
    expect(piano).toContain("official_sources_unreadable");
    expect(piano).toContain("padova_piano_regolatore");
    expect(PIANO_SOURCE_PAGES.length).toBeGreaterThan(0);
    expect(SUE_SOURCE_PAGES.length).toBeGreaterThan(0);
    expect(CKAN_CATALOGS).toContain("https://dati.veneto.it");
  });

  it("sentiment recomputes from real tables and never hardcodes scores", () => {
    expect(sent).toContain("from(\"microzone_sentiment\")");
    expect(sent).toContain("from(\"padova_listings\")");
    expect(sent).toContain("from(\"sue_padova_permits\")");
    expect(sent).toContain("from(\"territorial_signals\")");
    expect(sent).toContain("from(\"padova_elderly_population\")");
    expect(sent).toContain("computeZoneSentiment");
    expect(sent).not.toMatch(/sentiment_score_total:\s*[0-9]/);
    expect(sent).not.toMatch(/environment_score:\s*[0-9]/);
  });

  it("read API is GET-only, zone-isolated, and does not leak secrets", () => {
    expect(api).toContain("requireZoneSlug");
    expect(api).toContain("sue_padova_permits_by_zone_v");
    expect(api).toContain("padova_piano_regolatore_by_zone_v");
    expect(api).toContain("microzone_sentiment_by_zone_v");
    expect(api).toContain(".eq(\"commercial_zone_slug\", slug)");
    expect(api).toMatch(/method !== "GET"/);
    expect(api).not.toContain("CENTRAL_CORE_JOB_SECRET");
    expect(api).not.toMatch(/eyJhbGci|sk_live|C1v1k0C0r3/);
  });
});

describe("scheduler + health + Actions fallback", () => {
  const health = read("supabase/functions/core-cron-health-public/index.ts");
  const yml = read(".github/workflows/cron-official-opendata.yml");
  const docs = read("docs/civiko-source-scheduler.md");

  it("F18 is automated with official-sue-padova trigger", () => {
    expect(SOURCE_PLAN.F18.automation_status).toBe("automated");
    expect(SOURCE_PLAN.F18.job).toBe("civiko-sue-padova-collect");
    expect(AUTOMATED_TRIGGERS.F18.cron_job).toBe("official-sue-padova");
    expect(AUTOMATED_TRIGGERS.F18.endpoint).toBe("/civiko-sue-padova-collect");
  });

  it("health lists Bakeca + urban-layer jobs and keeps drain/watchdog", () => {
    expect(health).toContain('jobname: "civiko-bakeca-scrape"');
    expect(health).toContain('jobname: "official-sue-padova"');
    expect(health).toContain('jobname: "official-piano-regolatore"');
    expect(health).toContain('jobname: "official-sentiment-refresh"');
    expect(health).toContain('jobname: "portal-collect-pending-drain"');
    expect(health).toContain('jobname: "expire-stale-scrape-jobs"');
  });

  it("GitHub Actions fallback posts the three urban collectors with Actions secret", () => {
    expect(yml).toContain("civiko-sue-padova-collect");
    expect(yml).toContain("civiko-piano-regolatore-collect");
    expect(yml).toContain("civiko-sentiment-refresh");
    expect(yml).toContain("secrets.CENTRAL_CORE_JOB_SECRET");
    expect(yml).not.toMatch(/C1v1k0C0r3|sk_live|eyJhbGci/);
    expect(yml).not.toContain("egjvullvkwpzyyworeml");
  });

  it("docs list the new official jobs on live Core", () => {
    expect(docs).toContain("official-sue-padova");
    expect(docs).toContain("official-piano-regolatore");
    expect(docs).toContain("official-sentiment-refresh");
    expect(docs).toContain("CENTRAL_CORE_JOB_SECRET");
  });
});

describe("portal throughput + fail-closed timeout", () => {
  const bakeca = read("supabase/functions/civiko-bakeca-scrape/index.ts");
  const bakecaParse = read("supabase/functions/civiko-bakeca-scrape/parse.ts");
  const subito = read("supabase/functions/cron-apify-subito-nightly/index.ts");
  const idealista = read("supabase/functions/cron-apify-idealista-nightly/index.ts");
  const collect = read("supabase/functions/padova-apify-subito-collect/index.ts");
  const pending = read("supabase/functions/cron-apify-collect-pending/index.ts");

  it("Bakeca paginates with a wall-clock timeout and returns 504", () => {
    expect(bakecaParse).toContain("BAKECA_MAX_PAGES = 8");
    expect(bakecaParse).toContain("BAKECA_JOB_TIMEOUT_MS = 90_000");
    expect(bakeca).toContain("AbortSignal.timeout");
    expect(bakeca).toContain("504");
  });

  it("Subito / Idealista raise defaults and fail-closed on AbortError", () => {
    expect(subito).toMatch(/max_items:\s*500/);
    expect(subito).toContain("504");
    expect(idealista).toMatch(/desired_results:\s*300/);
    expect(idealista).toMatch(/max_urls_from_db:\s*240/);
    expect(idealista).toMatch(/max_items:\s*600/);
    expect(idealista).toContain("504");
    expect(collect).toContain('error: "timeout"');
    expect(collect).toContain('status: "FAILED"');
    expect(collect).toContain("504");
    expect(pending).toMatch(/max_runs:\s*30/);
  });
});

describe("dry-run note", () => {
  it("records that live Core SQL is not applied from this agent and collectors persist 0 if unread", () => {
    // Live Core (jpunnzgixcghuydstdlt) is not queryable from this workspace.
    // Supabase MCP only lists central-core-prod, which this PR must not target.
    // After deploy: apply 20260820080000 on live Core, redeploy the four
    // urban functions + portal wrappers. Empty sue_padova_permits / piano
    // rows is success when official sources are up but return 0 Padova rows.
    expect(LIVE_CORE_REF).toBe("jpunnzgixcghuydstdlt");
    expect(read(SUE_FN)).toContain("empty");
    expect(read(PIANO_FN)).toContain("empty");
  });
});
