// UEradar.com — pagine di partenza ufficiali (seed listing) e raccolta link.
//
// Modulo puro: nessuna rete. Contiene soltanto URL già verificati e la logica
// di estrazione link vincolata all'`official_domain` della fonte.
// Nessun path inventato, nessun dominio nuovo.

/** Pagine di partenza verificate, indicizzate per dominio ufficiale. */
export const SEED_LISTING_URLS: Record<string, string[]> = {
  "provincia.pd.it": [
    "https://www.provincia.pd.it/sovvenzioni-contributi-sussidi-vantaggi-economici",
  ],
  "provincia.padova.it": ["https://www.provincia.padova.it"],
  "padovanet.it": ["https://www.padovanet.it"],
  "pd.camcom.it": [
    "https://www.pd.camcom.it",
    "https://www.pd.camcom.it/it/incentivi-imprese",
    "https://www.pd.camcom.it/it/la-camera/bandi-in-corso",
  ],
  "vi.camcom.it": [
    "https://www.vi.camcom.it",
    "https://www.vi.camcom.it/it/bandi-contributivi-e-bandi-di-gara/",
  ],
  "dl.camcom.it": [
    "https://www.dl.camcom.it",
    "https://www.dl.camcom.it/sonoimpresa/cosa-puo-servire-sono/incentivi-ed-agevolazioni",
  ],
  "tb.camcom.gov.it": [
    "https://www.tb.camcom.gov.it",
    "https://www.tb.camcom.gov.it/bandi.asp",
  ],
  "ao.camcom.it": [
    "https://www.ao.camcom.it/it/far-crescere-l-impresa/bandi-contributi-agevolazioni",
  ],
  "aa.camcom.it": ["https://www.aa.camcom.it/bandi"],
  "cn.camcom.it": ["https://www.cn.camcom.it/focus/finanziamenti-contributi"],
  "pno.camcom.it": ["https://www.pno.camcom.it/bandi"],
  "to.camcom.it": ["https://www.to.camcom.it/finanziamenti-bandi-e-contributi"],
  "ge.camcom.gov.it": [
    "https://www.ge.camcom.gov.it/it/gestisci/finanziamenti-e-contributi-per-limpresa",
  ],
  "rivlig.camcom.gov.it": [
    "https://www.rivlig.camcom.gov.it/contributi-alle-imprese",
  ],
  "bg.camcom.it": ["https://www.bg.camcom.it/bandi"],
  "bs.camcom.it": ["https://www.bs.camcom.it/bandi-e-contributi"],
  "comolecco.camcom.it": [
    "https://www.comolecco.camcom.it/index.php?id_oggetto=27",
  ],
  "cmp.camcom.it": [
    "https://www.cmp.camcom.it/incentivi-alle-imprese/bandi-e-contributi",
  ],
  "milomb.camcom.it": [
    "https://www.milomb.camcom.it/",
    "https://www.milomb.camcom.it/home",
    "https://www.milomb.camcom.it/contributi-e-finanziamenti",
  ],
  "so.camcom.it": ["https://www.so.camcom.it/bandi"],
  "va.camcom.it": ["https://www.va.camcom.it/index.php?id_oggetto=39"],
  "vr.camcom.it": [
    "https://www.vr.camcom.it/promuovere-impresa-e-territorio/contributi-e-patrocini",
  ],
  "pnud.camcom.it": ["https://www.pnud.camcom.it/contributi-e-rendicontazione"],
  "vg.camcom.it": ["https://vg.camcom.it/contributi-e-agevolazioni"],
  "bo.camcom.gov.it": [
    "https://www.bo.camcom.gov.it/it/promozione-interna/contributi",
  ],
  "emilia.camcom.it": [
    "https://www.emilia.camcom.it/promuovere-limpresa-e-il-territorio/contributi-alle-imprese",
  ],
  "fera.camcom.it": ["https://www.fera.camcom.it/bandi"],
  "mo.camcom.it": ["https://www.mo.camcom.it/promozione/contributi-camerali"],
  "romagna.camcom.it": [
    "https://www.romagna.camcom.it/it/opportunita/finanziamenti-1",
  ],
  "as.camcom.it": ["https://www.as.camcom.it/bandi"],
  "fi.camcom.gov.it": ["https://www.fi.camcom.gov.it/bandi"],
  "lg.camcom.it": ["https://www.lg.camcom.it/bandi-contributi-alle-imprese"],
  "ptpo.camcom.it": ["https://www.ptpo.camcom.it/servizi/contributi/index"],
  "tno.camcom.it": ["https://tno.camcom.it/contributi-e-agevolazioni"],
  "tn.camcom.it": [
    "https://www.tn.camcom.it/bandi-di-gara-e-concorsi/altri-bandi-e-avvisi/bando-energia-sviluppo-contributi-alle-imprese",
  ],
  "camcom.bz.it": [
    "https://www.camcom.bz.it/it/servizi/agevolazioni-e-servizi-ue",
    "https://www.camcom.bz.it/it/amministrazione-trasparente/sovvenzioni-contributi-sussidi-vantaggi-economici/voucher-digitalizzazione-2026",
  ],
  "unioncamereveneto.it": ["https://www.unioncamereveneto.it"],
  "unioncamere.gov.it": ["https://www.unioncamere.gov.it"],
  "galpatavino.it": ["https://www.galpatavino.it"],
  "galaltobellunese.com": ["https://www.galaltobellunese.com/bandi/"],
  "galprealpidolomiti.it": ["https://www.galprealpidolomiti.it/bandi/"],
  "baldolessinia.it": ["https://www.baldolessinia.it/bandi/"],
  "galaltamarca.tv.it": ["https://galaltamarca.tv.it/cronoprogramma-annuale/"],
  "montagnavicentina.com": [
    "https://www.montagnavicentina.com/category/bandi/",
  ],
  "galdeltapo.it": [
    "https://galdeltapo.it/bandi/",
    "https://galdeltapo.it/bandi-e-opportunita",
  ],
  "galadige.it": ["https://www.galadige.it/bandi/"],
  "vegal.net": ["https://www.vegal.net/attivita/psl-2023-2027/"],
  "montagnappennino.it": ["https://www.montagnappennino.it/bandi/"],
  "gal-start.it": ["https://gal-start.it/bandi/"],
  "galterretrusche.com": [
    "https://www.galterretrusche.com/avvisi-bandi-e-progetti",
  ],
  "farmaremma.it": ["https://www.farmaremma.it/bandi/"],
  "leadersiena.it": ["https://www.leadersiena.it/?cat=7"],
  "galaretino.it": ["https://www.galaretino.it/bandi/"],
  "sviluppolunigiana.it": [
    "https://www.sviluppolunigiana.it/bandi/",
    "https://www.sviluppolunigiana.it/bandi/bandi-aperti/",
  ],
  "cittametropolitana.ve.it": [
    "https://www.cittametropolitana.ve.it/amministrazione-trasparente/sovvenzioni-contributi-sussidi-vantaggi-economici",
  ],
  "amministrazionetrasparente.provincia.treviso.it": [
    "https://amministrazionetrasparente.provincia.treviso.it/L190/?idSezione=20&sort=&activePage=&search=&cf4=true&id=273275",
  ],
  "provincia.cuneo.it": [
    "https://www.provincia.cuneo.it/amministrazione-trasparente/sovvenzioni-contributi-sussidi-vantaggi-economici",
  ],
  "cittametropolitana.fi.it": [
    "https://www.cittametropolitana.fi.it/amministrazione-trasparente/sovvenzioni-contributi-sussidi-vantaggi-economici",
  ],
  "bur.regione.veneto.it": ["https://bur.regione.veneto.it"],
  "regione.veneto.it": ["https://www.regione.veneto.it"],
  "regione.piemonte.it": [
    "https://www.regione.piemonte.it/governo/bollettino/abbonati/2026/corrente",
  ],
  "regione.lombardia.it": [
    "https://www.regione.lombardia.it/burl-bollettino-ufficiale-regione-lombardia",
  ],
  "burl.it": ["https://www.burl.it/"],
  "bur.regione.fvg.it": ["https://bur.regione.fvg.it/newbur/"],
  "bur.regione.emilia-romagna.it": [
    "https://bur.regione.emilia-romagna.it/ricerca",
  ],
  "regione.toscana.it": ["https://www.regione.toscana.it/burt"],
  "regione.vda.it": [
    "https://www.regione.vda.it/affari_legislativi/bollettino_ufficiale/default_i.asp",
  ],
  "invitalia.it": ["https://www.invitalia.it"],
  "mimit.gov.it": ["https://www.mimit.gov.it"],
  "incentivi.gov.it": ["https://www.incentivi.gov.it"],
  "italiadomani.gov.it": ["https://www.italiadomani.gov.it"],
  "padigitale2026.gov.it": ["https://www.padigitale2026.gov.it"],
  "pariopportunita.gov.it": ["https://www.pariopportunita.gov.it"],
  "politichegiovanili.gov.it": ["https://www.politichegiovanili.gov.it"],
  "funding-tenders.ec.europa.eu": ["https://funding-tenders.ec.europa.eu"],
  "eic.ec.europa.eu": ["https://eic.ec.europa.eu"],
  "eismea.ec.europa.eu": ["https://eismea.ec.europa.eu"],
  "ag.camcom.it": [
    "https://www.ag.camcom.it/servizio/promozione/",
    "https://www.ag.camcom.it/servizio/bando-voucher-pid-2026/",
  ],
  "ba.camcom.it": ["https://www.ba.camcom.it/info/bandi"],
  "basilicata.camcom.it": ["https://www.basilicata.camcom.it/avvisi-bandi"],
  "brta.camcom.it": ["https://www.brta.camcom.it/bandi"],
  "caor.camcom.it": ["https://www.caor.camcom.it/bandi"],
  "cameracommercio.cl.it": [
    "https://www.cameracommercio.cl.it/amministrazione-trasparente-main/bandi-in-corso/bandi-in-corso/",
  ],
  "ce.camcom.it": ["https://www.ce.camcom.it/bandi-incentivi"],
  "czkrvv.camcom.it": ["https://czkrvv.camcom.it/category/bandi/"],
  "chpe.camcom.it": ["https://www.chpe.camcom.it/pagina189754_bandi.html"],
  "cs.camcom.gov.it": [
    "https://www.cs.camcom.gov.it/it/content/service/avvisi-e-bandi-della-camera",
  ],
  "fg.camcom.it": [
    "https://www.fg.camcom.it/bandi-contributi/bandi-sostegno-imprese",
  ],
  "frlt.camcom.it": ["https://www.frlt.camcom.it/bandi"],
  "cameragransasso.camcom.it": [
    "https://www.cameragransasso.camcom.it/it/la-camera/promozione-economica/bandi/",
  ],
  "irpiniasannio.camcom.it": [
    "https://www.irpiniasannio.camcom.it/bandi-di-contributi",
  ],
  "le.camcom.it": [
    "https://www.le.camcom.it/promozione-e-sviluppo-del-territorio/bandi-e-contributi",
  ],
  "marche.camcom.it": [
    "https://www.marche.camcom.it/strumenti-e-servizi/bandi-e-contributi",
  ],
  "me.camcom.it": ["https://www.me.camcom.it/bandi"],
  "molise.camcom.gov.it": [
    "https://www.molise.camcom.gov.it/promuovi-la-tua-impresa-e-il-tuo-territorio/bandi-il-sostegno-alle-imprese",
  ],
  "na.camcom.gov.it": ["https://www.na.camcom.gov.it/bandi"],
  "nu.camcom.it": [
    "https://nu.camcom.it/it/camera/bandi/",
    "https://nu.camcom.it/it/camera/bandi/contributi-attivita-promozionali/",
  ],
  "paen.camcom.gov.it": ["https://www.paen.camcom.gov.it/it/bandi"],
  "rc.camcom.gov.it": [
    "https://www.rc.camcom.gov.it/internazionalizzazione/bandi-e-iniziative-linternazionalizzazione",
    "https://www.rc.camcom.gov.it/bandi-e-avvisi/voucher-linnovazione-digitale-con-il-bando-doppia-transizione-anno-2026",
  ],
  "rivt.camcom.it": [
    "https://www.rivt.camcom.it/it/attivita_34/supporto-alle-imprese_433/",
  ],
  "rm.camcom.it": [
    "https://www.rm.camcom.it/pagina82_avvisi-pubblici-bandi-per-contributi-e-attivit-promozionali-altre-opportunit.html",
    "https://www.rm.camcom.it/pagina105_contributi.html",
  ],
  "sa.camcom.it": ["https://www.sa.camcom.it/bandi"],
  "ss.camcom.it": ["https://www.ss.camcom.it/bandi"],
  "ctrgsr.camcom.gov.it": [
    "https://ctrgsr.camcom.gov.it/it/blog/bando-voucher-doppia-transizione-2026",
  ],
  "tp.camcom.it": ["https://www.tp.camcom.it/bandi"],
  "umbria.camcom.it": [
    "https://www.umbria.camcom.it/promuovere-limpresa-e-il-territorio/bandi-e-contributi",
  ],
  "regione.lazio.it": ["https://www.regione.lazio.it/bur"],
  "bur.regione.marche.it": ["https://bur.regione.marche.it/"],
  "bur.regione.umbria.it": ["https://bur.regione.umbria.it/"],
  "bura.regione.abruzzo.it": ["https://bura.regione.abruzzo.it/"],
  "burc.regione.campania.it": ["https://burc.regione.campania.it/"],
  "burp.regione.puglia.it": ["https://burp.regione.puglia.it/"],
  "regione.basilicata.it": [
    "https://www.regione.basilicata.it/?servizi-online=bur-bollettino-ufficiale-della-regione-basilicata",
  ],
  "buras.regione.sardegna.it": ["https://buras.regione.sardegna.it/"],
  "provincia.perugia.it": [
    "https://www.provincia.perugia.it/amministrazione-trasparente/sovvenzioni-contributi-sussidi-vantaggi-economici",
  ],
  "provincia.benevento.it": [
    "https://www.provincia.benevento.it/amministrazione-trasparente/sovvenzioni-contributi-sussidi-vantaggi-economici",
  ],
  "provincia.fermo.it": [
    "https://www.provincia.fermo.it/amministrazione-trasparente/sovvenzioni-contributi-sussidi-vantaggi-economici",
  ],
  "casadivetro.provincia.pu.it": [
    "https://casadivetro.provincia.pu.it/L190/?idSezione=20&id=&sort=&activePage=&search=",
  ],
  "cittametropolitanacagliari.it": [
    "https://cittametropolitanacagliari.it/portale/page/it/bandi_avvisi",
  ],
  "galcasacastra.it": ["https://www.galcasacastra.it/bandi/"],
  "galcilento.it": ["https://www.galcilento.it/category/bandi/"],
  "sentieridelbuonvivere.it": [
    "https://www.sentieridelbuonvivere.it/bandi/",
  ],
  "galpartenio.it": ["https://galpartenio.it/bandi/"],
  "galterraevita.eu": ["https://www.galterraevita.eu/bandi-aperti/"],
  "galvesuvioverde.it": ["https://www.galvesuvioverde.it/bandi/"],
  "inail.it": [
    "https://www.inail.it/portale/prevenzione-e-sicurezza/it/prevenzione-e-sicurezza/finanziamenti-per-la-sicurezza/incentivi-alle-imprese.html",
  ],
  "ice.it": [
    "https://www.ice.it/it/finanziamenti-internazionali",
    "https://www.ice.it/it/promozione-del-made-italy/concessione-contributi-centri-tecnologici",
  ],
  "fondimpresa.it": [
    "https://www.fondimpresa.it/i-canali-di-finanziamento/conto-di-sistema",
  ],
  "simest.it": [
    "https://www.simest.it/per-le-imprese/finanziamenti-agevolati",
  ],
  "gse.it": [
    "https://www.gse.it/servizi-per-te/fonti-rinnovabili/ferx/bandi",
  ],
};

export const SEED_PROVIDER = "seed-listing";
/** Budget: nessuna esplosione del tempo di collect sulle pagine indice. */
export const SEED_MAX_LINKS_PER_PAGE = 60;

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

export function seedListingUrls(officialDomain: string): string[] {
  return SEED_LISTING_URLS[normalizeDomain(officialDomain)] ?? [];
}

/**
 * Fail-closed: soltanto URL https dello stesso dominio ufficiale (o suoi
 * sottodomini). Qualunque altro schema, host o URL malformato viene scartato.
 */
export function isSameDomainHttpsUrl(
  rawUrl: string,
  officialDomain: string,
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = normalizeDomain(url.hostname);
  const allowed = normalizeDomain(officialDomain);
  return !!allowed && (host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * Estrae i link di una pagina indice ufficiale (HTML o markdown Firecrawl) e
 * conserva soltanto quelli https dello stesso dominio ufficiale.
 */
export function extractSameDomainLinks(
  content: string,
  baseUrl: string,
  officialDomain: string,
  maxLinks = SEED_MAX_LINKS_PER_PAGE,
): string[] {
  if (typeof content !== "string" || !content) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /<a\b[^>]*?href\s*=\s*["']([^"'#\s]+)["']/gi,
    /\]\(\s*(https?:\/\/[^)\s]+)\s*\)/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const href = match[1];
      if (!href || /^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
      let absolute: string;
      try {
        absolute = new URL(href, baseUrl).toString();
      } catch {
        continue;
      }
      if (!isSameDomainHttpsUrl(absolute, officialDomain)) continue;
      const key = absolute.replace(/#.*$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
      if (out.length >= maxLinks) return out;
    }
  }
  return out;
}
