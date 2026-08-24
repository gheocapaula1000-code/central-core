// TrovaBandi — recinto fail-closed: una pagina ufficiale è un bando
// soltanto se non è un indice/homepage/FAQ/newsletter e il testo descrive
// un avviso, non il chrome del sito ("browser does not support video").

const LISTING_LEAF =
  /^(bandi|avvisi|incentivi|contributi|agevolazioni|opportunita|opportunità|elenco|elenchi|lista|news|novita|novità|faq|faqs|newsletter|home|homepage|index|index\.html|index\.php|video|mediacenter)$/i;

const LISTING_PREFIX =
  /^(bandi|avvisi|elenco|elenchi|incentivi|contributi)([-_]|$)/i;

const JUNK_LEAF =
  /^(faq|faqs|domande-frequenti|newsletter|iscrizione-newsletter|subscribe|cookie|privacy|login|area-riservata|video)$/i;

const JUNK_CONTENT =
  /browser (?:does not|doesn't) support (?:the )?video|il (?:tuo )?browser non (?:supporta|supporta il) video|your browser does not support|abilita javascript|enable javascript|iscriviti alla newsletter|subscribe to (?:our )?newsletter/i;

const STRONG_NOTICE =
  /\bavviso pubblico\b|\bdecreto\b.{0,40}\b(?:bando|contribut)|call for (?:proposals?|tenders?)|\bscadenz|\btermine (?:di presentazione|ultimo)\b/i;

const OPPORTUNITY_HINT =
  /\b(?:bando|avviso\s+pubblico|contributo|incentiv[oi]|agevolazion[ei]|fondo\s+perduto|finanziamento\s+agevolato|voucher|call\s+for\s+(?:proposals?|tenders?)|grant|funding\s+opportunit)\b/i;

function pathSegments(url: string): string[] {
  try {
    return new URL(url).pathname.split("/").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Indice, homepage, FAQ, newsletter, elenco /bandi senza scheda.
 * Non è un avviso singolo: non va persistito come opportunità.
 */
export function isIndexOrLandingUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url.trim()) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  const path = (parsed.pathname.replace(/\/+$/, "") || "/").toLowerCase();
  if (
    path === "/" ||
    path === "/it" ||
    path === "/en" ||
    path === "/fr" ||
    path === "/de" ||
    path === "/it/home" ||
    path === "/en/home"
  ) {
    return true;
  }
  const segments = pathSegments(url);
  if (segments.length === 0) return true;
  const leaf = segments[segments.length - 1] ?? "";
  if (LISTING_LEAF.test(leaf) || LISTING_PREFIX.test(leaf)) return true;
  if (JUNK_LEAF.test(leaf)) return true;
  if (/^index(?:\.html|\.php)?$/i.test(leaf) && !/bando|avviso|contribut/i.test(parsed.search)) {
    return true;
  }
  return false;
}

/**
 * Chrome di sito (video player, newsletter, FAQ vuota) senza corpo di avviso.
 * Un bando vero che incorpora un video resta ammissibile.
 */
export function isJunkOpportunityContent(markdown: unknown): boolean {
  if (typeof markdown !== "string") return true;
  const text = markdown.replace(/\s+/g, " ").trim();
  if (text.length < 400) return true;
  const faqOnly = /\b(?:faq|domande frequenti)\b/i.test(text) &&
    !STRONG_NOTICE.test(text);
  if (faqOnly) return true;
  if (!JUNK_CONTENT.test(text)) return false;
  const stripped = text
    .replace(JUNK_CONTENT, " ")
    .replace(/\b(?:cookie|privacy policy|newsletter)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length < 400) return true;
  return !STRONG_NOTICE.test(stripped) && !OPPORTUNITY_HINT.test(stripped);
}

export function isEligibleOfficialOpportunity(input: {
  officialUrl: string;
  markdown: string;
}): boolean {
  if (isIndexOrLandingUrl(input.officialUrl)) return false;
  if (isJunkOpportunityContent(input.markdown)) return false;
  if (typeof input.markdown !== "string" || input.markdown.trim().length < 400) {
    return false;
  }
  return OPPORTUNITY_HINT.test(input.markdown);
}

export function classifyOfficialListingUrl(
  url: unknown,
): "junk_listing" | "candidate" {
  return isIndexOrLandingUrl(url) ? "junk_listing" : "candidate";
}
