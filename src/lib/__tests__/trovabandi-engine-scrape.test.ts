import { describe, expect, it } from "vitest";
import {
  htmlToEvidenceText,
  isAllowedOfficialUrl,
  isHtmlContentType,
  isPdfContentType,
  officialUrlVariants,
  pdfToEvidenceText,
  readLimitedBytes,
  readLimitedText,
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
});
