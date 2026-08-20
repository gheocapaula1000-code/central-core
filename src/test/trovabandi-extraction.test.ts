// TrovaBandi — test mirati su parsing e validazione dell'estrazione.
// Dominio isolato: non tocca Civiko, Wyloni, Sottra o KeyDraft.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  EXTRACTION_CATEGORIES,
  aggregateDiagnostics,
  parseExtractionContent,
  validateExtraction,
} from "../../supabase/functions/trovabandi-engine/extraction";

const ENGINE = readFileSync("supabase/functions/trovabandi-engine/index.ts", "utf8");


const VALID = {
  is_opportunity: true,
  title: "Bando digitalizzazione PMI",
  authority_name: "CCIAA Padova",
  category: "DIGITALIZZAZIONE",
  summary: "Contributo a fondo perduto per progetti di digitalizzazione delle PMI.",
  official_url: "https://www.pd.camcom.it/bandi/digitalizzazione",
  requirements: ["Sede in provincia di Padova"],
};

describe("parseExtractionContent", () => {
  it("accetta JSON puro", () => {
    const out = parseExtractionContent(JSON.stringify(VALID));
    expect(out.ok).toBe(true);
  });

  it("accetta JSON dentro code fence", () => {
    const out = parseExtractionContent("Ecco:\n```json\n" + JSON.stringify(VALID) + "\n```");
    expect(out).toMatchObject({ ok: true });
  });

  it("accetta JSON con prefazione testuale", () => {
    const out = parseExtractionContent("Risultato: " + JSON.stringify(VALID) + " fine.");
    expect(out).toMatchObject({ ok: true });
  });

  it("fallisce con contenuto vuoto", () => {
    expect(parseExtractionContent("   ")).toEqual({ ok: false, code: "EMPTY_CONTENT" });
  });

  it("fallisce con contenuto non JSON", () => {
    expect(parseExtractionContent("nessun dato disponibile")).toEqual({
      ok: false,
      code: "PARSE_FAILED",
    });
  });

  it("rifiuta array di primo livello", () => {
    expect(parseExtractionContent("[1,2,3]")).toEqual({ ok: false, code: "NOT_OBJECT" });
  });
});

describe("validateExtraction — nessun falso positivo", () => {
  const domain = "pd.camcom.it";
  const url = "https://www.pd.camcom.it/bandi/digitalizzazione";

  it("accetta un'opportunità completa sul dominio ufficiale", () => {
    const out = validateExtraction({ ...VALID }, domain, url);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.official_url).toBe(url);
  });

  it("rifiuta is_opportunity diverso da true", () => {
    expect(validateExtraction({ ...VALID, is_opportunity: false }, domain, url)).toEqual({
      ok: false,
      code: "NOT_OPPORTUNITY",
    });
    expect(validateExtraction({ ...VALID, is_opportunity: "true" }, domain, url)).toEqual({
      ok: false,
      code: "NOT_OPPORTUNITY",
    });
  });

  it("rifiuta categorie fuori enum", () => {
    expect(validateExtraction({ ...VALID, category: "MUTUO" }, domain, url)).toEqual({
      ok: false,
      code: "CATEGORY_INVALID",
    });
  });

  it("normalizza categorie con spazi o minuscole", () => {
    const out = validateExtraction({ ...VALID, category: "fondo perduto" }, domain, url);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.category).toBe("FONDO_PERDUTO");
  });

  it("rifiuta evidenza fuori dal dominio ufficiale", () => {
    expect(validateExtraction({ ...VALID }, domain, "https://example.com/bando")).toEqual({
      ok: false,
      code: "URL_OFF_DOMAIN",
    });
  });

  it("rifiuta official_url dichiarato su altro dominio", () => {
    expect(
      validateExtraction({ ...VALID, official_url: "https://example.com/x" }, domain, url),
    ).toEqual({ ok: false, code: "URL_OFF_DOMAIN" });
  });

  it("rifiuta tipi non conformi", () => {
    expect(validateExtraction({ ...VALID, female_only: "si" }, domain, url)).toEqual({
      ok: false,
      code: "SCHEMA_INVALID",
    });
    expect(validateExtraction({ ...VALID, max_grant_amount: "50000" }, domain, url)).toEqual({
      ok: false,
      code: "SCHEMA_INVALID",
    });
    expect(validateExtraction({ ...VALID, requirements: "nessuno" }, domain, url)).toEqual({
      ok: false,
      code: "SCHEMA_INVALID",
    });
  });

  it("rifiuta titolo o summary insufficienti", () => {
    expect(validateExtraction({ ...VALID, title: "x" }, domain, url)).toEqual({
      ok: false,
      code: "SCHEMA_INVALID",
    });
    expect(validateExtraction({ ...VALID, summary: "" }, domain, url)).toEqual({
      ok: false,
      code: "SCHEMA_INVALID",
    });
  });

  it("accetta sottodomini della fonte ufficiale", () => {
    expect(
      validateExtraction({ ...VALID, official_url: null }, "camcom.it", "https://pd.camcom.it/b")
        .ok,
    ).toBe(true);
  });
});

describe("diagnostica non sensibile", () => {
  it("aggrega per fase e codice", () => {
    expect(
      aggregateDiagnostics([
        { phase: "scrape", code: "NO_CONTENT" },
        { phase: "extract", code: "PARSE_FAILED" },
        { phase: "extract", code: "PARSE_FAILED" },
      ]),
    ).toEqual({ "scrape:NO_CONTENT": 1, "extract:PARSE_FAILED": 2 });
  });

  it("l'engine persiste i contatori diagnostici nel run", () => {
    expect(ENGINE).toContain("diagnostics: diagnosticCounters");
    expect(ENGINE).toContain("aggregateDiagnostics(diagnostics)");
  });

  it("l'engine non registra URL completi, markdown o secret nella diagnostica", () => {
    // L'unico riferimento alla fonte è l'hostname, mai il path o la query.
    expect(ENGINE).toContain("new URL(hit.url).hostname");
    expect(ENGINE).not.toMatch(/warnings\.push\(`[^`]*\$\{hit\.url\}/);
    expect(ENGINE).not.toMatch(/diagnostics\.push\([^)]*(hit\.url|markdown|key)[^)]*\)/);
  });

});

describe("fallback controllato e fail-closed", () => {
  it("prevede al massimo due modalità: json_schema poi json_fallback", () => {
    expect(ENGINE.replace(/\s+/g, " ")).toMatch(
      /const modes: Array<"json_schema" \| "json_fallback"> = \[ ?"json_schema", ?"json_fallback",? ?\]/,
    );
  });

  it("non ritenta dopo un rifiuto di validazione", () => {
    expect(ENGINE).toContain("return { ok: false, code: validated.code, mode }");
  });

  it("mantiene l'enum di categoria allineato allo schema JSON dell'engine", () => {
    for (const category of EXTRACTION_CATEGORIES) {
      expect(ENGINE).toContain(`"${category}"`);
    }
  });

  it("resta fail-closed senza secret configurato", () => {
    expect(ENGINE).toContain('code: "AUTH_NOT_CONFIGURED"');
  });
});
