// TrovaBandi — geo fail-closed (regione / provincia / comune).
//
// Perché molte righe REGIONALE/CAMERALE/COMUNALE hanno geo null:
//   - localOpportunityDraft non estraeva region/province/municipality;
//   - il prompt Perplexity vieta di dedurre, quindi extracted.region resta vuoto;
//   - persist cadeva su source.region/province (municipality mai);
//   - backfill_nulls non selezionava né patchava i campi geo.
// UERADAR sedeOk è fail-closed: REGIONALE senza b.regione → escluso, anche
// se l'avviso è del BUR Veneto. Qui si riempie solo con evidenza ufficiale
// (testo / host territoriale / seed della fonte). Mai ATECO, mai invenzione.
// Se due evidenze attendibili discordano, il campo resta null.

export type OpportunityGeo = {
  region: string | null;
  province: string | null;
  municipality: string | null;
};

export type GeoSourceHint = {
  official_domain?: string | null;
  region?: string | null;
  province?: string | null;
  authority_level?: string | null;
  name?: string | null;
};

const EMPTY_GEO: OpportunityGeo = {
  region: null,
  province: null,
  municipality: null,
};

const TERRITORIAL_LEVELS = new Set(["REGIONALE", "CAMERALE", "COMUNALE"]);

type RegionEntry = { canonical: string; aliases: string[]; slug: string };

const REGIONS: RegionEntry[] = [
  { canonical: "Abruzzo", aliases: [], slug: "abruzzo" },
  { canonical: "Basilicata", aliases: [], slug: "basilicata" },
  { canonical: "Calabria", aliases: [], slug: "calabria" },
  { canonical: "Campania", aliases: [], slug: "campania" },
  {
    canonical: "Emilia-Romagna",
    aliases: ["Emilia Romagna", "EmiliaRomagna"],
    slug: "emilia-romagna",
  },
  {
    canonical: "Friuli-Venezia Giulia",
    aliases: ["Friuli Venezia Giulia", "FVG", "Friuli"],
    slug: "fvg",
  },
  { canonical: "Lazio", aliases: [], slug: "lazio" },
  { canonical: "Liguria", aliases: [], slug: "liguria" },
  { canonical: "Lombardia", aliases: [], slug: "lombardia" },
  { canonical: "Marche", aliases: [], slug: "marche" },
  { canonical: "Molise", aliases: [], slug: "molise" },
  { canonical: "Piemonte", aliases: [], slug: "piemonte" },
  { canonical: "Puglia", aliases: [], slug: "puglia" },
  { canonical: "Sardegna", aliases: [], slug: "sardegna" },
  { canonical: "Sicilia", aliases: [], slug: "sicilia" },
  { canonical: "Toscana", aliases: [], slug: "toscana" },
  {
    canonical: "Trentino-Alto Adige",
    aliases: ["Trentino Alto Adige", "Trentino-Südtirol", "Trentino Alto Adige"],
    slug: "trentino-alto-adige",
  },
  { canonical: "Umbria", aliases: [], slug: "umbria" },
  {
    canonical: "Valle d'Aosta",
    aliases: ["Valle dAosta", "Val d'Aosta", "Valle Daosta", "VdA"],
    slug: "vda",
  },
  { canonical: "Veneto", aliases: [], slug: "veneto" },
];

const REGION_SLUGS: Record<string, string> = {
  abruzzo: "Abruzzo",
  basilicata: "Basilicata",
  calabria: "Calabria",
  campania: "Campania",
  "emilia-romagna": "Emilia-Romagna",
  fvg: "Friuli-Venezia Giulia",
  "friuli-venezia-giulia": "Friuli-Venezia Giulia",
  lazio: "Lazio",
  liguria: "Liguria",
  lombardia: "Lombardia",
  marche: "Marche",
  molise: "Molise",
  piemonte: "Piemonte",
  puglia: "Puglia",
  sardegna: "Sardegna",
  sicilia: "Sicilia",
  toscana: "Toscana",
  "trentino-alto-adige": "Trentino-Alto Adige",
  umbria: "Umbria",
  vda: "Valle d'Aosta",
  "valle-daosta": "Valle d'Aosta",
  "valle-d-aosta": "Valle d'Aosta",
  veneto: "Veneto",
};

type ProvinceEntry = {
  sigla: string;
  name: string;
  region: string;
  aliases: string[];
};

const PROVINCES: ProvinceEntry[] = [
  { sigla: "AQ", name: "L'Aquila", region: "Abruzzo", aliases: ["Aquila"] },
  { sigla: "CH", name: "Chieti", region: "Abruzzo", aliases: [] },
  { sigla: "PE", name: "Pescara", region: "Abruzzo", aliases: [] },
  { sigla: "TE", name: "Teramo", region: "Abruzzo", aliases: [] },
  { sigla: "PZ", name: "Potenza", region: "Basilicata", aliases: [] },
  { sigla: "MT", name: "Matera", region: "Basilicata", aliases: [] },
  { sigla: "CZ", name: "Catanzaro", region: "Calabria", aliases: [] },
  { sigla: "CS", name: "Cosenza", region: "Calabria", aliases: [] },
  { sigla: "KR", name: "Crotone", region: "Calabria", aliases: [] },
  {
    sigla: "RC",
    name: "Reggio Calabria",
    region: "Calabria",
    aliases: ["Reggio di Calabria"],
  },
  { sigla: "VV", name: "Vibo Valentia", region: "Calabria", aliases: [] },
  { sigla: "AV", name: "Avellino", region: "Campania", aliases: [] },
  { sigla: "BN", name: "Benevento", region: "Campania", aliases: [] },
  { sigla: "CE", name: "Caserta", region: "Campania", aliases: [] },
  { sigla: "NA", name: "Napoli", region: "Campania", aliases: [] },
  { sigla: "SA", name: "Salerno", region: "Campania", aliases: [] },
  { sigla: "BO", name: "Bologna", region: "Emilia-Romagna", aliases: [] },
  { sigla: "FE", name: "Ferrara", region: "Emilia-Romagna", aliases: [] },
  {
    sigla: "FC",
    name: "Forlì-Cesena",
    region: "Emilia-Romagna",
    aliases: ["Forli-Cesena", "Forlì Cesena", "Forli Cesena"],
  },
  { sigla: "MO", name: "Modena", region: "Emilia-Romagna", aliases: [] },
  { sigla: "PR", name: "Parma", region: "Emilia-Romagna", aliases: [] },
  { sigla: "PC", name: "Piacenza", region: "Emilia-Romagna", aliases: [] },
  { sigla: "RA", name: "Ravenna", region: "Emilia-Romagna", aliases: [] },
  {
    sigla: "RE",
    name: "Reggio Emilia",
    region: "Emilia-Romagna",
    aliases: ["Reggio nell'Emilia", "Reggio nell Emilia"],
  },
  { sigla: "RN", name: "Rimini", region: "Emilia-Romagna", aliases: [] },
  { sigla: "GO", name: "Gorizia", region: "Friuli-Venezia Giulia", aliases: [] },
  { sigla: "PN", name: "Pordenone", region: "Friuli-Venezia Giulia", aliases: [] },
  { sigla: "TS", name: "Trieste", region: "Friuli-Venezia Giulia", aliases: [] },
  { sigla: "UD", name: "Udine", region: "Friuli-Venezia Giulia", aliases: [] },
  { sigla: "FR", name: "Frosinone", region: "Lazio", aliases: [] },
  { sigla: "LT", name: "Latina", region: "Lazio", aliases: [] },
  { sigla: "RI", name: "Rieti", region: "Lazio", aliases: [] },
  { sigla: "RM", name: "Roma", region: "Lazio", aliases: [] },
  { sigla: "VT", name: "Viterbo", region: "Lazio", aliases: [] },
  { sigla: "GE", name: "Genova", region: "Liguria", aliases: [] },
  { sigla: "IM", name: "Imperia", region: "Liguria", aliases: [] },
  { sigla: "SP", name: "La Spezia", region: "Liguria", aliases: ["Spezia"] },
  { sigla: "SV", name: "Savona", region: "Liguria", aliases: [] },
  { sigla: "BG", name: "Bergamo", region: "Lombardia", aliases: [] },
  { sigla: "BS", name: "Brescia", region: "Lombardia", aliases: [] },
  { sigla: "CO", name: "Como", region: "Lombardia", aliases: [] },
  { sigla: "CR", name: "Cremona", region: "Lombardia", aliases: [] },
  { sigla: "LC", name: "Lecco", region: "Lombardia", aliases: [] },
  { sigla: "LO", name: "Lodi", region: "Lombardia", aliases: [] },
  { sigla: "MN", name: "Mantova", region: "Lombardia", aliases: [] },
  { sigla: "MI", name: "Milano", region: "Lombardia", aliases: [] },
  {
    sigla: "MB",
    name: "Monza e della Brianza",
    region: "Lombardia",
    aliases: ["Monza", "Monza Brianza", "Monza e Brianza"],
  },
  { sigla: "PV", name: "Pavia", region: "Lombardia", aliases: [] },
  { sigla: "SO", name: "Sondrio", region: "Lombardia", aliases: [] },
  { sigla: "VA", name: "Varese", region: "Lombardia", aliases: [] },
  { sigla: "AN", name: "Ancona", region: "Marche", aliases: [] },
  { sigla: "AP", name: "Ascoli Piceno", region: "Marche", aliases: [] },
  { sigla: "FM", name: "Fermo", region: "Marche", aliases: [] },
  { sigla: "MC", name: "Macerata", region: "Marche", aliases: [] },
  {
    sigla: "PU",
    name: "Pesaro e Urbino",
    region: "Marche",
    aliases: ["Pesaro", "Pesaro Urbino"],
  },
  { sigla: "CB", name: "Campobasso", region: "Molise", aliases: [] },
  { sigla: "IS", name: "Isernia", region: "Molise", aliases: [] },
  { sigla: "AL", name: "Alessandria", region: "Piemonte", aliases: [] },
  { sigla: "AT", name: "Asti", region: "Piemonte", aliases: [] },
  { sigla: "BI", name: "Biella", region: "Piemonte", aliases: [] },
  { sigla: "CN", name: "Cuneo", region: "Piemonte", aliases: [] },
  { sigla: "NO", name: "Novara", region: "Piemonte", aliases: [] },
  { sigla: "TO", name: "Torino", region: "Piemonte", aliases: [] },
  {
    sigla: "VB",
    name: "Verbano-Cusio-Ossola",
    region: "Piemonte",
    aliases: ["Verbano Cusio Ossola"],
  },
  { sigla: "VC", name: "Vercelli", region: "Piemonte", aliases: [] },
  { sigla: "BA", name: "Bari", region: "Puglia", aliases: [] },
  {
    sigla: "BT",
    name: "Barletta-Andria-Trani",
    region: "Puglia",
    aliases: ["BAT", "Barletta Andria Trani"],
  },
  { sigla: "BR", name: "Brindisi", region: "Puglia", aliases: [] },
  { sigla: "FG", name: "Foggia", region: "Puglia", aliases: [] },
  { sigla: "LE", name: "Lecce", region: "Puglia", aliases: [] },
  { sigla: "TA", name: "Taranto", region: "Puglia", aliases: [] },
  { sigla: "CA", name: "Cagliari", region: "Sardegna", aliases: [] },
  { sigla: "NU", name: "Nuoro", region: "Sardegna", aliases: [] },
  { sigla: "OR", name: "Oristano", region: "Sardegna", aliases: [] },
  { sigla: "SS", name: "Sassari", region: "Sardegna", aliases: [] },
  { sigla: "SU", name: "Sud Sardegna", region: "Sardegna", aliases: [] },
  { sigla: "AG", name: "Agrigento", region: "Sicilia", aliases: [] },
  { sigla: "CL", name: "Caltanissetta", region: "Sicilia", aliases: [] },
  { sigla: "CT", name: "Catania", region: "Sicilia", aliases: [] },
  { sigla: "EN", name: "Enna", region: "Sicilia", aliases: [] },
  { sigla: "ME", name: "Messina", region: "Sicilia", aliases: [] },
  { sigla: "PA", name: "Palermo", region: "Sicilia", aliases: [] },
  { sigla: "RG", name: "Ragusa", region: "Sicilia", aliases: [] },
  { sigla: "SR", name: "Siracusa", region: "Sicilia", aliases: [] },
  { sigla: "TP", name: "Trapani", region: "Sicilia", aliases: [] },
  { sigla: "AR", name: "Arezzo", region: "Toscana", aliases: [] },
  { sigla: "FI", name: "Firenze", region: "Toscana", aliases: [] },
  { sigla: "GR", name: "Grosseto", region: "Toscana", aliases: [] },
  { sigla: "LI", name: "Livorno", region: "Toscana", aliases: [] },
  { sigla: "LU", name: "Lucca", region: "Toscana", aliases: [] },
  {
    sigla: "MS",
    name: "Massa-Carrara",
    region: "Toscana",
    aliases: ["Massa Carrara"],
  },
  { sigla: "PI", name: "Pisa", region: "Toscana", aliases: [] },
  { sigla: "PT", name: "Pistoia", region: "Toscana", aliases: [] },
  { sigla: "PO", name: "Prato", region: "Toscana", aliases: [] },
  { sigla: "SI", name: "Siena", region: "Toscana", aliases: [] },
  {
    sigla: "BZ",
    name: "Bolzano",
    region: "Trentino-Alto Adige",
    aliases: ["Bozen", "Bolzano/Bozen"],
  },
  { sigla: "TN", name: "Trento", region: "Trentino-Alto Adige", aliases: [] },
  { sigla: "PG", name: "Perugia", region: "Umbria", aliases: [] },
  { sigla: "TR", name: "Terni", region: "Umbria", aliases: [] },
  { sigla: "AO", name: "Aosta", region: "Valle d'Aosta", aliases: [] },
  { sigla: "BL", name: "Belluno", region: "Veneto", aliases: [] },
  { sigla: "PD", name: "Padova", region: "Veneto", aliases: ["Padua"] },
  { sigla: "RO", name: "Rovigo", region: "Veneto", aliases: [] },
  { sigla: "TV", name: "Treviso", region: "Veneto", aliases: [] },
  { sigla: "VE", name: "Venezia", region: "Veneto", aliases: [] },
  { sigla: "VR", name: "Verona", region: "Veneto", aliases: [] },
  { sigla: "VI", name: "Vicenza", region: "Veneto", aliases: [] },
];

const COMUNE_STOP = new Set([
  "residenza",
  "iscrizione",
  "appartenenza",
  "riferimento",
  "protocollo",
  "origine",
  "provenienza",
  "destinazione",
  "competenza",
  "seguito",
  "cui",
  "cui all",
  "seguito elencati",
  "riferimento all",
]);

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function unique(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) continue;
    const key = fold(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function pickField(
  fromUrl: string | null,
  fromSource: string | null,
  fromText: string[],
): string | null {
  const trusted = unique([fromUrl, fromSource]);
  if (trusted.length > 1) return null;
  if (trusted.length === 1) return trusted[0];
  const text = unique(fromText);
  return text.length === 1 ? text[0] : null;
}

export function canonicalizeRegion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const folded = fold(raw.replace(/^regione\s+/i, ""));
  if (!folded) return null;
  for (const region of REGIONS) {
    const names = [region.canonical, ...region.aliases, region.slug];
    if (names.some((name) => fold(name) === folded)) return region.canonical;
  }
  return null;
}

export function canonicalizeProvince(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const folded = fold(raw.replace(/^(?:provincia(?:\s+autonoma)?\s+di\s+)/i, ""));
  if (!folded) return null;
  if (/^[a-z]{2}$/i.test(raw.trim())) {
    const hit = PROVINCES.find((p) => p.sigla.toLowerCase() === raw.trim().toLowerCase());
    return hit?.name ?? null;
  }
  for (const province of PROVINCES) {
    const names = [province.name, province.sigla, ...province.aliases];
    if (names.some((name) => fold(name) === folded)) return province.name;
  }
  return null;
}

function provinceByName(name: string): ProvinceEntry | null {
  const canonical = canonicalizeProvince(name);
  if (!canonical) return null;
  return PROVINCES.find((p) => p.name === canonical) ?? null;
}

function regionOfProvince(name: string | null): string | null {
  if (!name) return null;
  return provinceByName(name)?.region ?? null;
}

function titleCaseSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function normalizeOfficialHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^www\d*\./, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

function hostOf(url: string): string {
  try {
    return normalizeOfficialHost(new URL(url).hostname);
  } catch {
    return "";
  }
}

const HOST_ALIASES: Record<string, OpportunityGeo> = {
  "padovanet.it": {
    region: "Veneto",
    province: "Padova",
    municipality: "Padova",
  },
  "burl.it": { region: "Liguria", province: null, municipality: null },
};

/**
 * Solo host istituzionali non ambigui. Nessun path su portali nazionali
 * (`incentivi.gov.it/veneto` non è evidenza).
 */
export function geoFromOfficialUrl(officialUrl: string): OpportunityGeo {
  const host = hostOf(officialUrl);
  if (!host) return { ...EMPTY_GEO };
  if (HOST_ALIASES[host]) return { ...HOST_ALIASES[host] };

  const regione = host.match(/(?:^|\.)regione\.([a-z0-9-]+)\.it$/);
  if (regione?.[1]) {
    const region = REGION_SLUGS[regione[1]] ?? null;
    if (region) return { region, province: null, municipality: null };
  }

  const camcom = host.match(/^([a-z]{2})\.camcom(?:\.gov)?\.it$/);
  if (camcom?.[1]) {
    const province = provinceByName(camcom[1].toUpperCase());
    if (province) {
      return {
        region: province.region,
        province: province.name,
        municipality: null,
      };
    }
  }

  const comune = host.match(/^comune\.([a-z0-9-]+)\.it$/);
  if (comune?.[1]) {
    const municipality = titleCaseSlug(comune[1]);
    const province = provinceByName(municipality);
    return {
      region: province?.region ?? null,
      province: province?.name ?? null,
      municipality,
    };
  }

  const provincia = host.match(/(?:^|\.)provincia\.([a-z0-9-]+)\.it$/);
  if (provincia?.[1]) {
    const token = provincia[1];
    const province = provinceByName(token.toUpperCase()) || provinceByName(titleCaseSlug(token));
    if (province) {
      return {
        region: province.region,
        province: province.name,
        municipality: null,
      };
    }
  }

  const metro = host.match(
    /(?:^|\.)(?:citta-?metropolitana|cittametropolitana)[.-]?([a-z0-9-]+)?\.it$/,
  );
  if (metro) {
    const token = metro[1] || host.split(".")[0];
    const province = provinceByName(token.toUpperCase()) || provinceByName(titleCaseSlug(token));
    if (province) {
      return {
        region: province.region,
        province: province.name,
        municipality: null,
      };
    }
  }

  return { ...EMPTY_GEO };
}

function hasQualifier(window: string, kind: "region" | "province"): boolean {
  if (kind === "region") {
    return /regione|giunta\s+regionale|territorio\s+regionale|bollettino\s+ufficiale|\bbur(?:l|ert|t)?\b|sede\s+(?:legale\s+|operativa\s+)?(?:in|nel|nella)|con\s+sede\s+in|imprese?\s+del(?:la)?/.test(
      window,
    );
  }
  return /provincia|camera\s+di\s+commercio|\bcciaa\b/.test(window);
}

function mentionsAround(text: string, names: string[], kind: "region" | "province"): boolean {
  const lower = text.toLowerCase();
  for (const name of names) {
    const needle = name.toLowerCase();
    if (!needle) continue;
    let from = 0;
    while (from < lower.length) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      const before = at === 0 ? " " : lower[at - 1];
      const afterCh = lower[at + needle.length] ?? " ";
      const isBoundary = (ch: string) => /[^a-zà-ÿ0-9]/i.test(ch);
      if (isBoundary(before) && isBoundary(afterCh)) {
        const window = lower.slice(Math.max(0, at - 70), at + needle.length + 24);
        if (hasQualifier(window, kind)) return true;
      }
      from = at + needle.length;
    }
  }
  return false;
}

export function geoFromOfficialText(markdown: string): OpportunityGeo {
  if (typeof markdown !== "string" || markdown.trim().length < 20) {
    return { ...EMPTY_GEO };
  }
  const regions: string[] = [];
  for (const region of REGIONS) {
    const names = [region.canonical, ...region.aliases];
    if (mentionsAround(markdown, names, "region")) regions.push(region.canonical);
  }
  const provinces: string[] = [];
  for (const province of PROVINCES) {
    const names = [province.name, ...province.aliases];
    if (mentionsAround(markdown, names, "province")) {
      provinces.push(province.name);
    }
  }

  const comuni: string[] = [];
  const comuneRx = /comune\s+di\s+([A-Za-zÀ-ÿ'’-]{2,}(?:\s+[A-Za-zÀ-ÿ'’-]+){0,4})/gi;
  const stopWord =
    /^(?:per|del|della|delle|dei|degli|di|con|che|alle|alla|agli|ai|e|ed|o|od|in|nel|nella|sul|sulla|a|ad)$/i;
  let match: RegExpExecArray | null;
  while ((match = comuneRx.exec(markdown))) {
    const tokens = match[1]
      .replace(/[.,;:]+$/, "")
      .trim()
      .split(/\s+/);
    const kept: string[] = [];
    for (const token of tokens) {
      if (kept.length && stopWord.test(token)) break;
      kept.push(token);
      if (kept.length >= 4) break;
    }
    const head = kept.join(" ").trim();
    const folded = fold(head);
    if (!head || COMUNE_STOP.has(folded) || head.length > 48) continue;
    const known = canonicalizeProvince(head);
    comuni.push(known ?? head.replace(/\s+/g, " "));
  }

  const region = unique(regions);
  const province = unique(provinces);
  const municipality = unique(comuni);

  let regionOut = region.length === 1 ? region[0] : null;
  let provinceOut = province.length === 1 ? province[0] : null;
  const municipalityOut = municipality.length === 1 ? municipality[0] : null;

  if (!provinceOut && municipalityOut) {
    const fromTown = provinceByName(municipalityOut);
    if (fromTown) provinceOut = fromTown.name;
  }
  if (!regionOut && provinceOut) {
    regionOut = regionOfProvince(provinceOut);
  } else if (!regionOut && municipalityOut) {
    regionOut = regionOfProvince(municipalityOut);
  }

  return {
    region: regionOut,
    province: provinceOut,
    municipality: municipalityOut,
  };
}

function geoFromSourceName(name: string): OpportunityGeo {
  const comune = name.match(/comune\s+di\s+([A-Za-zÀ-ÿ'’-]+(?:\s+[A-Za-zÀ-ÿ'’-]+){0,3})/i);
  if (!comune?.[1]) return { ...EMPTY_GEO };
  const municipality = comune[1].replace(/[.,;:]+$/, "").trim();
  const province = provinceByName(municipality);
  return {
    region: province?.region ?? null,
    province: province?.name ?? null,
    municipality: province?.name ?? municipality,
  };
}

export function geoFromTerritorialSource(source: GeoSourceHint | null | undefined): OpportunityGeo {
  if (!source) return { ...EMPTY_GEO };
  const level = String(source.authority_level ?? "")
    .trim()
    .toUpperCase();
  if (!TERRITORIAL_LEVELS.has(level)) return { ...EMPTY_GEO };
  const fromName = geoFromSourceName(source.name ?? "");
  const province = canonicalizeProvince(source.province) ?? fromName.province;
  return {
    region: canonicalizeRegion(source.region) ?? regionOfProvince(province) ?? fromName.region,
    province,
    municipality: fromName.municipality,
  };
}

export function matchTerritorialSource<T extends GeoSourceHint>(
  hostOrUrl: string,
  sources: T[],
): T | null {
  const host = hostOrUrl.includes("://") ? hostOf(hostOrUrl) : normalizeOfficialHost(hostOrUrl);
  if (!host) return null;
  const matches = sources.filter((source) => {
    const domain = normalizeOfficialHost(source.official_domain ?? "");
    return !!domain && (host === domain || host.endsWith(`.${domain}`));
  });
  if (!matches.length) return null;
  matches.sort(
    (a, b) =>
      normalizeOfficialHost(b.official_domain ?? "").length -
      normalizeOfficialHost(a.official_domain ?? "").length,
  );
  return matches[0];
}

/**
 * Unione fail-closed: host territoriale e seed della fonte (se
 * REGIONALE/CAMERALE/COMUNALE) sono attendibili; il testo riempie i buchi
 * e da solo vale solo se cita un unico ente. Conflitto url↔source → null.
 * ATECO e menzioni generiche senza qualificatore non contano.
 */
export function resolveOpportunityGeo(input: {
  markdown?: string | null;
  officialUrl?: string | null;
  source?: GeoSourceHint | null;
}): OpportunityGeo {
  const fromUrl = geoFromOfficialUrl(input.officialUrl ?? "");
  const fromSource = geoFromTerritorialSource(input.source);
  const fromText = geoFromOfficialText(input.markdown ?? "");
  const province = pickField(fromUrl.province, fromSource.province, [fromText.province]);
  const region = pickField(fromUrl.region, fromSource.region, [
    fromText.region,
    regionOfProvince(province),
  ]);
  const municipality = pickField(fromUrl.municipality, fromSource.municipality, [
    fromText.municipality,
  ]);
  return { region, province, municipality };
}
