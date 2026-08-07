// UEradar.com — helpers puri per il fallback HTTP su fonti ufficiali.
//
// Nessuna esecuzione di script o rendering: il contenuto HTML viene convertito
// in testo, limitato dal chiamante e usato soltanto come evidenza documentale.

function normalizedDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
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

export function isAllowedOfficialUrl(rawUrl: string, officialDomain: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password || isBlockedHostname(url.hostname)) return false;
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
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, token: string) => {
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
  });
}

export function htmlToEvidenceText(html: string): { title: string; text: string } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = decodeEntities((titleMatch?.[1] ?? "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}
