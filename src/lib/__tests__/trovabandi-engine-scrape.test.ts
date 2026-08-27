import { describe, expect, it } from "vitest";
import {
  csvToEvidenceText,
  htmlToEvidenceText,
  isCsvContentType,
  isAllowedOfficialUrl,
  isHtmlContentType,
  isPdfContentType,
  officialUrlVariants,
  pdfToEvidenceText,
  readLimitedBytes,
  readLimitedText,
  releaseLoadedPageBodies,
} from "../../../supabase/functions/trovabandi-engine/scrape";

describe("UEradar official-source HTTP fallback", () => {
  it("accetta solo la fonte ufficiale e i suoi sottodomini", () => {
    expect(
      isAllowedOfficialUrl(
        "https://bandi.regione.marche.it/avviso",
        "regione.marche.it",
      ),
    ).toBe(true);
    expect(
      isAllowedOfficialUrl("https://evil.example/avviso", "regione.marche.it"),
    ).toBe(false);
    expect(
      isAllowedOfficialUrl(
        "https://regione.marche.it@evil.example/avviso",
        "regione.marche.it",
      ),
    ).toBe(false);
  });

  it("blocca host locali e protocolli non HTTP", () => {
    expect(isAllowedOfficialUrl("http://127.0.0.1/admin", "127.0.0.1")).toBe(
      false,
    );
    expect(isAllowedOfficialUrl("file:///etc/passwd", "example.it")).toBe(
      false,
    );
    expect(isAllowedOfficialUrl("https://[::1]/admin", "::1")).toBe(false);
    expect(
      isAllowedOfficialUrl("https://example.it:8443/avviso", "example.it"),
    ).toBe(false);
  });

  it("rifiuta il corpo quando supera il limite reale anche senza Content-Length", async () => {
    const response = new Response("123456789");
    await expect(readLimitedText(response, 8)).resolves.toBeNull();
  });

  it("legge il corpo entro il limite", async () => {
    const response = new Response("bando ufficiale");
    await expect(readLimitedText(response, 100)).resolves.toBe(
      "bando ufficiale",
    );
  });

  it("estrae testo leggibile senza script, stile o markup", () => {
    const result = htmlToEvidenceText(`
      <html><head><title>Bando &amp; imprese</title><style>.x{display:none}</style></head>
      <body><h1>Contributi 2026</h1><script>alert("x")</script>
      <p>Domande entro il 30/09/2026.</p></body></html>
    `);
    expect(result.title).toBe("Bando & imprese");
    expect(result.text).toContain("Contributi 2026");
    expect(result.text).toContain("Domande entro il 30/09/2026.");
    expect(result.text).not.toContain("alert");
    expect(result.text).not.toContain("display:none");
  });
});

describe("UEradar www fallback e PDF ufficiali", () => {
  it("prova la variante www quando l'apex non risolve (MIMIT, MUR, Invitalia)", () => {
    expect(officialUrlVariants("https://mimit.gov.it/it/incentivi/x")).toEqual([
      "https://mimit.gov.it/it/incentivi/x",
      "https://www.mimit.gov.it/it/incentivi/x",
    ]);
    expect(
      officialUrlVariants("https://www.invitalia.it/incentivi"),
    ).toEqual(["https://www.invitalia.it/incentivi"]);
  });

  it("aggiunge la variante https per candidati http (padovanet)", () => {
    expect(
      officialUrlVariants("http://padovanet.it/sites/default/files/a.pdf"),
    ).toEqual([
      "http://padovanet.it/sites/default/files/a.pdf",
      "http://www.padovanet.it/sites/default/files/a.pdf",
      "https://padovanet.it/sites/default/files/a.pdf",
      "https://www.padovanet.it/sites/default/files/a.pdf",
    ]);
  });

  it("le varianti restano dentro il dominio ufficiale", () => {
    for (const variant of officialUrlVariants("https://mur.gov.it/atti/1")) {
      expect(isAllowedOfficialUrl(variant, "mur.gov.it")).toBe(true);
    }
    expect(officialUrlVariants("javascript:alert(1)")).toEqual([]);
  });

  it("riconosce i content-type PDF anche malformati (BUR Veneto)", () => {
    expect(isPdfContentType("application/application/pdf")).toBe(true);
    expect(isPdfContentType("application/pdf; charset=binary")).toBe(true);
    expect(isPdfContentType("text/html")).toBe(false);
    expect(isHtmlContentType("application/xhtml+xml")).toBe(true);
  });

  it("estrae testo da un PDF non compresso e resta vuoto sui PDF immagine", async () => {
    const body = "BT (Avviso pubblico contributi 2026) Tj T* (Scadenza 30/09/2026) Tj ET";
    const pdf = `%PDF-1.4\n1 0 obj<</Length ${body.length}>>stream\n${body}\nendstream\nendobj\n/Title (Bando ufficiale)\n%%EOF`;
    const parsed = await pdfToEvidenceText(new TextEncoder().encode(pdf));
    expect(parsed.text).toContain("Avviso pubblico contributi 2026");
    expect(parsed.text).toContain("Scadenza 30/09/2026");
    expect(parsed.title).toBe("Bando ufficiale");

    const scanned = `%PDF-1.4\n2 0 obj<</Filter /DCTDecode>>stream\nBINARYIMAGE\nendstream\n%%EOF`;
    const empty = await pdfToEvidenceText(new TextEncoder().encode(scanned));
    expect(empty.text).toBe("");
  });

  it("rifiuta PDF oltre il limite di byte", async () => {
    const big = new Response(new Uint8Array(1024));
    await expect(readLimitedBytes(big, 512)).resolves.toBeNull();
  });

  it("estrae testo da un PDF sintetico piccolo se ci sono operatori", async () => {
    const body = "BT (Contributo fino a 50.000 euro) Tj T* (Scadenza 15/10/2026) Tj ET";
    const pdf = `%PDF-1.4\n1 0 obj<</Length ${body.length}>>stream\n${body}\nendstream\nendobj\n%%EOF`;
    const parsed = await pdfToEvidenceText(new TextEncoder().encode(pdf));
    expect(parsed.text).toContain("Contributo fino a 50.000 euro");
    expect(parsed.text).toContain("Scadenza 15/10/2026");
  });

  it("su buffer >400kB non lancia e termina in tempo ragionevole, parse solo i primi 400k", async () => {
    const body = "BT (Avviso pubblico contributi 2026) Tj T* (Domande entro il 30/09/2026) Tj ET";
    const head = `%PDF-1.4\n1 0 obj<</Length ${body.length}>>stream\n${body}\nendstream\nendobj\n/Title (Bando ufficiale)\n%%EOF`;
    const headBytes = new TextEncoder().encode(head);
    const huge = new Uint8Array(2_000_000);
    huge.set(headBytes, 0);
    const started = Date.now();
    const parsed = await pdfToEvidenceText(huge);
    const elapsed = Date.now() - started;
    expect(parsed.text).toContain("Avviso pubblico contributi 2026");
    expect(parsed.text).toContain("Domande entro il 30/09/2026");
    expect(elapsed).toBeLessThan(8_000);
  });

  it("resta fail-closed vuoto su payload PDF spazzatura", async () => {
    const garbage = await pdfToEvidenceText(
      new TextEncoder().encode("%%% not a pdf %%% random garbage without operators"),
    );
    expect(garbage.text).toBe("");
    expect(garbage.title).toBe("");
    const binary = await pdfToEvidenceText(new Uint8Array(4096).fill(0xff));
    expect(binary.text).toBe("");
  });
});

describe("UEradar CSV Open Data ufficiali", () => {
  const enc = (value: string) => new TextEncoder().encode(value);

  it("accetta solo i content-type CSV ufficiali", () => {
    expect(isCsvContentType("text/csv; charset=utf-8")).toBe(true);
    expect(isCsvContentType("application/csv")).toBe(true);
    expect(isCsvContentType("application/vnd.ms-excel")).toBe(true);
    expect(isCsvContentType("application/zip")).toBe(false);
    expect(isCsvContentType("application/octet-stream")).toBe(false);
  });

  it("converte un CSV ufficiale valido in evidenza testuale (BOM incluso)", () => {
    const csv =
      "\uFEFFtitolo;ente;scadenza\nContributi imprese 2026;Incentivi.gov.it;30/09/2026\nBando digitale;MIMIT;15/10/2026\n";
    const parsed = csvToEvidenceText(enc(csv));
    expect(parsed.title).toBe("titolo | ente | scadenza");
    expect(parsed.text).toContain("titolo: Contributi imprese 2026");
    expect(parsed.text).toContain("scadenza: 15/10/2026");
    expect(parsed.text).not.toContain("\uFEFF");
  });

  it("non esegue formule e non inventa dati", () => {
    const parsed = csvToEvidenceText(enc("a;b\n=SUM(1,2);\n"));
    expect(parsed.text).toContain("a: =SUM(1,2)");
    expect(parsed.text).not.toContain("b:");
  });

  it("resta fail-closed su CSV vuoto, solo header o malformato", () => {
    expect(csvToEvidenceText(enc("")).text).toBe("");
    expect(csvToEvidenceText(enc("titolo;ente;scadenza\n")).text).toBe("");
    expect(csvToEvidenceText(enc("solo-una-colonna\nvalore\n")).text).toBe("");
    expect(csvToEvidenceText(enc("a;b\n;\n")).text).toBe("");
  });

  it("rispetta il limite byte esplicito sul corpo CSV", async () => {
    const big = new Response(new Uint8Array(2048));
    await expect(readLimitedBytes(big, 1024)).resolves.toBeNull();
  });

  it("non accetta CSV serviti da un dominio non ufficiale", () => {
    expect(
      isAllowedOfficialUrl(
        "https://evil.example/open-data/export.csv",
        "incentivi.gov.it",
      ),
    ).toBe(false);
    expect(
      isAllowedOfficialUrl(
        "https://www.incentivi.gov.it/sites/default/files/open-data/2025-4-5_opendata-export.csv",
        "incentivi.gov.it",
      ),
    ).toBe(true);
  });
});

describe("releaseLoadedPageBodies", () => {
  it("drops html and optionally markdown without inventing fields", () => {
    const page: { html?: string; markdown?: string; title?: string } = {
      html: "<html>" + "x".repeat(2000) + "</html>",
      markdown: "Scadenza: 15 settembre 2026. Contributo fino a 500.000 euro.",
      title: "Avviso",
    };
    releaseLoadedPageBodies(page);
    expect(page.html).toBeUndefined();
    expect(page.markdown).toContain("Scadenza");
    expect(page.title).toBe("Avviso");
    releaseLoadedPageBodies(page, { markdown: true });
    expect(page.markdown).toBe("");
    expect(page.title).toBe("Avviso");
    expect(() => releaseLoadedPageBodies(null)).not.toThrow();
    expect(() => releaseLoadedPageBodies(undefined)).not.toThrow();
  });
});

