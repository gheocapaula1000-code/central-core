// TrovaBandi — allegati strutturati fail-closed.
// Dominio isolato: non tocca Civiko. Nessun dato bando inventato oltre
// wording ufficiale di fixture.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  attestExtractedAllegati,
  extractOfficialAllegati,
} from "../../supabase/functions/trovabandi-engine/allegati.ts";
import { localOpportunityDraft } from "../../supabase/functions/trovabandi-engine/local-fields.ts";

const ENGINE = readFileSync(
  "supabase/functions/trovabandi-engine/index.ts",
  "utf8",
);
const MIGRATION = readFileSync(
  "supabase/migrations/20260905120000_trovabandi_allegati_verificato_gate.sql",
  "utf8",
);

const OFFICIAL = "https://bandi.regione.veneto.it/avvisi/bando-pmi-2026";
const DOMAIN = "regione.veneto.it";

const NAMED_MD = `
Avviso pubblico — bando contributi a fondo perduto per le PMI venete.
Le domande devono essere presentate entro il 30 settembre 2026.
Dotazione 2 milioni di euro.

Allegati
- Allegato A — Modulo di domanda (obbligatorio)
- Allegato B — Dichiarazione sostitutiva di atto di notorietà
- Allegato C — Relazione tecnica (facoltativo)
`.repeat(2);

const NAMED_HTML = `
<h2>Allegati al bando</h2>
<ul>
  <li><a href="/docs/allegato-a-modulo.pdf">Allegato A — Modulo di domanda</a> (obbligatorio)</li>
  <li><a href="/docs/allegato-b.pdf">Allegato B — Dichiarazione sostitutiva</a></li>
</ul>
`;

const NO_ALLEGATI = `
Avviso pubblico — bando contributi a fondo perduto per le PMI.
Le domande devono essere presentate entro il 30 settembre 2026.
Scarica il PDF. Clicca qui. Documentazione ufficiale.
Dotazione finanziaria e requisiti sono indicati nell'avviso.
`.repeat(2);

describe("extractOfficialAllegati — presenti quando la fonte li noma", () => {
  it("estrae elenco ufficiale sotto intestazione Allegati", () => {
    const got = extractOfficialAllegati({
      markdown: NAMED_MD,
      officialUrl: OFFICIAL,
      officialDomain: DOMAIN,
    });
    expect(got.map((item) => item.nome)).toEqual([
      "Allegato A — Modulo di domanda",
      "Allegato B — Dichiarazione sostitutiva di atto di notorietà",
      "Allegato C — Relazione tecnica",
    ]);
    expect(got.find((item) => item.nome.startsWith("Allegato A"))?.obbligatorio)
      .toBe(true);
    expect(got.find((item) => item.nome.startsWith("Allegato C"))?.obbligatorio)
      .toBe(false);
  });

  it("prende nome e URL solo da link etichettati Allegato", () => {
    const got = extractOfficialAllegati({
      html: NAMED_HTML,
      officialUrl: OFFICIAL,
      officialDomain: DOMAIN,
    });
    expect(got).toHaveLength(2);
    const first = got.find((item) => item.nome.includes("Modulo di domanda"));
    expect(first?.url).toBe(
      "https://bandi.regione.veneto.it/docs/allegato-a-modulo.pdf",
    );
    expect(first?.obbligatorio).toBe(true);
  });
});

describe("extractOfficialAllegati — vuoto se assenti o non attestati", () => {
  it("resta [] senza intestazione né nome Allegato", () => {
    expect(
      extractOfficialAllegati({
        markdown: NO_ALLEGATI,
        officialUrl: OFFICIAL,
        officialDomain: DOMAIN,
      }),
    ).toEqual([]);
  });

  it("non inventa filename da un PDF senza nome", () => {
    const html = `
      <p>Avviso pubblico per contributi alle PMI.</p>
      <a href="/documenti/decreto-approvazione.pdf">Download PDF</a>
      <a href="/contatti">Contatti</a>
    `;
    expect(
      extractOfficialAllegati({
        html,
        officialUrl: OFFICIAL,
        officialDomain: DOMAIN,
      }),
    ).toEqual([]);
  });

  it("scarta nomi inventati dal modello se assenti nel testo ufficiale", () => {
    expect(
      attestExtractedAllegati(
        [
          { nome: "Allegato Z — Piano industriale.xlsx", obbligatorio: true },
          { nome: "Modulo di domanda", obbligatorio: false },
        ],
        NAMED_MD,
        OFFICIAL,
        DOMAIN,
      ).map((item) => item.nome),
    ).toEqual(["Modulo di domanda"]);
  });

  it("non marca obbligatorio se il testo non lo attesta", () => {
    const got = attestExtractedAllegati(
      [{ nome: "Allegato B — Dichiarazione sostitutiva di atto di notorietà", obbligatorio: true }],
      NAMED_MD,
      OFFICIAL,
      DOMAIN,
    );
    expect(got[0]?.obbligatorio).toBe(false);
  });
});

describe("bozza locale e persist wiring", () => {
  it("la bozza porta allegati solo se dichiarati", () => {
    const withLists = localOpportunityDraft({
      markdown: NAMED_MD,
      officialUrl: OFFICIAL,
      officialDomain: DOMAIN,
    });
    expect(withLists?.allegati).toHaveLength(3);
    const without = localOpportunityDraft({
      markdown: NO_ALLEGATI,
      officialUrl: OFFICIAL,
      officialDomain: DOMAIN,
    });
    expect(without?.allegati).toEqual([]);
  });

  it("collect/backfill persistono extractOfficialAllegati, non inventano", () => {
    expect(ENGINE).toContain("extractOfficialAllegati");
    expect(ENGINE).toContain("extracted: extracted.allegati");
    expect(ENGINE).toContain("if (allegati.length) patch.allegati = allegati");
    expect(ENGINE).toContain("allegati[{nome, url?, obbligatorio}]");
    expect(MIGRATION).toContain("trovabandi_opportunities");
    expect(MIGRATION).toContain("allegati jsonb");
    expect(MIGRATION).toContain("jsonb_typeof(allegati) = 'array'");
    expect(MIGRATION).not.toMatch(/civiko_/i);
  });
});
