// OMI Import from Storage — Edge Function
// Reads CSV from storage bucket and imports into omi_zone or omi_valori tables
// Protected by AI_CORE_SECRET

import {
  handleOptions,
  ok,
  fail,
  makeDebugId,
  requireSecret,
} from "../_shared/http.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BATCH_SIZE = 500;

const ZONE_FIELDS = [
  "area_territoriale", "regione", "provincia", "comune_istat",
  "comune_catastale", "sezione", "comune_amm", "comune_descrizione",
  "fascia", "zona_descr", "zona", "link_zona",
  "cod_tip_prev", "descr_tip_prev", "stato_prev", "microzona",
];

const VALORI_FIELDS = [
  "area_territoriale", "regione", "provincia", "comune_istat",
  "comune_catastale", "sezione", "comune_amm", "comune_descrizione",
  "fascia", "zona", "link_zona", "cod_tip", "descr_tipologia",
  "stato", "stato_prev", "compr_min", "compr_max", "sup_nl_compr",
  "loc_min", "loc_max", "sup_nl_loc",
];

const NUMERIC_FIELDS = new Set([
  "cod_tip_prev", "microzona", "cod_tip",
  "compr_min", "compr_max", "loc_min", "loc_max",
]);

const INTEGER_FIELDS = new Set(["cod_tip_prev", "microzona", "cod_tip"]);

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
  // Skip first 2 lines: line 1 is title, line 2 is column headers
  const dataLines = lines.slice(2);
  const rows: Record<string, unknown>[] = [];

  for (const line of dataLines) {
    const values = line.split(";");
    if (values.length < fields.length) continue;

    const row: Record<string, unknown> = {};
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const raw = values[i] ?? "";
      if (NUMERIC_FIELDS.has(field)) {
        row[field] = parseNumeric(raw, INTEGER_FIELDS.has(field));
      } else {
        row[field] = cleanValue(raw) || null;
      }
    }
    rows.push(row);
  }
  return rows;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = makeDebugId();

  const authErr = requireSecret(req, debugId);
  if (authErr) return authErr;

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
    if (table !== "omi_zone" && table !== "omi_valori") {
      return fail(req, 400, "INVALID_TABLE", "table must be omi_zone or omi_valori", debugId);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, serviceKey);

    // Download CSV from storage
    console.log(`[omi-import-storage] Downloading ${storagePath} from csv-imports bucket`);
    const { data: fileData, error: dlError } = await supabase.storage
      .from("csv-imports")
      .download(storagePath);

    if (dlError || !fileData) {
      return fail(req, 400, "DOWNLOAD_ERROR", `Failed to download: ${dlError?.message}`, debugId);
    }

    const csv = await fileData.text();
    console.log(`[omi-import-storage] CSV size: ${csv.length} chars`);

    const fields = table === "omi_zone" ? ZONE_FIELDS : VALORI_FIELDS;
    const rows = parseCSV(csv, fields);

    if (rows.length === 0) {
      return fail(req, 400, "EMPTY_CSV", "No valid rows found in CSV", debugId);
    }

    console.log(`[omi-import-storage] Parsed ${rows.length} rows for ${table}`);

    // Optionally clear existing data
    if (clearFirst) {
      console.log(`[omi-import-storage] Clearing existing data from ${table}`);
      const { error: delErr } = await supabase.from(table).delete().gte("id", 0);
      if (delErr) {
        console.error(`[omi-import-storage] Clear error: ${delErr.message}`);
      }
    }

    let inserted = 0;
    let errors = 0;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from(table).insert(batch);
      if (error) {
        console.error(`[omi-import-storage] Batch ${Math.floor(i / BATCH_SIZE)} error:`, error.message);
        errors += batch.length;
      } else {
        inserted += batch.length;
      }
      if (i % 5000 === 0) {
        console.log(`[omi-import-storage] Progress: ${i}/${rows.length}`);
      }
    }

    console.log(`[omi-import-storage] Done: table=${table} total=${rows.length} inserted=${inserted} errors=${errors}`);
    return ok(req, { table, totalRows: rows.length, inserted, errors }, [], debugId);
  } catch (e) {
    return fail(req, 500, "IMPORT_ERROR", `Import failed: ${String(e).slice(0, 500)}`, debugId);
  }
});
