// TrovaBandi — catalogo ufficiale aperto vs feed personale.
// Il catalogo non richiede profilo, non inventa COMPATIBILE né ATECO 62.
// Il feed `action: feed` resta invariato (profilo obbligatorio + match).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CATALOG_DEFAULT_LIMIT,
  CATALOG_MIN_DEFAULT,
  CATALOG_SAFE_CAP,
  CATALOG_SELECT_COLUMNS,
  catalogMatch,
  isCatalogRequest,
  isOfficialOpenCatalogRow,
  isRealHttpUrl,
  mapCatalogBando,
  parseCatalogPaging,
} from "../../supabase/functions/trovabandi-engine/catalog.ts";

const ENGINE = readFileSync(
  "supabase/functions/trovabandi-engine/index.ts",
  "utf8",
);

const CATALOG_BRANCH = ENGINE.slice(
  ENGINE.indexOf("if (isCatalogRequest("),
  ENGINE.indexOf('if (action === "feed")'),
);
const FEED_BRANCH = ENGINE.slice(
  ENGINE.indexOf('if (action === "feed")'),
  ENGINE.indexOf("const sourceId = normalizeText(body.source_id)"),
);

const NOW = new Date("2026-08-23T12:00:00.000Z");

const OFFICIAL_OPEN = {
  id: "bando-123",
  official_source: true,
  title: "Bando digitalizzazione PMI",
  official_url: "https://www.pd.camcom.it/bandi/digitalizzazione-2026",
  deadline_at: "2026-12-31T00:00:00.000Z",
  authority_name: "CCIAA Padova",
  authority_level: "CAMERALE",
  category: "DIGITALIZZAZIONE",
  summary: "Contributo a fondo perduto per le PMI.",
  eligible_ateco_prefixes: [] as string[],
  forms_url: "https://www.pd.camcom.it/bandi/modulo.pdf",
};

describe("isCatalogRequest", () => {
  it("accetta action catalog e feed con mode catalog", () => {
    expect(isCatalogRequest("catalog")).toBe(true);
    expect(isCatalogRequest("catalog", {})).toBe(true);
    expect(isCatalogRequest("feed", { mode: "catalog" })).toBe(true);
    expect(isCatalogRequest("feed", { mode: " CATALOG " })).toBe(true);
  });

  it("non dirotta il feed personale senza mode catalog", () => {
    expect(isCatalogRequest("feed")).toBe(false);
    expect(isCatalogRequest("feed", {})).toBe(false);
    expect(isCatalogRequest("feed", { mode: "match" })).toBe(false);
    expect(isCatalogRequest("status", { mode: "catalog" })).toBe(false);
  });
});

describe("filtri catalogo ufficiale aperto", () => {
  it("accetta official_source + scadenza aperta + URL http(s) reale", () => {
    expect(isOfficialOpenCatalogRow(OFFICIAL_OPEN, NOW)).toBe(true);
    expect(
      isOfficialOpenCatalogRow({ ...OFFICIAL_OPEN, deadline_at: null }, NOW),
    ).toBe(true);
    expect(isRealHttpUrl("http://bandi.regione.veneto.it/avviso")).toBe(true);
    expect(isRealHttpUrl("https://www.incentivi.gov.it/bando")).toBe(true);
  });

  it("scarta unofficial, scaduti, senza titolo o senza URL reale", () => {
    expect(
      isOfficialOpenCatalogRow({ ...OFFICIAL_OPEN, official_source: false }, NOW),
    ).toBe(false);
    expect(
      isOfficialOpenCatalogRow(
        { ...OFFICIAL_OPEN, deadline_at: "2026-01-01T00:00:00.000Z" },
        NOW,
      ),
    ).toBe(false);
    expect(isOfficialOpenCatalogRow({ ...OFFICIAL_OPEN, title: "  " }, NOW)).toBe(
      false,
    );
    expect(
      isOfficialOpenCatalogRow({ ...OFFICIAL_OPEN, authority_name: "" }, NOW),
    ).toBe(false);
    expect(
      isOfficialOpenCatalogRow({ ...OFFICIAL_OPEN, summary: " " }, NOW),
    ).toBe(false);
    expect(
      isOfficialOpenCatalogRow({ ...OFFICIAL_OPEN, official_url: "" }, NOW),
    ).toBe(false);
    expect(
      isOfficialOpenCatalogRow(
        { ...OFFICIAL_OPEN, official_url: "javascript:alert(1)" },
        NOW,
      ),
    ).toBe(false);
    expect(
      isOfficialOpenCatalogRow(
        { ...OFFICIAL_OPEN, official_url: "/relativo" },
        NOW,
      ),
    ).toBe(false);
    expect(isRealHttpUrl("")).toBe(false);
    expect(isRealHttpUrl("ftp://files.example.it/bando")).toBe(false);
  });
});

describe("catalog match — nessuna invenzione", () => {
  it("omette match senza profilo e non inventa COMPATIBILE", () => {
    expect(catalogMatch(OFFICIAL_OPEN)).toBeUndefined();
    expect(catalogMatch(OFFICIAL_OPEN, {})).toBeUndefined();
    const mapped = mapCatalogBando(OFFICIAL_OPEN);
    expect(mapped).not.toHaveProperty("match");
    expect(mapped.modulistica_url).toBe(OFFICIAL_OPEN.forms_url);
    expect(mapped).not.toHaveProperty("eligible_ateco_codes");
  });

  it("omette modulistica_url quando forms_url è vuoto", () => {
    const mapped = mapCatalogBando({ ...OFFICIAL_OPEN, forms_url: null });
    expect(mapped).not.toHaveProperty("modulistica_url");
    const mapped2 = mapCatalogBando({ ...OFFICIAL_OPEN, forms_url: "  " });
    expect(mapped2).not.toHaveProperty("modulistica_url");
  });

  it("tronca summary a 400 caratteri senza inventare testo", () => {
    const longSummary = "A".repeat(500);
    const mapped = mapCatalogBando({ ...OFFICIAL_OPEN, summary: longSummary });
    const truncated = String(mapped.summary);
    expect(truncated.length).toBeLessThanOrEqual(400);
    expect(truncated).not.toContain("...");
    expect(truncated).toMatch(/^A+$/);
  });

  it("non allunga summary sotto 400 caratteri", () => {
    const short = "Breve descrizione.";
    const mapped = mapCatalogBando({ ...OFFICIAL_OPEN, summary: short });
    expect(mapped.summary).toBe(short);
  });

  it("non inventa ATECO 62 su righe senza prefissi ufficiali", () => {
    const match = catalogMatch(OFFICIAL_OPEN, { codice_ateco: "62.01" });
    expect(match?.status).toBe("DA_VERIFICARE");
    expect(match?.status).not.toBe("COMPATIBILE");
    const prefixes = JSON.stringify(
      (match as { confirmed?: string[] } | undefined)?.confirmed ?? [],
    );
    expect(prefixes).not.toContain("62");
    expect(OFFICIAL_OPEN.eligible_ateco_prefixes).toEqual([]);
  });

  it("marca COMPATIBILE solo se i prefissi ufficiali della riga matchano il profilo", () => {
    const withAteco = {
      ...OFFICIAL_OPEN,
      eligible_ateco_prefixes: ["59.11"],
    };
    expect(catalogMatch(withAteco, { codice_ateco: "59.11.00" })?.status).toBe(
      "COMPATIBILE",
    );
    const mismatch = catalogMatch(withAteco, { codice_ateco: "62.01" });
    expect(mismatch?.status).toBe("NON_COMPATIBILE");
    expect(mismatch?.blockers).toContain("ATECO non ammesso");
    expect(mismatch?.status).not.toBe("DA_VERIFICARE");
    expect(mismatch?.status).not.toBe("COMPATIBILE");
  });
});

describe("catalog payload slimming — campi vuoti omessi", () => {
  it("omette campi opzionali vuoti (stringa vuota, null, array vuoto)", () => {
    const mapped = mapCatalogBando({
      ...OFFICIAL_OPEN,
      region: "",
      province: null,
      eligible_ateco_prefixes: [],
      requirements: "  ",
      notice_url: "https://bandi.example/notice",
      municipality: "Padova",
    });
    expect(mapped).not.toHaveProperty("region");
    expect(mapped).not.toHaveProperty("province");
    expect(mapped).not.toHaveProperty("eligible_ateco_prefixes");
    expect(mapped).not.toHaveProperty("requirements");
    expect(mapped.notice_url).toBe("https://bandi.example/notice");
    expect(mapped.municipality).toBe("Padova");
  });

  it("mantiene i campi del contratto PWA anche quando null", () => {
    const mapped = mapCatalogBando({
      ...OFFICIAL_OPEN,
      deadline_at: null,
    });
    expect(mapped.id).toBe(OFFICIAL_OPEN.id);
    expect(mapped.title).toBe(OFFICIAL_OPEN.title);
    expect(mapped.authority_name).toBe(OFFICIAL_OPEN.authority_name);
    expect(mapped.authority_level).toBe(OFFICIAL_OPEN.authority_level);
    expect(mapped.category).toBe(OFFICIAL_OPEN.category);
    expect(mapped.official_url).toBe(OFFICIAL_OPEN.official_url);
    expect(mapped.summary).toBe(OFFICIAL_OPEN.summary);
    expect(mapped.deadline_at).toBeNull();
    expect(mapped.official_source).toBe(true);
    expect(mapped.modulistica_url).toBe(OFFICIAL_OPEN.forms_url);
  });
});

describe("paginazione catalogo", () => {
  it("senza page/limit/cursor preferisce l'intero catalogo entro un cap sicuro", () => {
    const paging = parseCatalogPaging({});
    expect(paging.fetchAll).toBe(true);
    expect(paging.limit).toBeGreaterThanOrEqual(CATALOG_MIN_DEFAULT);
    expect(paging.limit).toBe(CATALOG_SAFE_CAP);
    expect(CATALOG_DEFAULT_LIMIT).toBeGreaterThanOrEqual(CATALOG_MIN_DEFAULT);
  });

  it("accetta page/limit e cursor numerico", () => {
    expect(parseCatalogPaging({ limit: 250, page: 2 })).toMatchObject({
      fetchAll: false,
      limit: 250,
      page: 2,
      offset: 250,
    });
    expect(parseCatalogPaging({ cursor: 3, limit: 200 })).toMatchObject({
      fetchAll: false,
      page: 3,
      limit: 200,
      offset: 400,
    });
  });
});

describe("motore — catalog vs feed", () => {
  it("espone catalog tra le action e accetta feed mode catalog", () => {
    expect(ENGINE).toContain('"catalog"');
    expect(ENGINE).toContain("isCatalogRequest(action, body)");
    expect(ENGINE).toContain('from "./catalog.ts"');
  });

  it("il catalogo interroga official_source aperti con URL http e non richiede profilo", () => {
    expect(CATALOG_BRANCH).toContain('.eq("official_source", true)');
    expect(CATALOG_BRANCH).toContain("deadline_at.is.null,deadline_at.gte.");
    expect(CATALOG_BRANCH).toContain('.like("official_url", "http%")');
    expect(CATALOG_BRANCH).toContain("CATALOG_SELECT_COLUMNS");
    expect(CATALOG_BRANCH).toContain("isOfficialOpenCatalogRow");
    expect(CATALOG_BRANCH).toContain("OPEN_VERIFICATION_STATUSES");
    expect(CATALOG_BRANCH).not.toContain("PROFILE_INCOMPLETE");
    expect(CATALOG_BRANCH).not.toContain("matchOpportunity");
    expect(CATALOG_BRANCH).not.toContain("NON_COMPATIBILE");
    expect(CATALOG_SELECT_COLUMNS).not.toContain("raw_excerpt");
    expect(CATALOG_SELECT_COLUMNS).not.toContain("eligible_ateco_codes");
  });

  it("il feed personale resta invariato: profilo, match e filtro NON_COMPATIBILE", () => {
    expect(FEED_BRANCH).toContain('code: "PROFILE_INCOMPLETE"');
    expect(FEED_BRANCH).toContain("matchOpportunity");
    expect(FEED_BRANCH).toContain('item.match.status !== "NON_COMPATIBILE"');
    expect(FEED_BRANCH).toContain("Number(body.limit ?? 200)");
    expect(FEED_BRANCH).toContain("OPEN_VERIFICATION_STATUSES");
    expect(FEED_BRANCH).not.toContain('.eq("official_source", true)');
    expect(FEED_BRANCH).not.toContain("isCatalogRequest");
  });

  it("auth e header restano quelli del motore, prima del dispatch action", () => {
    const auth = ENGINE.slice(
      ENGINE.indexOf("serve(async (req)"),
      ENGINE.indexOf("const action = normalizeText"),
    );
    expect(auth).toContain("readIncomingEngineSecret");
    expect(auth).toContain("AI_CORE_SECRET_TROVABANDI");
    expect(auth).toContain("CENTRAL_CORE_JOB_SECRET");
    expect(auth).toContain('code: "UNAUTHORIZED"');
    expect(auth).toContain("SERVER_TO_SERVER_ONLY");
    expect(ENGINE).toContain("if (!ALLOWED_ACTIONS.has(action))");
  });
});
