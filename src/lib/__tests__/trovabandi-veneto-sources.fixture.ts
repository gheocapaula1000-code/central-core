/**
 * Completamento Veneto-only delle fonti TrovaBandi (province ancora
 * senza official_domain in catalogo). Listing verificate il 22 Aug 2026.
 * Nessun Comune, nessun BUR FVG, nessun Centro-Sud.
 */
export type VenetoSourceStatus = "added" | "already_present";

export type VenetoProvinceCode = "PD" | "VR" | "VI" | "TV" | "VE" | "RO" | "BL";

export type VenetoSourceFixture = {
  province: VenetoProvinceCode;
  official_domain: string;
  listing: string;
  status: VenetoSourceStatus;
  kind: "CCIAA" | "PROVINCIA" | "CM" | "GAL" | "ALBO" | "UNIONCAMERE";
};

/** Nuove righe di questa PR: official_domain assente dal catalogo main. */
export const TROVABANDI_VENETO_ADDED: VenetoSourceFixture[] = [
  {
    province: "VI",
    official_domain: "provincia.vicenza.it",
    listing:
      "https://www2.provincia.vicenza.it/ente/amministrazione-trasparente/Sovvenzioni,%20contributi,%20sussidi,%20vantaggi%20economici",
    status: "added",
    kind: "PROVINCIA",
  },
  {
    province: "VR",
    official_domain: "web.provincia.vr.it",
    listing: "https://web.provincia.vr.it/it/servizi/contributi-e-patrocini",
    status: "added",
    kind: "PROVINCIA",
  },
];

/**
 * Domini veneti già in trovabandi_sources (non duplicati).
 * CCIAA accorpate restano sul host Unioncamere (TV+BL, VE+RO).
 */
export const TROVABANDI_VENETO_ALREADY_PRESENT: VenetoSourceFixture[] = [
  {
    province: "PD",
    official_domain: "pd.camcom.it",
    listing: "https://www.pd.camcom.it/it/incentivi-imprese",
    status: "already_present",
    kind: "CCIAA",
  },
  {
    province: "PD",
    official_domain: "provincia.pd.it",
    listing:
      "https://www.provincia.pd.it/sovvenzioni-contributi-sussidi-vantaggi-economici",
    status: "already_present",
    kind: "PROVINCIA",
  },
  {
    province: "PD",
    official_domain: "padovanet.it",
    listing: "https://www.padovanet.it",
    status: "already_present",
    kind: "ALBO",
  },
  {
    province: "PD",
    official_domain: "galpatavino.it",
    listing: "https://www.galpatavino.it",
    status: "already_present",
    kind: "GAL",
  },
  {
    province: "VR",
    official_domain: "vr.camcom.it",
    listing:
      "https://www.vr.camcom.it/promuovere-impresa-e-territorio/contributi-e-patrocini",
    status: "already_present",
    kind: "CCIAA",
  },
  {
    province: "VR",
    official_domain: "baldolessinia.it",
    listing: "https://www.baldolessinia.it/bandi/",
    status: "already_present",
    kind: "GAL",
  },
  {
    province: "VI",
    official_domain: "vi.camcom.it",
    listing: "https://www.vi.camcom.it/it/bandi-contributivi-e-bandi-di-gara/",
    status: "already_present",
    kind: "CCIAA",
  },
  {
    province: "VI",
    official_domain: "montagnavicentina.com",
    listing: "https://www.montagnavicentina.com/category/bandi/",
    status: "already_present",
    kind: "GAL",
  },
  {
    province: "TV",
    official_domain: "tb.camcom.gov.it",
    listing: "https://www.tb.camcom.gov.it/bandi.asp",
    status: "already_present",
    kind: "CCIAA",
  },
  {
    province: "TV",
    official_domain: "amministrazionetrasparente.provincia.treviso.it",
    listing:
      "https://amministrazionetrasparente.provincia.treviso.it/L190/?idSezione=20&sort=&activePage=&search=&cf4=true&id=273275",
    status: "already_present",
    kind: "PROVINCIA",
  },
  {
    province: "TV",
    official_domain: "galaltamarca.tv.it",
    listing: "https://galaltamarca.tv.it/cronoprogramma-annuale/",
    status: "already_present",
    kind: "GAL",
  },
  {
    province: "VE",
    official_domain: "dl.camcom.it",
    listing:
      "https://www.dl.camcom.it/sonoimpresa/cosa-puo-servire-sono/incentivi-ed-agevolazioni",
    status: "already_present",
    kind: "CCIAA",
  },
  {
    province: "VE",
    official_domain: "cittametropolitana.ve.it",
    listing:
      "https://www.cittametropolitana.ve.it/amministrazione-trasparente/sovvenzioni-contributi-sussidi-vantaggi-economici",
    status: "already_present",
    kind: "CM",
  },
  {
    province: "VE",
    official_domain: "vegal.net",
    listing: "https://www.vegal.net/attivita/psl-2023-2027/",
    status: "already_present",
    kind: "GAL",
  },
  {
    province: "RO",
    official_domain: "galdeltapo.it",
    listing: "https://galdeltapo.it/bandi/",
    status: "already_present",
    kind: "GAL",
  },
  {
    province: "RO",
    official_domain: "galadige.it",
    listing: "https://www.galadige.it/bandi/",
    status: "already_present",
    kind: "GAL",
  },
  {
    province: "BL",
    official_domain: "galaltobellunese.com",
    listing: "https://www.galaltobellunese.com/bandi/",
    status: "already_present",
    kind: "GAL",
  },
  {
    province: "BL",
    official_domain: "galprealpidolomiti.it",
    listing: "https://www.galprealpidolomiti.it/bandi/",
    status: "already_present",
    kind: "GAL",
  },
];

/** Province che dopo questa PR hanno una pagina provincia/CM. */
export const VENETO_PROVINCES_WITH_PROVINCIA_OR_CM: VenetoProvinceCode[] = [
  "PD",
  "VR",
  "VI",
  "TV",
  "VE",
];

/** Province che restano senza pagina provincia/CM (GAL-only a livello locale). */
export const VENETO_PROVINCES_STILL_WITHOUT_PROVINCIA_PAGE: VenetoProvinceCode[] =
  ["RO", "BL"];
