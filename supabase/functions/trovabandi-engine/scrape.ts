// UEradar.com — helpers puri per il fallback HTTP su fonti ufficiali.
//
// Nessuna esecuzione di script o rendering: il contenuto HTML viene convertito
// in testo, limitato dal chiamante e usato soltanto come evidenza documentale.

function normalizedDomain(value: string): string {
  const raw = value
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  try {
    return new URL(`https://${raw}`).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host === "::" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    /^fe[89ab]/.test(host)
  )
    return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  const candidate = mapped?.[1] ?? host;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(candidate);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return true;
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

export function isAllowedOfficialUrl(
  rawUrl: string,
  officialDomain: string,
): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password || isBlockedHostname(url.hostname))
      return false;
    if (url.port && url.port !== "80" && url.port !== "443") return false;
    const host = normalizedDomain(url.hostname);
    const allowed = normalizedDomain(officialDomain);
    return !!allowed && (host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (entity, token: string) => {
      const lower = token.toLowerCase();
      if (lower.startsWith("#x")) {
        const code = Number.parseInt(lower.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
      }
      if (lower.startsWith("#")) {
        const code = Number.parseInt(lower.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
      }
      return named[lower] ?? entity;
    },
  );
}

export function htmlToEvidenceText(html: string): {
  title: string;
  text: string;
} {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = decodeEntities((titleMatch?.[1] ?? "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(
        /<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi,
        " ",
      )
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

export async function readLimitedText(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function readLimitedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Alcune fonti ufficiali (BUR Veneto) dichiarano content-type malformati come
 * `application/application/pdf`: la verifica resta esplicita e non permissiva.
 */
export function isPdfContentType(contentType: string): boolean {
  const value = contentType.toLowerCase();
  return value.includes("application/pdf") || value.includes("/x-pdf");
}

export function isHtmlContentType(contentType: string): boolean {
  const value = contentType.toLowerCase();
  return (
    value.includes("text/html") ||
    value.includes("application/xhtml+xml") ||
    value.includes("text/plain")
  );
}

/**
 * Molte fonti ufficiali italiane rispondono soltanto sull'host `www.`
 * (apex senza DNS o con SNI non riconosciuto). La canonicalizzazione dei
 * candidati rimuove `www.`, quindi il fetch deve provare entrambe le varianti.
 * Nessun dominio nuovo viene introdotto: la verifica dominio resta invariata.
 */
export function officialUrlVariants(rawUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return [];
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return [];
  const variants = [url.toString()];
  const host = url.hostname.toLowerCase();
  if (!host.startsWith("www.") && host.split(".").length >= 2) {
    const withWww = new URL(url.toString());
    withWww.hostname = `www.${host}`;
    variants.push(withWww.toString());
  }
  if (url.protocol === "http:") {
    for (const variant of [...variants]) {
      const secure = new URL(variant);
      secure.protocol = "https:";
      variants.push(secure.toString());
    }
  }
  return [...new Set(variants)];
}

function inflate(bytes: Uint8Array): Promise<Uint8Array> | null {
  const formats = ["deflate", "deflate-raw"] as const;
  const attempt = async (): Promise<Uint8Array> => {
    let lastError: unknown = null;
    for (const format of formats) {
      try {
        const stream = new Blob([bytes.slice().buffer as ArrayBuffer])
          .stream()
          .pipeThrough(new DecompressionStream(format));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("inflate_failed");
  };
  return attempt();
}

function decodePdfLiteral(value: string): string {
  return value
    .replace(/\\([nrtbf])/g, (_m, code: string) => {
      const map: Record<string, string> = {
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      return map[code] ?? "";
    })
    .replace(/\\([0-7]{1,3})/g, (_m, oct: string) =>
      String.fromCharCode(Number.parseInt(oct, 8)),
    )
    .replace(/\\(.)/g, "$1");
}

function extractPdfTextOperators(content: string): string {
  const out: string[] = [];
  const regex = /\((?:\\.|[^\\()])*\)|\bTJ\b|\bTj\b|\bTD\b|\bTd\b|\bT\*\b|\bET\b/g;
  let match: RegExpExecArray | null;
  let line: string[] = [];
  while ((match = regex.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith("(")) {
      line.push(decodePdfLiteral(token.slice(1, -1)));
      continue;
    }
    if (token === "TD" || token === "Td" || token === "T*" || token === "ET") {
      if (line.length) {
        out.push(line.join(""));
        line = [];
      }
    }
  }
  if (line.length) out.push(line.join(""));
  return out.join("\n");
}

/**
 * Estrazione testuale minimale da PDF ufficiali: nessun rendering, nessuna
 * esecuzione. Restituisce testo vuoto se il PDF è scansionato o cifrato,
 * così il chiamante resta fail-closed e passa ai provider configurati.
 */
export async function pdfToEvidenceText(
  bytes: Uint8Array,
): Promise<{ title: string; text: string }> {
  const latin = new TextDecoder("latin1").decode(bytes);
  const pieces: string[] = [];
  const streamRegex = /stream\r?\n?([\s\S]*?)endstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRegex.exec(latin)) !== null) {
    const raw = match[1];
    const header = latin.slice(Math.max(0, match.index - 400), match.index);
    let decoded = raw;
    if (/FlateDecode/.test(header)) {
      const encoded = Uint8Array.from(raw, (char) => char.charCodeAt(0) & 0xff);
      try {
        const inflated = await inflate(encoded);
        decoded = inflated ? new TextDecoder("latin1").decode(inflated) : "";
      } catch {
        decoded = "";
      }
    } else if (/\/(DCTDecode|JPXDecode|CCITTFaxDecode|Image)/.test(header)) {
      decoded = "";
    }
    if (!decoded) continue;
    const text = extractPdfTextOperators(decoded);
    if (text.trim()) pieces.push(text);
    if (pieces.join("\n").length > 400_000) break;
  }
  const titleMatch = /\/Title\s*\(((?:\\.|[^\\()])*)\)/.exec(latin);
  const title = decodePdfLiteral(titleMatch?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  const text = pieces
    .join("\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}



/**
 * CSV ufficiali (Open Data): accettati solo i content-type dichiarati dai
 * portali istituzionali. Nessun altro binario viene ammesso.
 */
export function isCsvContentType(contentType: string): boolean {
  const value = contentType.toLowerCase();
  return (
    value.includes("text/csv") ||
    value.includes("application/csv") ||
    value.includes("application/vnd.ms-excel")
  );
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * Converte un CSV ufficiale in evidenza testuale: nessuna formula viene
 * valutata, nessun dato inventato. Fail-closed su CSV vuoti o senza
 * intestazioni e righe leggibili.
 */
export function csvToEvidenceText(
  bytes: Uint8Array,
  maxChars = 60_000,
): { title: string; text: string } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return { title: "", text: "" };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // Nessuna esecuzione: i prefissi di formula restano inerti come testo.
  const lines = text
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) return { title: "", text: "" };
  const delimiter = [";", ",", "\t", "|"]
    .map((candidate) => ({
      candidate,
      count: splitCsvLine(lines[0], candidate).length,
    }))
    .sort((a, b) => b.count - a.count)[0];
  if (!delimiter || delimiter.count < 2) return { title: "", text: "" };
  const header = splitCsvLine(lines[0], delimiter.candidate).map((cell) =>
    cell.replace(/\s+/g, " ").trim(),
  );
  if (header.filter(Boolean).length < 2) return { title: "", text: "" };
  const rows: string[] = [];
  let used = 0;
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line, delimiter.candidate);
    if (cells.filter((cell) => cell.length > 0).length === 0) continue;
    const rendered = header
      .map((name, index) => {
        const value = (cells[index] ?? "").replace(/\s+/g, " ").trim();
        return value ? `${name || `col_${index + 1}`}: ${value}` : "";
      })
      .filter(Boolean)
      .join(" | ");
    if (!rendered) continue;
    used += rendered.length + 1;
    if (used > maxChars) break;
    rows.push(rendered);
  }
  if (!rows.length) return { title: "", text: "" };
  const body = [header.filter(Boolean).join(" | "), ...rows]
    .join("\n")
    .slice(0, maxChars)
    .trim();
  return { title: header.filter(Boolean).join(" | ").slice(0, 500), text: body };
}
