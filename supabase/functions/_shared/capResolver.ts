// ═══════════════════════════════════════════════════════════════
// capResolver.ts — mapping comune/frazione → CAP per provincia Padova.
//
// Statico: nessun round-trip DB per non introdurre latency e per garantire
// che il parser degli aggregati sia stateless e purely-functional.
// Copertura: 104 comuni della provincia PD + capoluogo multi-CAP.
// Fonte: elenco Poste Italiane / ISTAT (dominio pubblico).
// ═══════════════════════════════════════════════════════════════

// CAPs validi per la provincia di Padova (range 35010-35048 comuni,
// 35121-35143 città capoluogo, più 35010 e alcune eccezioni).
const PADOVA_VALID_CAPS = new Set<string>([
  // Capoluogo
  "35121","35122","35123","35124","35125","35126","35127","35128","35129",
  "35131","35132","35133","35134","35135","35136","35137","35138","35139",
  "35141","35142","35143",
  // Provincia
  "35010","35011","35012","35013","35014","35015","35016","35017","35018","35019",
  "35020","35021","35022","35023","35024","35025","35026","35027","35028",
  "35030","35031","35032","35033","35034","35035","35036","35037","35038","35039","35040",
  "35041","35042","35043","35044","35045","35046","35047","35048",
]);

// Alias comune → CAP principale (per fallback quando la fonte espone solo il nome).
// Solo comuni PD. Chiavi normalizzate lowercase, senza accenti/apostrofi.
const COMUNE_TO_CAP: Record<string, string> = {
  "padova": "35121",
  "abano terme": "35031",
  "agna": "35021",
  "albignasego": "35020",
  "anguillara veneta": "35022",
  "arqua petrarca": "35032",
  "arre": "35020",
  "arzergrande": "35020",
  "bagnoli di sopra": "35023",
  "baone": "35030",
  "barbona": "35040",
  "battaglia terme": "35041",
  "boara pisani": "35040",
  "borgoricco": "35010",
  "bovolenta": "35024",
  "brugine": "35020",
  "cadoneghe": "35010",
  "campo san martino": "35010",
  "campodarsego": "35011",
  "campodoro": "35010",
  "camposampiero": "35012",
  "candiana": "35020",
  "carceri": "35040",
  "carmignano di brenta": "35010",
  "cartura": "35025",
  "casale di scodosia": "35040",
  "casalserugo": "35020",
  "castelbaldo": "35040",
  "cervarese santa croce": "35030",
  "cinto euganeo": "35030",
  "cittadella": "35013",
  "codevigo": "35020",
  "conselve": "35026",
  "correzzola": "35020",
  "curtarolo": "35010",
  "due carrare": "35020",
  "este": "35042",
  "fontaniva": "35014",
  "galliera veneta": "35015",
  "galzignano terme": "35030",
  "gazzo": "35010",
  "grantorto": "35010",
  "granze": "35040",
  "grumolo delle abbadesse": "36040", // VI, skip
  "legnaro": "35020",
  "limena": "35010",
  "loreggia": "35010",
  "lozzo atestino": "35034",
  "maserà di padova": "35020",
  "masera di padova": "35020",
  "masi": "35040",
  "massanzago": "35010",
  "megliadino san vitale": "35040",
  "merlara": "35040",
  "mestrino": "35035",
  "monselice": "35043",
  "montagnana": "35044",
  "montegrotto terme": "35036",
  "noventa padovana": "35027",
  "ospedaletto euganeo": "35045",
  "padernello": "35010",
  "pernumia": "35020",
  "piacenza d'adige": "35040",
  "piacenza d adige": "35040",
  "piazzola sul brenta": "35016",
  "piombino dese": "35017",
  "piove di sacco": "35028",
  "polverara": "35020",
  "ponso": "35040",
  "pontelongo": "35029",
  "ponte san nicolo": "35020",
  "ponte san nicolò": "35020",
  "pozzonovo": "35020",
  "rovolon": "35030",
  "rubano": "35030",
  "saccolongo": "35030",
  "san giorgio delle pertiche": "35010",
  "san giorgio in bosco": "35010",
  "san martino di lupari": "35018",
  "san pietro in gu": "35010",
  "san pietro viminario": "35020",
  "sant'angelo di piove di sacco": "35020",
  "santa giustina in colle": "35010",
  "sant'elena": "35040",
  "sant'urbano": "35040",
  "santurbano": "35040",
  "saonara": "35020",
  "selvazzano dentro": "35030",
  "solesino": "35047",
  "sant'angelo di piove di sacco": "35020",
  "stanghella": "35048",
  "teolo": "35037",
  "terrassa padovana": "35020",
  "tombolo": "35019",
  "torreglia": "35038",
  "trebaseleghe": "35010",
  "tribano": "35020",
  "urbana": "35040",
  "veggiano": "35030",
  "vescovana": "35040",
  "vighizzolo d'este": "35040",
  "vigodarzere": "35010",
  "vigonza": "35010",
  "villa del conte": "35010",
  "villa estense": "35040",
  "villafranca padovana": "35010",
  "villanova di camposampiero": "35010",
  "vo": "35030",
  "vo'": "35030",
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,;:]+$/g, "");
}

/** True se il CAP appartiene alla provincia di Padova. */
export function isPadovaCap(cap: string): boolean {
  return PADOVA_VALID_CAPS.has(cap.trim());
}

/** Estrae il primo CAP PD valido da un testo libero (5 cifre 35xxx). */
export function extractPadovaCap(text: string): string | null {
  const m = text.match(/\b(35\d{3})\b/);
  if (!m) return null;
  return isPadovaCap(m[1]) ? m[1] : null;
}

/** Risolve un comune PD in CAP principale (fallback quando la fonte non espone CAP). */
export function comuneToCap(comune: string | null | undefined): string | null {
  if (!comune) return null;
  const cap = COMUNE_TO_CAP[normalize(comune)];
  return cap && isPadovaCap(cap) ? cap : null;
}

/** Lista CAP validi (per test / diagnostica). */
export function padovaCapList(): string[] {
  return [...PADOVA_VALID_CAPS].sort();
}

/** Scansiona un testo alla ricerca di qualunque comune PD noto; ritorna il CAP del primo match. */
export function findAnyPadovaComuneCap(text: string): string | null {
  if (!text) return null;
  const t = ` ${text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")} `;
  // Ordine: comuni con nome composto (>1 parola) prima, per evitare match parziali
  const keys = Object.keys(COMUNE_TO_CAP).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    // word-boundary manuale (spazi ai lati) — evita falsi match dentro parole
    if (t.includes(` ${k} `) || t.includes(` ${k},`) || t.includes(` ${k}.`) || t.includes(` ${k}(`)) {
      const cap = COMUNE_TO_CAP[k];
      if (cap && PADOVA_VALID_CAPS.has(cap)) return cap;
    }
  }
  return null;
}

