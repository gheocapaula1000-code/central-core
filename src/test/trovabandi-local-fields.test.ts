import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  localExtractApplicationUrl,
  localExtractAteco,
  localExtractEligibleExpenses,
  localExtractProtocolEmail,
  localExtractRequirements,
  localGuessCategory,
  localOpportunityDraft,
  looksLikeOpportunity,
} from "../../supabase/functions/trovabandi-engine/local-fields.ts";

const ENGINE = readFileSync(
  "supabase/functions/trovabandi-engine/index.ts",
  "utf8",
);

const BANDO = `
Avviso pubblico — bando contributi a fondo perduto per le PMI.
Le domande devono essere presentate entro il 30 settembre 2026.
Codice ATECO ammesso 62.01 e 63.11.
PEC di protocollo: protocollo@regione.veneto.it
Presentazione domanda: https://www.regione.veneto.it/sportello-domanda
Dotazione 2 milioni di euro.
`.repeat(2);

/**
 * Campioni in-repo per il conteggio PR: wording ufficiale (live excerpt)
 * vs fixture sintetica. Nessun recrawl.
 */
export const IN_REPO_ATECO_NOTICE_SAMPLES: Array<{
  id: string;
  officialWording: boolean;
  text: string;
  expect: string[];
}> = [
  {
    id: "fixture-codice-ateco-62-63",
    officialWording: false,
    text: BANDO,
    expect: ["62", "63"],
  },
  {
    id: "fixture-ateco-62-bare",
    officialWording: false,
    text: "Avviso pubblico per contributi. Settori ammessi: ATECO 62. Documentazione ufficiale. "
      .repeat(2),
    expect: ["62"],
  },
  {
    id: "fixture-ateco-62-10",
    officialWording: false,
    text: "Avviso pubblico. Codice ATECO 62.10 ammissibile per le imprese software. "
      .repeat(2),
    expect: ["62"],
  },
  {
    id: "live-abruzzo-audiovisivo-59-11",
    officialWording: true,
    text: "attività di produzione cinematografica, di video e di programmi televisivi (codici ATECO 2025 J 59.11, o equivalenti europei). Le imprese inoltre devono essere produttori unici o coproduttori.",
    expect: ["59"],
  },
  {
    id: "live-torino-turismo-55-56-79",
    officialWording: true,
    text: "Le aziende con codici ATECO 55-Ricettività, 56-Ristorazione compresi gli agriturismi e 79-Agenzie di Viaggio, Tour Operator e Guide turistiche possono accreditarsi gratuitamente.",
    expect: ["55", "56", "79"],
  },
  {
    id: "live-liguria-allegato-ateco-2007",
    officialWording: true,
    text: "delle imprese, che esercitano un’attività economica di cui alla classificazione ATECO 2007, tra quelle indicate come ammesse nell’Allegato 2 al presente bando. Ai fini della definizione di impresa si applica il regolamento.",
    expect: [],
  },
  {
    id: "live-umbria-sezioni-lettera",
    officialWording: true,
    text: "sede operativa nel territorio regionale e con codice principale di attività ATECO 2007 riferito ai settori di seguito specificati: C ATTIVITA’ MANIFATTURIERE F COSTRUZIONI G COMMERCIO ALL’INGROSSO.",
    expect: [],
  },
  {
    id: "digitalizzazione-pmi-no-code",
    officialWording: false,
    text: "Bando per la digitalizzazione delle PMI e l'innovazione digitale. Voucher per transizione digitale. "
      .repeat(3),
    expect: [],
  },
  {
    id: "empty-text",
    officialWording: false,
    text: "",
    expect: [],
  },
  {
    id: "decreto-not-ateco",
    officialWording: false,
    text: "Decreto n. 62.01 del 2026 approva il bando per le imprese.",
    expect: [],
  },
];

describe("local field extractors", () => {
  it("estrae ATECO solo con keyword esplicita", () => {
    expect(localExtractAteco(BANDO)).toEqual(["62", "63"]);
    expect(localExtractAteco("Decreto n. 62.01 del 2026")).toEqual([]);
  });

  it("mantiene 62.10 e ATECO 62 attestati", () => {
    expect(
      localExtractAteco(
        "Avviso pubblico. Codice ATECO 62.10 ammissibile per le imprese software. "
          .repeat(2),
      ),
    ).toEqual(["62"]);
    expect(
      localExtractAteco(
        "Avviso pubblico per contributi. Settori ammessi: ATECO 62. Documentazione ufficiale. "
          .repeat(2),
      ),
    ).toEqual(["62"]);
    expect(
      localExtractAteco(
        "Avviso pubblico. ATECO 62. Scadenza 30 settembre 2026. Documentazione ufficiale.",
      ),
    ).toEqual(["62"]);
  });

  it("non etichetta 62 da digitalizzazione / innovazione / PMI senza codice", () => {
    expect(
      localExtractAteco(
        "Bando per la digitalizzazione delle PMI e l'innovazione digitale. Voucher per transizione digitale. "
          .repeat(3),
      ),
    ).toEqual([]);
  });

  it("testo vuoto o troppo corto resta senza prefissi", () => {
    expect(localExtractAteco("")).toEqual([]);
    expect(localExtractAteco("   ")).toEqual([]);
    expect(localExtractAteco("ATECO 62")).toEqual([]);
  });

  it("non prende l'anno di edizione ATECO 2007/2025 come prefisso 20", () => {
    expect(
      localExtractAteco(
        "classificazione ATECO 2007, tra quelle indicate come ammesse nell’Allegato 2 al presente bando. Regolamento PMI.",
      ),
    ).toEqual([]);
    expect(
      localExtractAteco(
        "codici ATECO 2025 J 59.11, o equivalenti europei, per la produzione audiovisiva.",
      ),
    ).toEqual(["59"]);
  });

  it("estrae altri prefissi attestati, non solo 62", () => {
    expect(
      localExtractAteco(
        "Le aziende con codici ATECO 55-Ricettività, 56-Ristorazione e 79-Agenzie di Viaggio possono accreditarsi.",
      ),
    ).toEqual(["55", "56", "79"]);
  });

  it("i campioni in-repo coincidono con il conteggio dichiarato in PR", () => {
    const results = IN_REPO_ATECO_NOTICE_SAMPLES.map((sample) => ({
      id: sample.id,
      officialWording: sample.officialWording,
      got: localExtractAteco(sample.text),
      expect: sample.expect,
    }));
    for (const row of results) {
      expect(row.got, row.id).toEqual(row.expect);
    }
    const gain = results.filter((row) => row.got.length > 0);
    const stayEmpty = results.filter((row) => row.got.length === 0);
    const official62 = results.filter(
      (row) => row.officialWording && row.got.includes("62"),
    );
    expect(gain).toHaveLength(5);
    expect(stayEmpty).toHaveLength(5);
    expect(official62).toHaveLength(0);
  });

  it("estrae PEC/protocollo e URL domanda sullo stesso dominio", () => {
    expect(localExtractProtocolEmail(BANDO)).toBe(
      "protocollo@regione.veneto.it",
    );
    expect(
      localExtractApplicationUrl(BANDO, "regione.veneto.it"),
    ).toBe("https://www.regione.veneto.it/sportello-domanda");
    expect(localExtractApplicationUrl(BANDO, "invitalia.it")).toBeNull();
    expect(localExtractProtocolEmail("contatti: info@regione.veneto.it")).toBeNull();
  });

  it("riconosce un bando e resta fail-closed su homepage generiche", () => {
    expect(looksLikeOpportunity(BANDO)).toBe(true);
    expect(looksLikeOpportunity("Chi siamo. Cookie. Privacy.")).toBe(false);
    expect(localGuessCategory(BANDO)).toBe("FONDO_PERDUTO");
  });

  it("la bozza locale non inventa forme/dimensioni e non marca COMPATIBILE", () => {
    const draft = localOpportunityDraft({
      markdown: BANDO,
      officialUrl: "https://www.regione.veneto.it/bando",
      officialDomain: "regione.veneto.it",
      deadline: "2026-09-30T00:00:00.000Z",
      max_grant_amount: 2000000,
    });
    expect(draft).toMatchObject({
      is_opportunity: true,
      official_url: "https://www.regione.veneto.it/bando",
      eligible_legal_forms: [],
      eligible_company_sizes: [],
    });
    expect(draft?.eligible_ateco_prefixes).toEqual(["62", "63"]);
    expect(JSON.stringify(draft)).not.toMatch(/COMPATIBILE/);
    expect(
      localOpportunityDraft({
        markdown: "Homepage istituzionale",
        officialUrl: "https://www.regione.veneto.it",
        officialDomain: "regione.veneto.it",
      }),
    ).toBeNull();
  });
});

describe("collect/backfill ATECO wiring", () => {
  it("persist e backfill usano solo l'estrattore locale fail-closed", () => {
    expect(ENGINE).toContain("eligible_ateco_prefixes: localExtractAteco(proofText)");
    expect(ENGINE).toContain("eligible_ateco_prefixes.eq.{}");
    expect(ENGINE).toContain("const ateco = localExtractAteco(page.markdown)");
    expect(ENGINE).not.toContain(
      "eligible_ateco_prefixes: safeTextArray(extracted.eligible_ateco_prefixes)",
    );
  });
});


const DEPTH = `
Avviso pubblico — bando contributi a fondo perduto.

Requisiti di ammissione:
- PMI con sede operativa in Veneto da almeno 12 mesi
- Iscrizione al Registro Imprese e DURC regolare
- Non essere impresa in difficoltà ai sensi della normativa UE

Spese ammissibili:
- Acquisto di macchinari e attrezzature nuove
- Software gestionale e servizi di digitalizzazione
- Consulenze specialistiche strettamente connesse al progetto

Spese non ammissibili:
- Costi di personale interno
`.repeat(2);

describe("UEradar — requisiti e spese dal testo ufficiale", () => {
  it("estrae elenchi sotto intestazione e ignora le spese non ammissibili", () => {
    expect(localExtractRequirements(DEPTH)).toEqual([
      "PMI con sede operativa in Veneto da almeno 12 mesi",
      "Iscrizione al Registro Imprese e DURC regolare",
      "Non essere impresa in difficoltà ai sensi della normativa UE",
    ]);
    expect(localExtractEligibleExpenses(DEPTH)).toEqual([
      "Acquisto di macchinari e attrezzature nuove",
      "Software gestionale e servizi di digitalizzazione",
      "Consulenze specialistiche strettamente connesse al progetto",
    ]);
    expect(localExtractEligibleExpenses(DEPTH).join(" ")).not.toMatch(/personale interno/);
  });

  it("resta vuoto se manca l'elenco ufficiale", () => {
    expect(localExtractRequirements(BANDO)).toEqual([]);
    expect(localExtractEligibleExpenses(BANDO)).toEqual([]);
    expect(localExtractRequirements("Homepage. Cookie. Privacy.")).toEqual([]);
  });

  it("la bozza locale porta i campi solo se dichiarati a elenco", () => {
    const withLists = localOpportunityDraft({
      markdown: DEPTH,
      officialUrl: "https://www.regione.veneto.it/bando-profondita",
      officialDomain: "regione.veneto.it",
    });
    expect(withLists?.requirements).toHaveLength(3);
    expect(withLists?.eligible_expenses).toHaveLength(3);
    const without = localOpportunityDraft({
      markdown: BANDO,
      officialUrl: "https://www.regione.veneto.it/bando",
      officialDomain: "regione.veneto.it",
    });
    expect(without?.requirements).toEqual([]);
    expect(without?.eligible_expenses).toEqual([]);
  });
});

describe("collect/backfill requirements wiring", () => {
  it("persist e backfill usano gli estrattori locali fail-closed", () => {
    expect(ENGINE).toContain("localExtractRequirements(proofText)");
    expect(ENGINE).toContain("localExtractEligibleExpenses(proofText)");
    expect(ENGINE).toContain("const req = localExtractRequirements(page.markdown)");
    expect(ENGINE).toContain("const exp = localExtractEligibleExpenses(page.markdown)");
  });
});
