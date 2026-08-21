// TrovaBandi — estrazione fail-closed di modulistica / domanda.
//
// Legge soltanto link già pubblicati sulla pagina ufficiale o sul notice.
// Nessun comune inventato, nessun form indovinato. Se la pagina non mostra
// un link etichettato, i campi restano null.
//
// Colonne persistite: forms_url (modulistica / PDF) e application_url
// (piattaforma / presenta la domanda). La PWA espone forms_url anche come
// modulistica_url.

import { isAllowedOfficialUrl } from "./scrape.ts";

export const FVG_BUR_HOST = "bur.regione.fvg.it";

const HTML_LINK =
  /<a\b([^>]*)href\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))([^>]*)>([\s\S]*?)<\/a>/gi;
const MD_LINK = /\[([^\]]{0,200})\]\(\s*<?([^)\s>]+)>?\s*\)/gi;
const BARE_URL = /https?:\/\/[^\s<>"'`\]]+/gi;

const FORMS_HINT =
  /\b(?:modulistica|moduli(?:stica)?|modulo(?:\s+di\s+(?:domanda|partecipazione|adesione|candidatura|richiesta))?|fac(?:-| )?simile|modello\s+(?:di\s+)?(?:domanda|partecipazione)|scheda\s+di\s+domanda|domanda\s+di\s+partecipazione|formulario(?:\s+di\s+domanda)?|pdf\s+compilabile|modulo\s+pdf|application\s+form|grant\s+form)\b/i;

const APPLICATION_HINT =
  /\b(?:presenta(?:zione)?\s+(?:la\s+)?domanda|presenta\s+domanda|domanda\s+online|sportello(?:\s+telematico)?|piattaforma(?:\s+di\s+presentazione)?|invia(?:re)?\s+(?:la\s+)?domanda|compilazione\s+(?:della\s+)?domanda|sistema\s+di\s+presentazione|portale\s+(?:domande|di\s+presentazione)|candidatura|submission(?:\s+portal)?|apply\s+now|submit\s+(?:an?\s+)?application)\b/i;

const APPLICATION_PATH =
  /\/(?:sportello|domanda(?:-online)?|presenta(?:zione)?(?:-la)?-domanda|apply|submission|candidatura|piattaforma)(?:\/|$|\?)/i;

const FORMS_PATH =
  /\/(?:modulistica|modulo(?:-di-)?domanda|moduli|facsimile|formulario)(?:\/|$|\.)|modulo[-_](?:domanda|partecipazione)|domanda[-_](?:partecipazione|adesione)|modulistica/i;

const LANDING_PATHS = new Set([
  "/",
  "/it",
  "/en",
  "/fr",
  "/de",
  "/home",
  "/homepage",
  "/index",
  "/index.html",
  "/index.php",
  "/it-it",
  "/en-gb",
  "/it/home",
  "/en/home",
]);

const MARKETING_PATH =
  /\/(?:chi-siamo|about(?:-us)?|news|comunicati|stampa|contatti|contact|privacy|cookie|login|area-riservata|newsletter|eventi|media|lavora-con-noi)(?:\/|$)/i;

const BLOCKED_HREF = /^(javascript|mailto|tel|data):/i;

export interface ApplyLinkFields {
  forms_url: string | null;
  application_url: string | null;
}

export interface ApplyLinkInput {
  html?: string | null;
  markdown?: string | null;
  officialUrl: string;
  officialDomain: string;
}

interface ScoredLink {
  url: string;
  forms: number;
  application: number;
  label: string;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function nearby(text: string, index: number, radius = 80): string {
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + radius));
}

function attrValue(attrs: string, name: string): string {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(attrs);
  return (match?.[2] ?? match?.[3] ?? match?.[4] ?? "").trim();
}

export function shouldSkipApplyFetch(url: unknown): boolean {
  if (typeof url !== "string" || !url.trim()) return true;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host === FVG_BUR_HOST || host.endsWith(`.${FVG_BUR_HOST}`);
  } catch {
    return true;
  }
}

export function upgradeToHttps(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.protocol = "https:";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function canonicalizeApplyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

export function isLandingPageUrl(
  url: string,
  officialUrl?: string | null,
): boolean {
  try {
    const parsed = new URL(url);
    const path = (parsed.pathname.replace(/\/+$/, "") || "/").toLowerCase();
    if (LANDING_PATHS.has(path)) return true;
    if (officialUrl && canonicalizeApplyUrl(url) === canonicalizeApplyUrl(officialUrl)) {
      return true;
    }
    if (MARKETING_PATH.test(path)) return true;
    return false;
  } catch {
    return true;
  }
}

function isPdfUrl(url: string, label = ""): boolean {
  return /\.pdf(?:$|[?#])/i.test(url) || /\bpdf\b/i.test(label);
}

/**
 * Accetta solo https sullo stesso dominio ufficiale, mai la landing
 * né una copia dell'official_url (il bug delle 5 homepage Invitalia/GSE).
 */
export function normalizeOfficialApplyUrl(
  value: unknown,
  officialDomain: string,
  officialUrl?: string | null,
  baseUrl?: string | null,
): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.startsWith("#") || BLOCKED_HREF.test(raw)) return null;
  let absolute: string;
  try {
    absolute = new URL(raw, baseUrl || officialUrl || undefined).toString();
  } catch {
    return null;
  }
  const https = upgradeToHttps(absolute);
  if (!https) return null;
  if (!isAllowedOfficialUrl(https, officialDomain)) return null;
  if (isLandingPageUrl(https, officialUrl)) return null;
  return https;
}

function scoreCandidate(url: string, label: string, context: string): ScoredLink | null {
  const hay = `${label} ${context} ${url}`;
  const pdf = isPdfUrl(url, label);
  let forms = 0;
  let application = 0;

  if (FORMS_HINT.test(hay) || FORMS_PATH.test(url)) {
    forms = pdf ? 100 : 68;
    if (
      /modulo\s+di\s+domanda|domanda\s+di\s+partecipazione|pdf\s+compilabile|application\s+form/i
        .test(hay)
    ) {
      forms += 16;
    }
  } else if (pdf && /modulo|domanda[-_]partecip|modulistica|formulario/i.test(url)) {
    forms = 82;
  }

  if (APPLICATION_HINT.test(hay)) {
    application = pdf ? 48 : 100;
    if (
      /presenta(?:zione)?\s+(?:la\s+)?domanda|piattaforma\s+di\s+presentazione/i
        .test(hay)
    ) {
      application += 12;
    }
  } else if (
    APPLICATION_PATH.test(url) &&
    /\b(?:domanda|sportello|apply|piattaforma|submission)\b/i.test(hay)
  ) {
    application = 62;
  }

  if (forms <= 0 && application <= 0) return null;
  return { url, forms, application, label };
}

function consider(
  bucket: Map<string, ScoredLink>,
  rawHref: string,
  label: string,
  context: string,
  officialDomain: string,
  officialUrl: string,
  baseUrl: string,
): void {
  const url = normalizeOfficialApplyUrl(
    rawHref,
    officialDomain,
    officialUrl,
    baseUrl,
  );
  if (!url) return;
  const scored = scoreCandidate(url, label, context);
  if (!scored) return;
  const key = canonicalizeApplyUrl(url);
  const existing = bucket.get(key);
  if (
    !existing ||
    scored.forms + scored.application > existing.forms + existing.application
  ) {
    bucket.set(key, scored);
  }
}

function pickBest(links: ScoredLink[], kind: "forms" | "application"): string | null {
  const ranked = links
    .filter((link) => link[kind] > 0)
    .sort((a, b) => b[kind] - a[kind] || a.url.localeCompare(b.url));
  return ranked[0]?.url ?? null;
}

/**
 * Estrae forms_url / application_url da HTML e/o markdown già scaricato.
 * Fail-closed: senza etichetta chiara restituisce null.
 */
export function extractApplyLinks(input: ApplyLinkInput): ApplyLinkFields {
  const officialUrl = typeof input.officialUrl === "string" ? input.officialUrl : "";
  const officialDomain = typeof input.officialDomain === "string"
    ? input.officialDomain
    : "";
  if (!officialUrl || !officialDomain) {
    return { forms_url: null, application_url: null };
  }

  const bucket = new Map<string, ScoredLink>();
  const html = typeof input.html === "string" ? input.html : "";
  const markdown = typeof input.markdown === "string" ? input.markdown : "";
  const baseUrl = officialUrl;

  if (html) {
    HTML_LINK.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HTML_LINK.exec(html)) !== null) {
      const rawHref = (match[3] ?? match[4] ?? match[5] ?? "").trim();
      const attrs = `${match[1] ?? ""} ${match[6] ?? ""}`;
      const label = [stripTags(match[7] ?? ""), attrValue(attrs, "title")]
        .filter(Boolean)
        .join(" ")
        .slice(0, 240);
      consider(
        bucket,
        rawHref,
        label,
        nearby(html, match.index ?? 0, 90),
        officialDomain,
        officialUrl,
        baseUrl,
      );
    }
  }

  if (markdown) {
    MD_LINK.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MD_LINK.exec(markdown)) !== null) {
      consider(
        bucket,
        match[2] ?? "",
        match[1] ?? "",
        nearby(markdown, match.index ?? 0, 80),
        officialDomain,
        officialUrl,
        baseUrl,
      );
    }
    BARE_URL.lastIndex = 0;
    while ((match = BARE_URL.exec(markdown)) !== null) {
      const raw = (match[0] ?? "").replace(/[),.;]+$/, "");
      consider(
        bucket,
        raw,
        "",
        nearby(markdown, match.index ?? 0, 80),
        officialDomain,
        officialUrl,
        baseUrl,
      );
    }
  }

  const links = [...bucket.values()];
  let forms_url = pickBest(links, "forms");
  let application_url = pickBest(links, "application");

  // Un PDF di modulistica non va copiato anche come piattaforma.
  if (forms_url && application_url && canonicalizeApplyUrl(forms_url) ===
    canonicalizeApplyUrl(application_url)) {
    if (isPdfUrl(forms_url)) application_url = null;
    else forms_url = null;
  }

  return { forms_url, application_url };
}

function asStoredApplyUrl(
  value: unknown,
  officialDomain: string,
  officialUrl: string,
): string | null {
  return normalizeOfficialApplyUrl(value, officialDomain, officialUrl);
}

/**
 * Precedenza: link etichettati sulla pagina, poi URL già estratti/persistiti
 * se sono https ufficiali e non landing. Mai una homepage.
 */
export function resolveOfficialApplyUrls(input: ApplyLinkInput & {
  extractedForms?: unknown;
  extractedApplication?: unknown;
  existingForms?: unknown;
  existingApplication?: unknown;
}): ApplyLinkFields {
  const parsed = extractApplyLinks(input);
  const officialUrl = input.officialUrl;
  const officialDomain = input.officialDomain;
  const forms_url = parsed.forms_url ||
    asStoredApplyUrl(input.extractedForms, officialDomain, officialUrl) ||
    asStoredApplyUrl(input.existingForms, officialDomain, officialUrl);
  const application_url = parsed.application_url ||
    asStoredApplyUrl(input.extractedApplication, officialDomain, officialUrl) ||
    asStoredApplyUrl(input.existingApplication, officialDomain, officialUrl);
  return { forms_url: forms_url ?? null, application_url: application_url ?? null };
}

export function isFillablePdfUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /\.pdf(?:$|[?#])/i.test(url);
}
