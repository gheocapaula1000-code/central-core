// ── Format detection & parsers for KMZ/KML/GML/GeoJSON ──

// ── JSZip-like KMZ extraction using Deno built-in ──
// KMZ = ZIP containing doc.kml

export type GeoJSONFeatureCollection = {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
};

export type GeoJSONFeature = {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
};

export type FileType = "geojson" | "kml" | "gml" | "kmz" | "zip" | "unknown";

/** Detect file type from extension and content sniffing */
export function detectFileType(path: string, content: Uint8Array): FileType {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "geojson" || ext === "json") return "geojson";
  if (ext === "kml") return "kml";
  if (ext === "gml") return "gml";
  if (ext === "kmz") return "kmz";

  // Content sniffing
  const head = new TextDecoder().decode(content.slice(0, 500));
  if (head.trimStart().startsWith("{")) return "geojson";
  if (head.includes("<kml")) return "kml";
  if (head.includes("<gml:") || head.includes("ogr:FeatureCollection")) return "gml";
  // ZIP magic bytes PK\x03\x04
  if (content[0] === 0x50 && content[1] === 0x4B) return "kmz";

  return "unknown";
}

/** Extract KML content from KMZ (ZIP) bytes */
export async function extractKmlFromKmz(data: Uint8Array): Promise<string> {
  // Use fflate for ZIP extraction in Deno
  // KMZ is a ZIP with a .kml file inside (usually doc.kml)
  // We'll use a minimal ZIP parser

  const entries = parseZipEntries(data);
  const kmlEntry = entries.find(e => e.name.toLowerCase().endsWith(".kml"));
  if (!kmlEntry) {
    throw new Error("KMZ archive does not contain a .kml file");
  }
  return new TextDecoder().decode(kmlEntry.data);
}

/** Minimal ZIP entry parser — handles stored and deflated entries */
interface ZipEntry { name: string; data: Uint8Array; }

function parseZipEntries(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const entries: ZipEntry[] = [];
  let offset = 0;

  while (offset < zip.length - 4) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break; // local file header signature

    const method = view.getUint16(offset + 8, true);
    const compSize = view.getUint32(offset + 18, true);
    const uncompSize = view.getUint32(offset + 22, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(zip.slice(offset + 30, offset + 30 + nameLen));
    const dataStart = offset + 30 + nameLen + extraLen;

    const rawData = zip.slice(dataStart, dataStart + compSize);

    let fileData: Uint8Array;
    if (method === 0) {
      // Stored
      fileData = rawData;
    } else if (method === 8) {
      // Deflated — use DecompressionStream
      fileData = decompressDeflateSync(rawData, uncompSize);
    } else {
      // Skip unsupported methods
      offset = dataStart + compSize;
      continue;
    }

    if (!name.endsWith("/")) {
      entries.push({ name, data: fileData });
    }
    offset = dataStart + compSize;
  }
  return entries;
}

function decompressDeflateSync(data: Uint8Array, _expectedSize: number): Uint8Array {
  // In Deno, we can use DecompressionStream but it's async.
  // For edge functions, use a raw inflate approach.
  // We'll wrap in a sync-compatible way using the Deno built-in.
  // Actually, since the caller is async, let's make this async too.
  // But parseZipEntries is sync... let's restructure.
  // For now, throw and handle async in extractKmlFromKmz.
  throw new Error("NEEDS_ASYNC_DECOMPRESS");
}

/** Async KMZ extraction with proper decompression */
export async function extractKmlFromKmzAsync(data: Uint8Array): Promise<string> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  while (offset < data.length - 4) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break;

    const method = view.getUint16(offset + 8, true);
    const compSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(data.slice(offset + 30, offset + 30 + nameLen));
    const dataStart = offset + 30 + nameLen + extraLen;
    const rawData = data.slice(dataStart, dataStart + compSize);

    if (name.toLowerCase().endsWith(".kml")) {
      if (method === 0) {
        return new TextDecoder().decode(rawData);
      } else if (method === 8) {
        // Add raw deflate wrapper for DecompressionStream (needs zlib header)
        const ds = new DecompressionStream("raw");
        const writer = ds.writable.getWriter();
        writer.write(rawData);
        writer.close();
        const reader = ds.readable.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const totalLen = chunks.reduce((s, c) => s + c.length, 0);
        const result = new Uint8Array(totalLen);
        let pos = 0;
        for (const chunk of chunks) { result.set(chunk, pos); pos += chunk.length; }
        return new TextDecoder().decode(result);
      }
    }
    offset = dataStart + compSize;
  }
  throw new Error("KMZ archive does not contain a .kml file");
}

// ── KML to GeoJSON converter ──

export function kmlToGeoJSON(kml: string): GeoJSONFeatureCollection {
  const features: GeoJSONFeature[] = [];

  // Extract Placemarks
  const placemarkRegex = /<Placemark[\s>]([\s\S]*?)<\/Placemark>/gi;
  let match;
  while ((match = placemarkRegex.exec(kml)) !== null) {
    const block = match[1];
    const feature = parsePlacemark(block);
    if (feature) features.push(feature);
  }

  return { type: "FeatureCollection", features };
}

function parsePlacemark(block: string): GeoJSONFeature | null {
  const properties: Record<string, unknown> = {};

  // Extract name
  const nameMatch = block.match(/<name>([\s\S]*?)<\/name>/i);
  if (nameMatch) properties.name = nameMatch[1].trim();

  // Extract ExtendedData / SimpleData
  const simpleDataRegex = /<SimpleData name="([^"]*)">([\s\S]*?)<\/SimpleData>/gi;
  let sdMatch;
  while ((sdMatch = simpleDataRegex.exec(block)) !== null) {
    properties[sdMatch[1]] = sdMatch[2].trim();
  }

  // Extract Data elements
  const dataRegex = /<Data name="([^"]*)">\s*<value>([\s\S]*?)<\/value>\s*<\/Data>/gi;
  let dMatch;
  while ((dMatch = dataRegex.exec(block)) !== null) {
    properties[dMatch[1]] = dMatch[2].trim();
  }

  // Extract geometry
  const geometry = extractGeometry(block);
  if (!geometry) return null;

  return { type: "Feature", properties, geometry };
}

function extractGeometry(block: string): { type: string; coordinates: unknown } | null {
  // Try Polygon
  const polyMatch = block.match(/<Polygon[\s>]([\s\S]*?)<\/Polygon>/i);
  if (polyMatch) {
    const coords = extractPolygonCoords(polyMatch[1]);
    if (coords) return { type: "Polygon", coordinates: coords };
  }

  // Try MultiGeometry with Polygons
  const multiMatch = block.match(/<MultiGeometry[\s>]([\s\S]*?)<\/MultiGeometry>/i);
  if (multiMatch) {
    const polygons: number[][][][] = [];
    const innerPolyRegex = /<Polygon[\s>]([\s\S]*?)<\/Polygon>/gi;
    let pm;
    while ((pm = innerPolyRegex.exec(multiMatch[1])) !== null) {
      const coords = extractPolygonCoords(pm[1]);
      if (coords) polygons.push(coords);
    }
    if (polygons.length > 0) return { type: "MultiPolygon", coordinates: polygons };
  }

  return null;
}

function extractPolygonCoords(polygonBlock: string): number[][][] | null {
  const rings: number[][] [] = [];

  // outerBoundaryIs
  const outerMatch = polygonBlock.match(/<outerBoundaryIs[\s>][\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i);
  if (!outerMatch) return null;
  const outerRing = parseCoordinateString(outerMatch[1]);
  if (outerRing.length < 4) return null;
  rings.push(outerRing);

  // innerBoundaryIs (holes)
  const innerRegex = /<innerBoundaryIs[\s>][\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/gi;
  let innerMatch;
  while ((innerMatch = innerRegex.exec(polygonBlock)) !== null) {
    const ring = parseCoordinateString(innerMatch[1]);
    if (ring.length >= 4) rings.push(ring);
  }

  return rings;
}

function parseCoordinateString(coordStr: string): number[][] {
  return coordStr.trim().split(/\s+/).map(tuple => {
    const parts = tuple.split(",").map(Number);
    // KML is lon,lat,alt — GeoJSON is [lon, lat]
    return [parts[0], parts[1]];
  }).filter(p => !isNaN(p[0]) && !isNaN(p[1]));
}

// ── GML to GeoJSON converter ──

export function gmlToGeoJSON(gml: string): GeoJSONFeatureCollection {
  const features: GeoJSONFeature[] = [];

  // Match featureMember or featureMembers blocks
  const memberRegex = /<(?:gml:)?featureMember[\s>]([\s\S]*?)<\/(?:gml:)?featureMember>/gi;
  let match;
  while ((match = memberRegex.exec(gml)) !== null) {
    const feature = parseGmlFeature(match[1]);
    if (feature) features.push(feature);
  }

  return { type: "FeatureCollection", features };
}

function parseGmlFeature(block: string): GeoJSONFeature | null {
  const properties: Record<string, unknown> = {};

  // Extract simple property elements (non-geometry)
  const propRegex = /<(?:\w+:)?(\w+)>([^<]+)<\/(?:\w+:)?\1>/g;
  let pm;
  while ((pm = propRegex.exec(block)) !== null) {
    const tag = pm[1];
    if (!["coordinates", "posList", "pos", "Polygon", "MultiSurface", "exterior", "interior", "LinearRing"].includes(tag)) {
      properties[tag] = pm[2].trim();
    }
  }

  // Extract geometry — look for Polygon or MultiSurface
  const geometry = extractGmlGeometry(block);
  if (!geometry) return null;

  return { type: "Feature", properties, geometry };
}

function extractGmlGeometry(block: string): { type: string; coordinates: unknown } | null {
  // Try gml:MultiSurface / MultiPolygon
  const multiMatch = block.match(/<(?:gml:)?(?:MultiSurface|MultiPolygon)[\s>]([\s\S]*?)<\/(?:gml:)?(?:MultiSurface|MultiPolygon)>/i);
  if (multiMatch) {
    const polygons: number[][][][] = [];
    const surfaceRegex = /<(?:gml:)?(?:Polygon|surfaceMember)[\s>]([\s\S]*?)<\/(?:gml:)?(?:Polygon|surfaceMember)>/gi;
    let sm;
    while ((sm = surfaceRegex.exec(multiMatch[1])) !== null) {
      const coords = extractGmlPolygonCoords(sm[1]);
      if (coords) polygons.push(coords);
    }
    if (polygons.length > 0) return { type: "MultiPolygon", coordinates: polygons };
  }

  // Try single Polygon
  const polyMatch = block.match(/<(?:gml:)?Polygon[\s>]([\s\S]*?)<\/(?:gml:)?Polygon>/i);
  if (polyMatch) {
    const coords = extractGmlPolygonCoords(polyMatch[1]);
    if (coords) return { type: "Polygon", coordinates: coords };
  }

  return null;
}

function extractGmlPolygonCoords(block: string): number[][][] | null {
  const rings: number[][] [] = [];

  // exterior
  const extMatch = block.match(/<(?:gml:)?exterior[\s>]([\s\S]*?)<\/(?:gml:)?exterior>/i);
  if (extMatch) {
    const ring = extractGmlRingCoords(extMatch[1]);
    if (ring && ring.length >= 4) rings.push(ring);
  }

  if (rings.length === 0) {
    // Try posList/coordinates directly
    const ring = extractGmlRingCoords(block);
    if (ring && ring.length >= 4) rings.push(ring);
  }

  if (rings.length === 0) return null;

  // interior (holes)
  const intRegex = /<(?:gml:)?interior[\s>]([\s\S]*?)<\/(?:gml:)?interior>/gi;
  let intMatch;
  while ((intMatch = intRegex.exec(block)) !== null) {
    const ring = extractGmlRingCoords(intMatch[1]);
    if (ring && ring.length >= 4) rings.push(ring);
  }

  return rings;
}

function extractGmlRingCoords(block: string): number[][] | null {
  // Try posList
  const posListMatch = block.match(/<(?:gml:)?posList[^>]*>([\s\S]*?)<\/(?:gml:)?posList>/i);
  if (posListMatch) {
    const nums = posListMatch[1].trim().split(/\s+/).map(Number);
    const coords: number[][] = [];
    // GML posList is typically lat lon pairs (or x y)
    for (let i = 0; i < nums.length - 1; i += 2) {
      // GML default is lat,lon — GeoJSON is lon,lat
      coords.push([nums[i + 1], nums[i]]);
    }
    return coords.length >= 4 ? coords : null;
  }

  // Try coordinates (some GML variants)
  const coordMatch = block.match(/<(?:gml:)?coordinates[^>]*>([\s\S]*?)<\/(?:gml:)?coordinates>/i);
  if (coordMatch) {
    return parseCoordinateString(coordMatch[1]);
  }

  return null;
}
