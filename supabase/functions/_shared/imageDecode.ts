// _shared/imageDecode.ts — decodifica difensiva dei soli formati supportati.
//
// Il fingerprint deve nascere dai BYTE REALI: qui i byte diventano RGBA.
// Formati non decodificabili (webp, avif, gif, sconosciuti) => fail closed:
// nessuna eccezione silenziosa, nessuna promozione.

export type ImageFormat = "jpeg" | "png" | "webp" | "avif" | "gif" | "unknown";

export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8Array;
  format: ImageFormat;
}

/** Riconosce il formato dai magic bytes, mai dall'estensione dell'URL. */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat {
  if (bytes.length < 12) return "unknown";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "png";
  const ascii = (i: number, s: string) =>
    s.split("").every((c, k) => bytes[i + k] === c.charCodeAt(0));
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
  if (ascii(4, "ftyp") && (ascii(8, "avif") || ascii(8, "avis"))) return "avif";
  if (ascii(0, "GIF8")) return "gif";
  return "unknown";
}

export function isDecodableFormat(format: ImageFormat): boolean {
  return format === "jpeg" || format === "png";
}

const isDeno = typeof (globalThis as { Deno?: unknown }).Deno !== "undefined";

export interface JpegDecoder {
  decode: (b: Uint8Array, o?: unknown) => { width: number; height: number; data: Uint8Array };
}
export interface PngDecoder {
  decode: (b: Uint8Array) => {
    width: number;
    height: number;
    data: Uint8Array | Uint16Array;
    channels: number;
  };
}
/**
 * Decoder iniettabili: l'edge runtime NON risolve import dinamici con
 * specifier variabile, quindi la funzione edge passa i moduli importati
 * staticamente. In Node/test si usa il fallback dinamico.
 */
export interface Decoders {
  jpeg?: JpegDecoder;
  png?: PngDecoder;
}

async function loadJpeg(): Promise<JpegDecoder> {
  const spec = isDeno ? "npm:jpeg-js@0.4.4" : "jpeg-js";
  const mod = await import(/* @vite-ignore */ spec) as Record<string, unknown>;
  return (mod.default ?? mod) as JpegDecoder;
}

async function loadPng(): Promise<PngDecoder> {
  const spec = isDeno ? "npm:fast-png@8.0.0" : "fast-png";
  const mod = await import(/* @vite-ignore */ spec) as Record<string, unknown>;
  return (mod.default ?? mod) as PngDecoder;
}

function toRgba(
  data: Uint8Array | Uint16Array,
  width: number,
  height: number,
  channels: number,
  depth16: boolean,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const scale = depth16 ? 1 / 257 : 1;
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const s = i * channels;
    const r = Math.round(Number(data[s]) * scale);
    const g = channels >= 3 ? Math.round(Number(data[s + 1]) * scale) : r;
    const b = channels >= 3 ? Math.round(Number(data[s + 2]) * scale) : r;
    const a = channels === 4 || channels === 2 ? Math.round(Number(data[s + channels - 1]) * scale) : 255;
    out[p] = r;
    out[p + 1] = g;
    out[p + 2] = b;
    out[p + 3] = a;
  }
  return out;
}

export interface DecodeOutcome {
  image: DecodedImage | null;
  /** Motivo verificabile del fallimento (diagnostica, mai promozione). */
  reason: string | null;
}

/** Decodifica JPEG/PNG in RGBA riportando il motivo del fallimento. */
export async function decodeImageWithReason(
  bytes: Uint8Array,
  decoders: Decoders = {},
): Promise<DecodeOutcome> {
  const format = sniffImageFormat(bytes);
  if (!isDecodableFormat(format)) return { image: null, reason: `FORMATO_NON_SUPPORTATO_${format}` };
  try {
    if (format === "jpeg") {
      const jpeg = decoders.jpeg ?? await loadJpeg();
      const img = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 64 });
      if (!img?.width || !img?.height) return { image: null, reason: "JPEG_DIMENSIONI_ASSENTI" };
      return {
        image: { width: img.width, height: img.height, data: new Uint8Array(img.data), format },
        reason: null,
      };
    }
    const png = decoders.png ?? await loadPng();
    const img = png.decode(bytes);
    if (!img?.width || !img?.height) return { image: null, reason: "PNG_DIMENSIONI_ASSENTI" };
    const depth16 = img.data instanceof Uint16Array;
    const channels = img.channels ?? (img.data.length / (img.width * img.height));
    return {
      image: {
        width: img.width,
        height: img.height,
        data: toRgba(img.data, img.width, img.height, Math.round(channels), depth16),
        format,
      },
      reason: null,
    };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    return { image: null, reason: `${format.toUpperCase()}_ERRORE_${msg.slice(0, 120)}` };
  }
}

/** Decodifica JPEG/PNG in RGBA. Ritorna null (fail closed) su qualunque errore. */
export async function decodeImage(
  bytes: Uint8Array,
  decoders: Decoders = {},
): Promise<DecodedImage | null> {
  return (await decodeImageWithReason(bytes, decoders)).image;
}
