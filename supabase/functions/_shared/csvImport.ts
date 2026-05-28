// _shared/csvImport.ts — parser CSV minimale per importer admin.
// Supporta header riga 1, separatore , o ;, quoting ".

export type CsvRow = Record<string, string>;

export function parseCsv(input: string): CsvRow[] {
  const text = input.replace(/^\uFEFF/, "").trim();
  if (!text) return [];

  // Detect separator: , vs ;
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";

  const rows = parseRows(text, sep);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const out: CsvRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 1 && r[0] === "") continue;
    const obj: CsvRow = {};
    for (let j = 0; j < header.length; j++) {
      obj[header[j]] = (r[j] ?? "").trim();
    }
    out.push(obj);
  }
  return out;
}

function parseRows(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === sep) { cur.push(field); field = ""; }
      else if (c === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  cur.push(field);
  if (cur.length > 1 || cur[0] !== "") rows.push(cur);
  return rows;
}

export function toIntOrNull(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v.replace(/\./g, "").replace(/,/g, "."));
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function toNumberOrNull(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v.replace(/\./g, "").replace(/,/g, "."));
  return Number.isFinite(n) ? n : null;
}
