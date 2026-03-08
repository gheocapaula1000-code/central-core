// ISTAT/ISPRA Import from Storage — Edge Function
// Reads CSV from storage bucket and imports into istat_comuni or ispra_rischio tables
// Separator: ;

import {
  handleOptions,
  ok,
  fail,
  makeDebugId,
} from "../_shared/http.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BATCH_SIZE = 500;

const ISTAT_FIELDS = [
  "codice_istat", "comune", "popolazione", "eta_media",
  "percentuale_under18", "percentuale_under35", "percentuale_over65",
  "maschi", "femmine", "anno",
];

const ISPRA_FIELDS = [
  "codice_istat", "comune", "superficie_kmq",
  "idro_p3_perc", "idro_p2_perc", "idro_p1_perc",
  "pop_idro_p3", "pop_idro_p2", "pop_idro_p1",
  "frana_p4_perc", "frana_p3_perc", "frana_p2_perc", "frana_p1_perc",
  "pop_frana_p3p4",
];

const NUMERIC_FIELDS = new Set([
  "popolazione", "eta_media", "percentuale_under18", "percentuale_under35",
  "percentuale_over65", "maschi", "femmine", "anno",
  "superficie_kmq", "idro_p3_perc", "idro_p2_perc", "idro_p1_perc",
  "pop_idro_p3", "pop_idro_p2", "pop_idro_p1",
  "frana_p4_perc", "frana_p3_perc", "frana_p2_perc", "frana_p1_perc",
  "pop_frana_p3p4",
]);

const INTEGER_FIELDS = new Set([
  "popolazione", "maschi", "femmine", "anno",
  "pop_idro_p3", "pop_idro_p2", "pop_idro_p1", "pop_frana_p3p4",
]);

function cleanValue(val: string): string {
  return val.replace(/^'+|'+$/g, "").trim();
}

function parseNumeric(val: string, isInteger: boolean): number | null {
  const cleaned = cleanValue(val);
  if (!cleaned || cleaned === "-" || cleaned === "") return null;
  const normalized = cleaned.replace(",", ".");
  const num = isInteger ? parseInt(normalized, 10) : parseFloat(normalized);
  return isNaN(num) ? null : num;
}

function parseCSV(csv: string, fields: string[]): Record<string, unknown>[] {
  const lines = csv.split("\n").filter((l) => l.trim());
  // First line is headers
  const dataLines = lines.slice(1);
  const rows: Record<string, unknown>[] = [];

  for (const line of dataLines) {
    const values = line.split(";");
    if (values.length < fields.length) continue;

    const row: Record<string, unknown> = {};
    let valid = true;
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const raw = values[i] ?? "";
      if (NUMERIC_FIELDS.has(field)) {
        row[field] = parseNumeric(raw, INTEGER_FIELDS.has(field));
      } else {
        const cleaned = cleanValue(raw) || null;
        row[field] = cleaned;
        if ((field === "codice_istat" || field === "comune") && !cleaned) {
          valid = false;
        }
      }
    }
    if (valid) rows.push(row);
  }
  return rows;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = makeDebugId();

  if (req.method !== "POST") {
    return fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId);
  }

  try {
    const body = await req.json();
    const table = body.table as string;
    const storagePath = body.storage_path as string;
    const clearFirst = body.clear_first as boolean ?? false;

    if (!table || !storagePath) {
      return fail(req, 400, "MISSING_FIELDS", "Provide table and storage_path", debugId);
    }
    if (table !== "istat_comuni" && table !== "ispra_rischio") {
      return fail(req, 400, "INVALID_TABLE", "table must be istat_comuni or ispra_rischio", debugId);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, serviceKey);

    console.log(`[istat-ispra-import] Downloading ${storagePath}`);
    const { data: fileData, error: dlError } = await supabase.storage
      .from("csv-imports")
      .download(storagePath);

    if (dlError || !fileData) {
      return fail(req, 400, "DOWNLOAD_ERROR", `Failed to download: ${dlError?.message}`, debugId);
    }

    const csv = await fileData.text();
    console.log(`[istat-ispra-import] CSV size: ${csv.length} chars`);

    const fields = table === "istat_comuni" ? ISTAT_FIELDS : ISPRA_FIELDS;
    const rows = parseCSV(csv, fields);

    if (rows.length === 0) {
      return fail(req, 400, "EMPTY_CSV", "No valid rows found", debugId);
    }

    console.log(`[istat-ispra-import] Parsed ${rows.length} rows for ${table}`);

    if (clearFirst) {
      const { error: delErr } = await supabase.from(table).delete().gte("id", 0);
      if (delErr) console.error(`[istat-ispra-import] Clear error: ${delErr.message}`);
    }

    let inserted = 0;
    let errors = 0;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from(table).insert(batch);
      if (error) {
        console.error(`[istat-ispra-import] Batch ${Math.floor(i / BATCH_SIZE)} error:`, error.message);
        errors += batch.length;
      } else {
        inserted += batch.length;
      }
    }

    console.log(`[istat-ispra-import] Done: ${inserted} inserted, ${errors} errors`);
    return ok(req, { table, totalRows: rows.length, inserted, errors }, [], debugId);
  } catch (e) {
    return fail(req, 500, "IMPORT_ERROR", `Import failed: ${String(e).slice(0, 500)}`, debugId);
  }
});
