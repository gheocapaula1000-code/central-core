/**
 * Nuove fonti TrovaBandi (Centro-Sud + nazionali Bandiora mancanti).
 * Ogni coppia official_domain + listing è stata verificata live il 22 Aug 2026.
 * Nessun dominio inventato: CCIAA da Unioncamere, GAL da PSR Campania Comunica,
 * provincia/CM da Wikidata P856 + pagina sovvenzioni/bandi HTTP 200.
 */
export type ItalySourceKind = "CCIAA" | "BUR" | "PROVINCIA" | "GAL" | "NAZIONALE";

export type ItalySourceFixture = {
  kind: ItalySourceKind;
  official_domain: string;
  listing: string;
};

export const TROVABANDI_ITALY_NEW_SOURCES: ItalySourceFixture[] = [
  // CCIAA — 29
  {
    kind: "CCIAA",
    official_domain: "ag.camcom.it",
    listing: "https://www.ag.camcom.it/servizio/promozione/",
  },
  {
    kind: "CCIAA",
    official_domain: "ba.camcom.it",
    listing: "https://www.ba.camcom.it/info/bandi",
  },
  {
    kind: "CCIAA",
    official_domain: "basilicata.camcom.it",
    listing: "https://www.basilicata.camcom.it/avvisi-bandi",
  },
  {
    kind: "CCIAA",
    official_domain: "brta.camcom.it",
    listing: "https://www.brta.camcom.it/bandi",
  },
  {
    kind: "CCIAA",
    official_domain: "caor.camcom.it",
    listing: "https://www.caor.camcom.it/bandi",
  },
  {
    kind: "CCIAA",
    official_domain: "cameracommercio.cl.it",
    listing:
      "https://www.cameracommercio.cl.it/amministrazione-trasparente-main/bandi-in-corso/bandi-in-corso/",
  },
  {
    kind: "CCIAA",
    official_domain: "ce.camcom.it",
    listing: "https://www.ce.camcom.it/bandi-incentivi",
  },
  {
    kind: "CCIAA",
    official_domain: "czkrvv.camcom.it",
    listing: "https://czkrvv.camcom.it/category/bandi/",
  },
  {
    kind: "CCIAA",
    official_domain: "chpe.camcom.it",
    listing: "https://www.chpe.camcom.it/pagina189754_bandi.html",
  },
  {
    kind: "CCIAA",
    official_domain: "cs.camcom.gov.it",
    listing:
      "https://www.cs.camcom.gov.it/it/content/service/avvisi-e-bandi-della-camera",
  },
  {
    kind: "CCIAA",
    official_domain: "fg.camcom.it",
    listing:
      "https://www.fg.camcom.it/bandi-contributi/bandi-sostegno-imprese",
  },
  {
    kind: "CCIAA",
    official_domain: "frlt.camcom.it",
    listing: "https://www.frlt.camcom.it/bandi",
  },
  {
    kind: "CCIAA",
    official_domain: "cameragransasso.camcom.it",
    listing:
      "https://www.cameragransasso.camcom.it/it/la-camera/promozione-economica/bandi/",
  },
  {
    kind: "CCIAA",
    official_domain: "irpiniasannio.camcom.it",
    listing: "https://www.irpiniasannio.camcom.it/bandi-di-contributi",
  },
  {
    kind: "CCIAA",
    official_domain: "le.camcom.it",
    listing:
      "https://www.le.camcom.it/promozione-e-sviluppo-del-territorio/bandi-e-contributi",
  },
  {
    kind: "CCIAA",
    official_domain: "marche.camcom.it",
    listing:
      "https://www.marche.camcom.it/strumenti-e-servizi/bandi-e-contributi",
  },
  {
    kind: "CCIAA",
    official_domain: "me.camcom.it",
    listing: "https://www.me.camcom.it/bandi",
  },
  {
    kind: "CCIAA",
    official_domain: "molise.camcom.gov.it",
    listing:
      "https://www.molise.camcom.gov.it/promuovi-la-tua-impresa-e-il-tuo-territorio/bandi-il-sostegno-alle-imprese",
  },
  {
    kind: "CCIAA",
    official_domain: "na.camcom.gov.it",
    listing: "https://www.na.camcom.gov.it/bandi",
  },
  {
    kind: "CCIAA",
    official_domain: "nu.camcom.it",
    listing: "https://nu.camcom.it/it/camera/bandi/",
  },
  {
    kind: "CCIAA",
    official_domain: "paen.camcom.gov.it",
    listing: "https://www.paen.camcom.gov.it/it/bandi",
  },
  {
    kind: "CCIAA",
    official_domain: "rc.camcom.gov.it",
    listing:
      "https://www.rc.camcom.gov.it/internazionalizzazione/bandi-e-iniziative-linternazionalizzazione",
  },
  {
    kind: "CCIAA",
    official_domain: "rivt.camcom.it",
    listing:
      "https://www.rivt.camcom.it/it/attivita_34/supporto-alle-imprese_433/",
  },
  {
    kind: "CCIAA",
    official_domain: "rm.camcom.it",
    listing:
      "https://www.rm.camcom.it/pagina82_avvisi-pubblici-bandi-per-contributi-e-attivit-promozionali-altre-opportunit.html",
  },
  {
    kind: "CCIAA",
    official_domain: "sa.camcom.it",
    listing: "https://www.sa.camcom.it/bandi",
  },
  {
    kind: "CCIAA",
    official_domain: "ss.camcom.it",
    listing: "https://www.ss.camcom.it/bandi",
  },
  {
    kind: "CCIAA",
    official_domain: "ctrgsr.camcom.gov.it",
    listing:
      "https://ctrgsr.camcom.gov.it/it/blog/bando-voucher-doppia-transizione-2026",
  },
  {
    kind: "CCIAA",
    official_domain: "tp.camcom.it",
    listing: "https://www.tp.camcom.it/bandi",
  },
  {
    kind: "CCIAA",
    official_domain: "umbria.camcom.it",
    listing:
      "https://www.umbria.camcom.it/promuovere-limpresa-e-il-territorio/bandi-e-contributi",
  },

  // BUR — 8
  {
    kind: "BUR",
    official_domain: "regione.lazio.it",
    listing: "https://www.regione.lazio.it/bur",
  },
  {
    kind: "BUR",
    official_domain: "bur.regione.marche.it",
    listing: "https://bur.regione.marche.it/",
  },
  {
    kind: "BUR",
    official_domain: "bur.regione.umbria.it",
    listing: "https://bur.regione.umbria.it/",
  },
  {
    kind: "BUR",
    official_domain: "bura.regione.abruzzo.it",
    listing: "https://bura.regione.abruzzo.it/",
  },
  {
    kind: "BUR",
    official_domain: "burc.regione.campania.it",
    listing: "https://burc.regione.campania.it/",
  },
  {
    kind: "BUR",
    official_domain: "burp.regione.puglia.it",
    listing: "https://burp.regione.puglia.it/",
  },
  {
    kind: "BUR",
    official_domain: "regione.basilicata.it",
    listing:
      "https://www.regione.basilicata.it/?servizi-online=bur-bollettino-ufficiale-della-regione-basilicata",
  },
  {
    kind: "BUR",
    official_domain: "buras.regione.sardegna.it",
    listing: "https://buras.regione.sardegna.it/",
  },

  // Provincia / CM — 5
  {
    kind: "PROVINCIA",
    official_domain: "provincia.perugia.it",
    listing:
      "https://www.provincia.perugia.it/amministrazione-trasparente/sovvenzioni-contributi-sussidi-vantaggi-economici",
  },
  {
    kind: "PROVINCIA",
    official_domain: "provincia.benevento.it",
    listing:
      "https://www.provincia.benevento.it/amministrazione-trasparente/sovvenzioni-contributi-sussidi-vantaggi-economici",
  },
  {
    kind: "PROVINCIA",
    official_domain: "provincia.fermo.it",
    listing:
      "https://www.provincia.fermo.it/amministrazione-trasparente/sovvenzioni-contributi-sussidi-vantaggi-economici",
  },
  {
    kind: "PROVINCIA",
    official_domain: "casadivetro.provincia.pu.it",
    listing:
      "https://casadivetro.provincia.pu.it/L190/?idSezione=20&id=&sort=&activePage=&search=",
  },
  {
    kind: "PROVINCIA",
    official_domain: "cittametropolitanacagliari.it",
    listing:
      "https://cittametropolitanacagliari.it/portale/page/it/bandi_avvisi",
  },

  // GAL — 6
  {
    kind: "GAL",
    official_domain: "galcasacastra.it",
    listing: "https://www.galcasacastra.it/bandi/",
  },
  {
    kind: "GAL",
    official_domain: "galcilento.it",
    listing: "https://www.galcilento.it/category/bandi/",
  },
  {
    kind: "GAL",
    official_domain: "sentieridelbuonvivere.it",
    listing: "https://www.sentieridelbuonvivere.it/bandi/",
  },
  {
    kind: "GAL",
    official_domain: "galpartenio.it",
    listing: "https://galpartenio.it/bandi/",
  },
  {
    kind: "GAL",
    official_domain: "galterraevita.eu",
    listing: "https://www.galterraevita.eu/bandi-aperti/",
  },
  {
    kind: "GAL",
    official_domain: "galvesuvioverde.it",
    listing: "https://www.galvesuvioverde.it/bandi/",
  },

  // Nazionale — 5 (SACE omesso: Cloudflare, nessuna listing verificata)
  {
    kind: "NAZIONALE",
    official_domain: "inail.it",
    listing:
      "https://www.inail.it/portale/prevenzione-e-sicurezza/it/prevenzione-e-sicurezza/finanziamenti-per-la-sicurezza/incentivi-alle-imprese.html",
  },
  {
    kind: "NAZIONALE",
    official_domain: "ice.it",
    listing: "https://www.ice.it/it/finanziamenti-internazionali",
  },
  {
    kind: "NAZIONALE",
    official_domain: "fondimpresa.it",
    listing:
      "https://www.fondimpresa.it/i-canali-di-finanziamento/conto-di-sistema",
  },
  {
    kind: "NAZIONALE",
    official_domain: "simest.it",
    listing: "https://www.simest.it/per-le-imprese/finanziamenti-agevolati",
  },
  {
    kind: "NAZIONALE",
    official_domain: "gse.it",
    listing: "https://www.gse.it/servizi-per-te/fonti-rinnovabili/ferx/bandi",
  },
];

export const TROVABANDI_ITALY_NEW_COUNTS = {
  CCIAA: 29,
  BUR: 8,
  PROVINCIA: 5,
  GAL: 6,
  NAZIONALE: 5,
} as const;
