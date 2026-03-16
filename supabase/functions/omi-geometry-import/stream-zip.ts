// ── Streaming ZIP parser for large archives ──
// Processes entries one at a time without loading the entire file into memory.
// Uses ReadableStream to avoid OOM on large files (100MB+).

export interface StreamZipEntry {
  name: string;
  data: Uint8Array;
}

const VALID_EXTENSIONS = new Set(["geojson", "json", "kml", "gml", "kmz"]);
const IGNORED_PREFIXES = ["__MACOSX", ".DS_Store", "Thumbs.db"];

/** Buffered reader over a ReadableStream — reads exact byte counts */
class BufferedStreamReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer: Uint8Array = new Uint8Array(0);
  private eof = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async read(n: number): Promise<Uint8Array> {
    while (this.buffer.length < n && !this.eof) {
      const { done, value } = await this.reader.read();
      if (done) { this.eof = true; break; }
      const merged = new Uint8Array(this.buffer.length + value.length);
      merged.set(this.buffer);
      merged.set(value, this.buffer.length);
      this.buffer = merged;
    }
    if (this.buffer.length < n) throw new Error("ZIP_EOF");
    const result = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n);
    return result;
  }

  async skip(n: number): Promise<void> {
    let rem = n;
    if (this.buffer.length >= rem) {
      this.buffer = this.buffer.slice(rem);
      return;
    }
    rem -= this.buffer.length;
    this.buffer = new Uint8Array(0);
    while (rem > 0 && !this.eof) {
      const { done, value } = await this.reader.read();
      if (done) { this.eof = true; return; }
      if (value.length <= rem) {
        rem -= value.length;
      } else {
        this.buffer = value.slice(rem);
        rem = 0;
      }
    }
  }

  release() {
    try { this.reader.releaseLock(); } catch { /* ignore */ }
  }
}

async function decompressRawDeflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw" as CompressionFormat);
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { result.set(c, pos); pos += c.length; }
  return result;
}

/**
 * Stream through a ZIP archive, yielding valid geo file entries one at a time.
 * Supports offset/limit for batched processing of large archives.
 * 
 * @param stream - ReadableStream of the ZIP file bytes
 * @param opts.offset - Skip this many valid geo entries before yielding
 * @param opts.limit - Maximum entries to yield
 */
export async function* streamZipEntries(
  stream: ReadableStream<Uint8Array>,
  opts: { offset?: number; limit?: number } = {},
): AsyncGenerator<StreamZipEntry> {
  const reader = new BufferedStreamReader(stream);
  const skipCount = opts.offset ?? 0;
  const maxYield = opts.limit ?? Infinity;
  let validIndex = 0;
  let yielded = 0;

  try {
    while (yielded < maxYield) {
      let header: Uint8Array;
      try {
        header = await reader.read(30);
      } catch {
        break; // End of stream
      }

      const view = new DataView(header.buffer, header.byteOffset, 30);
      const sig = view.getUint32(0, true);

      // Not a local file header — central directory or end
      if (sig !== 0x04034b50) break;

      const method = view.getUint16(8, true);
      const compSize = view.getUint32(18, true);
      const nameLen = view.getUint16(26, true);
      const extraLen = view.getUint16(28, true);

      const nameBytes = await reader.read(nameLen);
      const name = new TextDecoder().decode(nameBytes);
      if (extraLen > 0) await reader.skip(extraLen);

      const isDir = name.endsWith("/");
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      const isGeo = VALID_EXTENSIONS.has(ext);
      const isJunk = IGNORED_PREFIXES.some(p => name.startsWith(p) || name.includes("/" + p));

      // Skip non-geo, directories, junk, zero-length
      if (isDir || !isGeo || isJunk || compSize === 0) {
        if (compSize > 0) await reader.skip(compSize);
        continue;
      }

      // This is a valid geo entry
      if (validIndex < skipCount) {
        // Before offset — skip data efficiently
        await reader.skip(compSize);
        validIndex++;
        continue;
      }

      // Read and decompress
      const rawData = await reader.read(compSize);
      let fileData: Uint8Array;

      if (method === 0) {
        fileData = rawData;
      } else if (method === 8) {
        try {
          fileData = await decompressRawDeflate(rawData);
        } catch (e) {
          console.error(`[stream-zip] Decompression failed: ${name}: ${e}`);
          validIndex++;
          continue;
        }
      } else {
        console.log(`[stream-zip] Unsupported method ${method}: ${name}`);
        validIndex++;
        continue;
      }

      yield { name, data: fileData };
      validIndex++;
      yielded++;
    }
  } finally {
    reader.release();
  }
}
