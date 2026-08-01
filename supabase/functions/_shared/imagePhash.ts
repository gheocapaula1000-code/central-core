// _shared/imagePhash.ts — fingerprint percettivo deterministico sui BYTE reali.
//
// Nessuna dipendenza esterna: la decodifica (JPEG/PNG) resta fuori da questo
// modulo, che lavora su RGBA già decodificato. Questo mantiene il calcolo
// identico fra Deno (edge) e Node (test) e lo rende verificabile.
//
// Algoritmo: pHash DCT-II 64 bit
//   1. RGBA -> luminanza (Rec. 601)
//   2. box-resize a 32x32 (area media, deterministico)
//   3. DCT-II 2D 32x32
//   4. blocco 8x8 in basso a sinistra dello spettro, escluso il coefficiente DC
//   5. bit = coefficiente > mediana
//
// Regola: MAI usare URL, filename o path come fingerprint.

export const PHASH_ALGO = "phash-dct-8x8-v1";
/** Distanza di Hamming massima per considerare due foto la stessa scena. */
export const PHASH_MATCH_MAX_DISTANCE = 8;
/** Sotto questa entropia (bit/pixel su istogramma luma) l'immagine è inutile. */
export const MIN_LUMA_ENTROPY = 3.2;
/** Lato minimo accettato: sotto è miniatura/icona, non prova. */
export const MIN_IMAGE_SIDE = 200;
/** Immagini identiche presenti in almeno N annunci scollegati = materiale generico. */
export const GENERIC_REUSE_THRESHOLD = 3;

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 4 byte per pixel. */
  data: Uint8Array | Uint8ClampedArray;
}

export interface ImageFingerprint {
  sha256: string;
  phash: string; // 16 hex = 64 bit
  width: number;
  height: number;
  bytes: number;
  entropy: number;
  algo: string;
}

/* ── luminanza + resize ─────────────────────────────────────────────────── */

export function toLuma(img: RgbaImage): Float64Array {
  const { width: w, height: h, data } = img;
  const out = new Float64Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return out;
}

/** Box filter deterministico: resistente a ricompressione e ridimensionamento. */
export function boxResize(
  src: Float64Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Float64Array {
  const out = new Float64Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < sh; yy++) {
        for (let xx = x0; xx < x1 && xx < sw; xx++) {
          sum += src[yy * sw + xx];
          n++;
        }
      }
      out[y * dw + x] = n ? sum / n : 0;
    }
  }
  return out;
}

/* ── DCT-II 2D ──────────────────────────────────────────────────────────── */

function dct1d(v: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += v[i] * Math.cos((Math.PI * (2 * i + 1) * k) / (2 * n));
    out[k] = s * (k === 0 ? Math.SQRT1_2 : 1);
  }
  return out;
}

export function dct2d(m: Float64Array, n: number): Float64Array {
  const rows = new Float64Array(n * n);
  const buf = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) buf[x] = m[y * n + x];
    const r = dct1d(buf, n);
    for (let x = 0; x < n; x++) rows[y * n + x] = r[x];
  }
  const out = new Float64Array(n * n);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) buf[y] = rows[y * n + x];
    const c = dct1d(buf, n);
    for (let y = 0; y < n; y++) out[y * n + x] = c[y];
  }
  return out;
}

/* ── pHash ──────────────────────────────────────────────────────────────── */

export function phashFromRgba(img: RgbaImage): string {
  const N = 32;
  const luma = toLuma(img);
  const small = boxResize(luma, img.width, img.height, N, N);
  const spectrum = dct2d(small, N);

  const coeffs: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (x === 0 && y === 0) continue; // scarta il DC
      coeffs.push(spectrum[y * N + x]);
    }
  }
  const sorted = [...coeffs].sort((a, b) => a - b);
  const median = (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2;

  // 63 coefficienti + 1 bit di padding costante = 64 bit
  const bits = coeffs.map((c) => (c > median ? 1 : 0));
  bits.push(0);

  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
  }
  return hex;
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** Entropia di Shannon sull'istogramma di luminanza (bit/pixel). */
export function lumaEntropy(img: RgbaImage): number {
  const luma = toLuma(img);
  const hist = new Float64Array(256);
  for (let i = 0; i < luma.length; i++) hist[Math.min(255, Math.max(0, Math.round(luma[i])))]++;
  let e = 0;
  for (let i = 0; i < 256; i++) {
    if (!hist[i]) continue;
    const p = hist[i] / luma.length;
    e -= p * Math.log2(p);
  }
  return e;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function fingerprintImage(
  bytes: Uint8Array,
  img: RgbaImage,
): Promise<ImageFingerprint> {
  return {
    sha256: await sha256Hex(bytes),
    phash: phashFromRgba(img),
    width: img.width,
    height: img.height,
    bytes: bytes.length,
    entropy: lumaEntropy(img),
    algo: PHASH_ALGO,
  };
}

/* ── scarti: immagini che non possono essere prova ──────────────────────── */

export type RejectReason =
  | "TROPPO_PICCOLA"
  | "BASSA_ENTROPIA"
  | "MATERIALE_GENERICO"
  | null;

export function rejectFingerprint(
  fp: Pick<ImageFingerprint, "width" | "height" | "entropy">,
  reuseCount = 1,
): RejectReason {
  if (Math.min(fp.width, fp.height) < MIN_IMAGE_SIDE) return "TROPPO_PICCOLA";
  if (fp.entropy < MIN_LUMA_ENTROPY) return "BASSA_ENTROPIA";
  if (reuseCount >= GENERIC_REUSE_THRESHOLD) return "MATERIALE_GENERICO";
  return null;
}

export function isPhotoMatch(a: string, b: string): boolean {
  return hammingDistance(a, b) <= PHASH_MATCH_MAX_DISTANCE;
}
