import { describe, expect, it } from "vitest";
import {
  htmlToEvidenceText,
  isAllowedOfficialUrl,
} from "../../../supabase/functions/trovabandi-engine/scrape";

describe("UEradar official-source HTTP fallback", () => {
  it("accetta solo la fonte ufficiale e i suoi sottodomini", () => {
    expect(isAllowedOfficialUrl("https://bandi.regione.marche.it/avviso", "regione.marche.it")).toBe(
      true,
    );
    expect(isAllowedOfficialUrl("https://evil.example/avviso", "regione.marche.it")).toBe(false);
    expect(
      isAllowedOfficialUrl("https://regione.marche.it@evil.example/avviso", "regione.marche.it"),
    ).toBe(false);
  });

  it("blocca host locali e protocolli non HTTP", () => {
    expect(isAllowedOfficialUrl("http://127.0.0.1/admin", "127.0.0.1")).toBe(false);
    expect(isAllowedOfficialUrl("file:///etc/passwd", "example.it")).toBe(false);
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
