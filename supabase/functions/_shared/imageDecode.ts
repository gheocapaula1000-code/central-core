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

async function loadJpeg(): Promise<{ decode: (b: Uint8Array, o?: unknown) => { width: number; height: number; data: Uint8Array } }> {
  const spec = isDeno ? "npm:jpeg-js@0.4.4" : "jpeg-js";
  const mod = await import(/* @vite-ignore */ spec) as Record<string, unknown>;
  const m = (mod.default ?? mod) as { decode: (b: Uint8Array, o?: unknown) => { width: number; height: number; data: Uint8Array } };
  return m;
}

async function loadPng(): Promise<{ decode: (b: Uint8Array) => { width: number; height: number; data: Uint8Array | Uint16Array; channels: number } }> {
  const spec = isDeno ? "npm:fast-png@6.2.0" : "fast-png";
  const mod = await import(/* @vite-ignore */ spec) as Record<string, unknown>;
  return (mod.default ?? mod) as { decode: (b: Uint8Array) => { width: number; height: number; data: Uint8Array | Uint16Array; channels: number } };
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

/** Decodifica JPEG/PNG in RGBA. Ritorna null (fail closed) su qualunque errore. */
export async function decodeImage(bytes: Uint8Array): Promise<DecodedImage | null> {
  const format = sniffImageFormat(bytes);
  if (!isDecodableFormat(format)) return null;
  try {
    if (format === "jpeg") {
      const jpeg = await loadJpeg();
      const img = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 64 });
      if (!img?.width || !img?.height) return null;
      return { width: img.width, height: img.height, data: new Uint8Array(img.data), format };
    }
    const png = await loadPng();
    const img = png.decode(bytes);
    if (!img?.width || !img?.height) return null;
    const depth16 = img.data instanceof Uint16Array;
    const channels = img.channels ?? (img.data.length / (img.width * img.height));
    return {
      width: img.width,
      height: img.height,
      data: toRgba(img.data, img.width, img.height, Math.round(channels), depth16),
      format,
    };
  } catch {
    return null;
  }
}
