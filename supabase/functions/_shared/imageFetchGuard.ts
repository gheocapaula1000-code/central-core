// _shared/imageFetchGuard.ts — download difensivo (anti-SSRF) delle sole
// fotografie dei portali realmente osservati nei raw payload Padova.
//
// Vincoli non negoziabili: HTTPS, allowlist host, nessun IP letterale,
// nessun host privato/localhost, nessun userinfo, nessuna porta anomala,
// redirect sempre in allowlist, timeout 8s, 5 MB, 5 immagini per annuncio,
// concorrenza 3, 300 richieste assolute, nessun cookie/header autenticato,
// nessun retry infinito, nessun salvataggio del file originale.

export const IMAGE_HOST_ALLOWLIST: readonly string[] = [
  // immobiliare.it
  "pwm.im-cdn.it",
  "pic.im-cdn.it",
  "s1.immobiliare.it",
  // idealista.it
  "st3.idealista.it",
  "st3v.idealista.it",
  "img4.idealista.it",
  // casa.it
  "img.casa.it",
  "images.casa.it",
  "images-1.casa.it",
  // subito.it
  "images.selezione.subito.it",
];


export const FETCH_TIMEOUT_MS = 8_000;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_LISTING = 5;
export const MAX_CONCURRENCY = 3;
export const MAX_TOTAL_REQUESTS = 300;
export const MAX_REDIRECTS = 3;

export type UrlRejectReason =
  | "NON_HTTPS"
  | "HOST_NON_IN_ALLOWLIST"
  | "IP_LETTERALE"
  | "HOST_PRIVATO"
  | "USERINFO_PRESENTE"
  | "PORTA_NON_CONSENTITA"
  | "URL_MALFORMATO";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|metadata\..*)$/i;

/** null = URL sicuro; altrimenti il motivo di rifiuto. */
export function checkImageUrl(raw: string): UrlRejectReason | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "URL_MALFORMATO";
  }
  if (u.protocol !== "https:") return "NON_HTTPS";
  if (u.username || u.password) return "USERINFO_PRESENTE";
  if (u.port && u.port !== "443") return "PORTA_NON_CONSENTITA";
  const host = u.hostname.toLowerCase();
  if (IPV4.test(host) || host.includes(":") || host.startsWith("[")) return "IP_LETTERALE";
  if (PRIVATE_HOST.test(host)) return "HOST_PRIVATO";
  if (!IMAGE_HOST_ALLOWLIST.includes(host)) return "HOST_NON_IN_ALLOWLIST";
  return null;
}

export function isSafeImageUrl(raw: string): boolean {
  return checkImageUrl(raw) === null;
}

export interface FetchBudget {
  used: number;
  max: number;
}

export interface FetchedImage {
  url: string;
  bytes: Uint8Array;
  contentType: string;
}

export type FetchFailure = { url: string; reason: string };

/**
 * Scarica una singola immagine seguendo i redirect manualmente: ogni hop
 * deve restare in allowlist. Nessun cookie, nessun header di autenticazione.
 */
export async function fetchImageSafe(
  url: string,
  budget: FetchBudget,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedImage | FetchFailure> {
  const reject = checkImageUrl(url);
  if (reject) return { url, reason: reject };

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (budget.used >= budget.max) return { url, reason: "BUDGET_RICHIESTE_ESAURITO" };
    budget.used++;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "image/*" },
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = String((e as Error)?.name === "AbortError" ? "TIMEOUT" : (e as Error)?.message ?? e);
      return { url, reason: msg };
    }
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { url, reason: "REDIRECT_SENZA_LOCATION" };
      const next = new URL(loc, current).toString();
      const r = checkImageUrl(next);
      if (r) return { url, reason: `REDIRECT_${r}` };
      current = next;
      continue;
    }
    if (!res.ok) return { url, reason: `HTTP_${res.status}` };

    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_IMAGE_BYTES) return { url, reason: "TROPPO_GRANDE" };

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) return { url, reason: "TROPPO_GRANDE" };
    if (buf.length === 0) return { url, reason: "VUOTA" };

    return { url, bytes: buf, contentType: res.headers.get("content-type") ?? "" };
  }
  return { url, reason: "TROPPI_REDIRECT" };
}

/** Esecuzione a concorrenza limitata, senza retry. */
export async function fetchImagesBounded(
  urls: string[],
  budget: FetchBudget,
  fetchImpl: typeof fetch = fetch,
  concurrency = MAX_CONCURRENCY,
): Promise<Array<FetchedImage | FetchFailure>> {
  const capped = urls.slice(0, MAX_IMAGES_PER_LISTING);
  const out: Array<FetchedImage | FetchFailure> = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, capped.length) }, async () => {
    while (i < capped.length) {
      const idx = i++;
      out.push(await fetchImageSafe(capped[idx], budget, fetchImpl));
    }
  });
  await Promise.all(workers);
  return out;
}

export function isFetched(r: FetchedImage | FetchFailure): r is FetchedImage {
  return (r as FetchedImage).bytes !== undefined;
}
