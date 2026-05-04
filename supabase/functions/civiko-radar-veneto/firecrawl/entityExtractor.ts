// ═══════════════════════════════════════════════════════════════
// entityExtractor — estrazione entità da markdown.
// Approccio rule-based + regex (no AI generativa per evitare invenzioni).
// ═══════════════════════════════════════════════════════════════
import { stripPersonalData, isVenetoProvince } from "./complianceGuards.ts";

const PROV_MAP: Record<string,string> = {
  venezia:"VE", verona:"VR", vicenza:"VI", padova:"PD", treviso:"TV", belluno:"BL", rovigo:"RO",
};

const VENETO_COMUNI = [
  "Padova","Vicenza","Verona","Venezia","Mestre","Treviso","Belluno","Rovigo",
  "Bassano del Grappa","Schio","Thiene","Montecchio Maggiore","Arzignano",
  "Castelfranco Veneto","Conegliano","Chioggia","Legnago","San Bonifacio",
  "Este","Monselice","Cittadella","Abano Terme","Montegrotto Terme","Jesolo",
  "San Donà di Piave","Mirano","Dolo","Villafranca di Verona","Bussolengo",
  "Valdagno","Marostica","Oderzo","Vittorio Veneto","Feltre","Adria",
];

export interface ExtractedEntities {
  comune?: string | null;
  provincia?: string | null;
  dates?: string[];
  amounts_eur?: number[];
  surfaces_sqm?: number[];
  property_types?: string[];
  tribunale?: string | null;
  ente?: string | null;
  links?: string[];
  updated_at?: string | null;
}

export function extractEntities(args: {
  url: string;
  title: string | null;
  markdown: string | null;
  links: string[];
  hintComune?: string;
  hintProv?: string;
}): ExtractedEntities {
  const text = stripPersonalData(args.markdown ?? "");
  const out: ExtractedEntities = {};

  // Comune
  let comune = args.hintComune ?? null;
  if (!comune) {
    for (const c of VENETO_COMUNI) {
      const re = new RegExp(`\\b${c.replace(/ /g,"\\s+")}\\b`, "i");
      if (re.test(text) || re.test(args.title ?? "")) { comune = c; break; }
    }
  }
  out.comune = comune;

  // Provincia
  let prov = args.hintProv ?? null;
  if (!prov) {
    const m = text.match(/\b(Venezia|Verona|Vicenza|Padova|Treviso|Belluno|Rovigo)\b/i);
    if (m) prov = PROV_MAP[m[1].toLowerCase()];
    if (!prov) {
      const m2 = text.match(/\((VE|VR|VI|PD|TV|BL|RO)\)/);
      if (m2) prov = m2[1];
    }
  }
  out.provincia = isVenetoProvince(prov ?? null) ? (prov ?? null) : null;

  // Date ISO o italiane
  const dates = new Set<string>();
  for (const m of text.matchAll(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/g)) {
    const d = `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
    dates.add(d);
  }
  for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) dates.add(`${m[1]}-${m[2]}-${m[3]}`);
  out.dates = Array.from(dates).slice(0, 10);

  // Importi €
  const amounts: number[] = [];
  for (const m of text.matchAll(/€\s?([\d.,]{3,15})|euro\s?([\d.,]{3,15})/gi)) {
    const raw = (m[1] ?? m[2] ?? "").replace(/\./g,"").replace(",",".");
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1000 && n <= 50_000_000) amounts.push(Math.round(n));
  }
  out.amounts_eur = amounts.slice(0, 10);

  // Superfici mq
  const surf: number[] = [];
  for (const m of text.matchAll(/(\d{2,5})\s?(?:mq|m²|metri quadri)/gi)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 10 && n <= 100_000) surf.push(n);
  }
  out.surfaces_sqm = surf.slice(0, 10);

  // Tipologia
  const types = new Set<string>();
  for (const t of ["appartamento","villa","capannone","negozio","ufficio","terreno","villetta","attico","monolocale","bilocale","trilocale"]) {
    if (new RegExp(`\\b${t}\\b`, "i").test(text)) types.add(t);
  }
  out.property_types = Array.from(types);

  // Tribunale
  const tr = text.match(/Tribunale di ([A-ZÀ-Ý][a-zà-ÿ' ]{3,40})/);
  out.tribunale = tr ? tr[1].trim() : null;

  // Ente
  const en = text.match(/Comune di ([A-ZÀ-Ý][a-zà-ÿ' ]{3,40})/);
  out.ente = en ? `Comune di ${en[1].trim()}` : null;

  out.links = (args.links ?? []).slice(0, 30);
  out.updated_at = new Date().toISOString();
  return out;
}
