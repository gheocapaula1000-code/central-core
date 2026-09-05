// TrovaBandi — allegati ufficiali fail-closed.
//
// Popola solo quando la fonte noma l'allegato (Allegato A — …, elenco
// sotto intestazione Allegati/Modulistica, link etichettato).
// Mai inventare nomi file, URL o obbligatorietà.

import {
  canonicalizeApplyUrl,
  normalizeOfficialApplyUrl,
} from "./apply-links.ts";

export type OfficialAllegato = {
  nome: string;
  url?: string;
  obbligatorio: boolean;
};

const MAX_ALLEGATI = 20;
const MAX_NOME = 300;

const ALLEGATI_HEAD =
  /(?:^|\n)\s*(?:#{1,3}\s*)?(?:allegati(?:\s+al\s+(?:bando|avviso|presente\s+avviso))?|modulistica|documentazione\s+(?:da\s+allegare|allegata)|elenco\s+(?:degli\s+)?allegati)\b[^\n]{0,80}\n/gi;

const LIST_ITEM =
  /^(?:[-*•–]|\d{1,2}[.)]|[a-d][.)])\s+(.{4,400})$/;

const NAMED_ALLEGATO =
  /\ballegato\s+((?:[a-z])|(?:[ivxlcdm]{1,6})|(?:\d{1,2}))(?:\s*[)\].:\-–—])\s+([^\n]{3,240})/gi;

const DOC_NAME =
  /\b(?:modul[oi]|fac(?:-| )?simile|modell[oi]|formulario|scheda(?:\s+di)?|dichiarazione|domanda\s+di|relazione\s+tecnica|documento)\b/i;

const ALLEGATO_LABEL =
  /\ballegato\s+(?:[a-z]|\d{1,2}|[ivxlcdm]{1,6})\b|\bmodulistica\b|\bmodulo\s+di\s+(?:domanda|partecipazione|adesione|candidatura|richiesta)\b|\bfac(?:-| )?simile\b|\bformulario(?:\s+di\s+domanda)?\b/i;

const OBBLIGATORIO =
  /\b(?:obbligator\w*|a\s+pena\s+di\s+esclusione|pena\s+di\s+inammissibilit|must\s+be\s+(?:attached|submitted)|required)\b/i;
const FACOLTATIVO =
  /\b(?:facoltativ[oaie]|eventuale|optional|non\s+obbligator)\b/i;

const JUNK_NOME =
  /^(?:clicca\s+qui|download|scarica(?:\s+il\s+pdf)?|pdf|qui|link|allegati?|modulo|documenti?)$/i;

const HTML_LINK =
  /<a\b([^>]*)href\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))([^>]*)>([\s\S]*?)<\/a>/gi;
const MD_LINK = /\[([^\]]{0,240})\]\(\s*<?([^)\s>]+)>?\s*\)/gi;

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeNomeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/[*_`>#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nearby(text: string, index: number, radius = 80): string {
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + radius));
}

const STATUS_WORD =
  /obbligator\w*|facoltativ\w*|eventuale|optional|required/;

function cleanNome(raw: string): string | null {
  let nome = stripTags(raw)
    .replace(/\s+/g, " ")
    .replace(/[.;,]+$/, "")
    .replace(new RegExp(`\\(\\s*(?:${STATUS_WORD.source})\\s*\\)`, "gi"), "")
    .replace(new RegExp(`\\b(?:${STATUS_WORD.source})\\b`, "gi"), "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+[).]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (nome.length < 4 || nome.length > MAX_NOME) return null;
  if (JUNK_NOME.test(nome)) return null;
  if (/^https?:\/\//i.test(nome)) return null;
  return nome;
}

function obbligatorieta(context: string): boolean {
  if (FACOLTATIVO.test(context)) return false;
  return OBBLIGATORIO.test(context);
}

function looksLikeNamedDocument(nome: string): boolean {
  if (/\ballegato\s+(?:[a-z]|\d{1,2}|[ivxlcdm]{1,6})\b/i.test(nome)) return true;
  return DOC_NAME.test(nome);
}

function upsert(
  bucket: Map<string, OfficialAllegato>,
  item: OfficialAllegato,
): void {
  const key = normalizeNomeKey(item.nome);
  if (!key) return;
  const existing = bucket.get(key);
  if (!existing) {
    bucket.set(key, item);
    return;
  }
  if (!existing.url && item.url) existing.url = item.url;
  if (item.obbligatorio) existing.obbligatorio = true;
}

function addNamed(
  bucket: Map<string, OfficialAllegato>,
  letter: string,
  title: string,
  context: string,
  url?: string,
): void {
  const letterNorm = letter.trim();
  const titleNome = cleanNome(title);
  const full = cleanNome(`Allegato ${letterNorm} — ${titleNome ?? title}`);
  const nome = titleNome && looksLikeNamedDocument(`Allegato ${letterNorm} ${titleNome}`)
    ? full ?? titleNome
    : full ?? cleanNome(`Allegato ${letterNorm}`);
  if (!nome) return;
  const item: OfficialAllegato = {
    nome,
    obbligatorio: obbligatorieta(`${context} ${title}`),
  };
  if (url) item.url = url;
  upsert(bucket, item);
}

function officialUrl(
  raw: string,
  officialDomain: string,
  officialUrl: string,
  baseUrl?: string,
): string | null {
  return normalizeOfficialApplyUrl(raw, officialDomain, officialUrl, baseUrl);
}

function extractNamedFromText(
  text: string,
  bucket: Map<string, OfficialAllegato>,
  officialDomain: string,
  officialUrlValue: string,
): void {
  NAMED_ALLEGATO.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NAMED_ALLEGATO.exec(text)) !== null) {
    const line = text.slice(match.index, match.index + match[0].length + 80);
    const md = /\[([^\]]{0,240})\]\(\s*<?([^)\s>]+)>?\s*\)/.exec(line);
    const url = md?.[2]
      ? officialUrl(md[2], officialDomain, officialUrlValue, officialUrlValue)
      : undefined;
    addNamed(
      bucket,
      match[1],
      match[2],
      nearby(text, match.index ?? 0, 100),
      url ?? undefined,
    );
    if (bucket.size >= MAX_ALLEGATI) return;
  }
}

function extractListedSection(
  markdown: string,
  bucket: Map<string, OfficialAllegato>,
  officialDomain: string,
  officialUrlValue: string,
): void {
  const text = markdown.replace(/\r\n/g, "\n");
  const rx = new RegExp(ALLEGATI_HEAD.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = rx.exec(text))) {
    const start = match.index + match[0].length;
    const window = text.slice(start, start + 2200);
    let items = 0;
    for (const line of window.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (items) break;
        continue;
      }
      const bullet = trimmed.match(LIST_ITEM);
      if (!bullet) {
        if (items) break;
        continue;
      }
      items += 1;
      const raw = bullet[1];
      const md = /\[([^\]]{0,240})\]\(\s*<?([^)\s>]+)>?\s*\)/.exec(raw);
      const url = md?.[2]
        ? officialUrl(md[2], officialDomain, officialUrlValue, officialUrlValue) ??
          undefined
        : undefined;
      const named = new RegExp(NAMED_ALLEGATO.source, "i").exec(raw);
      if (named) {
        addNamed(bucket, named[1], named[2], raw, url);
        continue;
      }
      const nome = cleanNome(md?.[1] ?? raw);
      if (!nome || !looksLikeNamedDocument(nome)) continue;
      upsert(bucket, {
        nome,
        ...(url ? { url } : {}),
        obbligatorio: obbligatorieta(raw),
      });
    }
    if (bucket.size >= MAX_ALLEGATI) return;
  }
}

function extractLabeledLinks(
  html: string,
  markdown: string,
  officialDomain: string,
  officialUrlValue: string,
  bucket: Map<string, OfficialAllegato>,
): void {
  if (html) {
    HTML_LINK.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HTML_LINK.exec(html)) !== null) {
      const rawHref = (match[3] ?? match[4] ?? match[5] ?? "").trim();
      const label = stripTags(match[7] ?? "").slice(0, 240);
      const context = nearby(html, match.index ?? 0, 90);
      const after = html.slice(
        (match.index ?? 0) + match[0].length,
        (match.index ?? 0) + match[0].length + 80,
      );
      considerLink(
        bucket,
        rawHref,
        label,
        `${context} ${stripTags(after)}`,
        officialDomain,
        officialUrlValue,
      );
      if (bucket.size >= MAX_ALLEGATI) return;
    }
  }
  if (markdown) {
    MD_LINK.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MD_LINK.exec(markdown)) !== null) {
      considerLink(
        bucket,
        match[2] ?? "",
        match[1] ?? "",
        nearby(markdown, match.index ?? 0, 80),
        officialDomain,
        officialUrlValue,
      );
      if (bucket.size >= MAX_ALLEGATI) return;
    }
  }
}

function considerLink(
  bucket: Map<string, OfficialAllegato>,
  rawHref: string,
  label: string,
  context: string,
  officialDomain: string,
  officialUrlValue: string,
): void {
  const hay = `${label} ${context}`;
  const url = officialUrl(rawHref, officialDomain, officialUrlValue, officialUrlValue);
  const named = new RegExp(NAMED_ALLEGATO.source, "i").exec(label) ??
    new RegExp(NAMED_ALLEGATO.source, "i").exec(hay);
  if (named) {
    addNamed(bucket, named[1], named[2], hay, url ?? undefined);
    return;
  }
  if (!ALLEGATO_LABEL.test(hay)) return;
  const nome = cleanNome(label);
  if (!nome || !looksLikeNamedDocument(nome)) return;
  upsert(bucket, {
    nome,
    ...(url ? { url } : {}),
    obbligatorio: obbligatorieta(hay),
  });
}

function nomeAttestedInProof(nome: string, proofText: string): boolean {
  const key = normalizeNomeKey(nome);
  if (key.length < 4) return false;
  return normalizeNomeKey(proofText).includes(key);
}

/**
 * Accetta solo allegati il cui nome compare nel testo ufficiale.
 * URL soltanto se https ufficiale; obbligatorietà solo se attestata.
 */
export function attestExtractedAllegati(
  raw: unknown,
  proofText: string,
  officialUrlValue: string,
  officialDomain: string,
): OfficialAllegato[] {
  if (!Array.isArray(raw) || typeof proofText !== "string") return [];
  const bucket = new Map<string, OfficialAllegato>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const nome = cleanNome(typeof row.nome === "string" ? row.nome : "");
    if (!nome || !nomeAttestedInProof(nome, proofText)) continue;
    const url = typeof row.url === "string"
      ? officialUrl(row.url, officialDomain, officialUrlValue, officialUrlValue)
      : null;
    const wantRequired = row.obbligatorio === true;
    const at = proofText.toLowerCase().indexOf(nome.toLowerCase());
    const near = at >= 0 ? nearby(proofText, at, 120) : nome;
    upsert(bucket, {
      nome,
      ...(url ? { url } : {}),
      obbligatorio: wantRequired && obbligatorieta(`${near} ${nome}`),
    });
    if (bucket.size >= MAX_ALLEGATI) break;
  }
  return [...bucket.values()];
}

export function extractOfficialAllegati(input: {
  html?: string | null;
  markdown?: string | null;
  officialUrl: string;
  officialDomain: string;
  extracted?: unknown;
}): OfficialAllegato[] {
  const officialUrlValue = typeof input.officialUrl === "string" ? input.officialUrl : "";
  const officialDomain = typeof input.officialDomain === "string"
    ? input.officialDomain
    : "";
  if (!officialUrlValue || !officialDomain) return [];

  const html = typeof input.html === "string" ? input.html : "";
  const markdown = typeof input.markdown === "string" ? input.markdown : "";
  const bucket = new Map<string, OfficialAllegato>();

  if (markdown) {
    extractListedSection(markdown, bucket, officialDomain, officialUrlValue);
    extractNamedFromText(markdown, bucket, officialDomain, officialUrlValue);
  }
  extractLabeledLinks(html, markdown, officialDomain, officialUrlValue, bucket);

  const local = [...bucket.values()];
  const attested = attestExtractedAllegati(
    input.extracted,
    `${html}\n${markdown}`,
    officialUrlValue,
    officialDomain,
  );
  const merged = new Map<string, OfficialAllegato>();
  for (const item of local) upsert(merged, item);
  for (const item of attested) upsert(merged, item);

  return [...merged.values()]
    .sort((a, b) => a.nome.localeCompare(b.nome, "it"))
    .slice(0, MAX_ALLEGATI)
    .map((item) => {
      const out: OfficialAllegato = {
        nome: item.nome,
        obbligatorio: item.obbligatorio === true,
      };
      if (item.url) {
        const url = canonicalizeApplyUrl(item.url) || item.url;
        out.url = url;
      }
      return out;
    });
}
