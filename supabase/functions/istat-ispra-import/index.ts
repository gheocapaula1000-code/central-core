// ISTAT/ISPRA/Sismica Import from Storage — Edge Function
// Reads CSV from storage bucket and imports into istat_comuni, ispra_rischio, or classificazione_sismica
// Protected by AI_CORE_SECRET + origin policy

import {
  handleOptions,
  ok,
  fail,
  makeDebugId,
  requireSecret,
  enforceOriginPolicy,
} from "../_shared/http.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BATCH_SIZE = 500;

const TABLE_CONFIG: Record<string, { fields: string[]; numeric: Set<string>; integer: Set<string> }> = {
  istat_comuni: {
    fields: ["codice_istat", "comune", "popolazione", "eta_media", "percentuale_under18", "percentuale_under35", "percentuale_over65", "maschi", "femmine", "anno"],
    numeric: new Set(["popolazione", "eta_media", "percentuale_under18", "percentuale_under35", "percentuale_over65", "maschi", "femmine", "anno"]),
    integer: new Set(["popolazione", "maschi", "femmine", "anno"]),
  },
  ispra_rischio: {
    fields: ["codice_istat", "comune", "superficie_kmq", "idro_p3_perc", "idro_p2_perc", "idro_p1_perc", "pop_idro_p3", "pop_idro_p2", "pop_idro_p1", "frana_p4_perc", "frana_p3_perc", "frana_p2_perc", "frana_p1_perc", "pop_frana_p3p4"],
    numeric: new Set(["superficie_kmq", "idro_p3_perc", "idro_p2_perc", "idro_p1_perc", "pop_idro_p3", "pop_idro_p2", "pop_idro_p1", "frana_p4_perc", "frana_p3_perc", "frana_p2_perc", "frana_p1_perc", "pop_frana_p3p4"]),
    integer: new Set(["pop_idro_p3", "pop_idro_p2", "pop_idro_p1", "pop_frana_p3p4"]),
  },
  classificazione_sismica: {
    fields: ["codice_istat", "comune", "zona_sismica"],
    numeric: new Set(["zona_sismica"]),
    integer: new Set(["zona_sismica"]),
  },
};

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

function parseCSV(csv: string, fields: string[], numericFields: Set<string>, integerFields: Set<string>): Record<string, unknown>[] {
  const lines = csv.split("\n").filter((l) => l.trim());
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
      if (numericFields.has(field)) {
        row[field] = parseNumeric(raw, integerFields.has(field));
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

  // Origin policy
  const originErr = enforceOriginPolicy(req, debugId);
  if (originErr) return originErr;

  // Auth guard — before any service-role usage
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
    const config = TABLE_CONFIG[table];
    if (!config) {
      return fail(req, 400, "INVALID_TABLE", `table must be one of: ${Object.keys(TABLE_CONFIG).join(", ")}`, debugId);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, serviceKey);

    console.log(`[istat-ispra-import] Downloading ${storagePath}`);
    const { data: fileData, error: dlError } = await supabase.storage
      .from("csv-imports")
      .download(storagePath);

    if (dlError || !fileData) {
      return fail(req, 400, "DOWNLOAD_ERROR", "Failed to download file from storage", debugId);
    }

    const csv = await fileData.text();
    console.log(`[istat-ispra-import] CSV size: ${csv.length} chars`);

    const rows = parseCSV(csv, config.fields, config.numeric, config.integer);

    if (rows.length === 0) {
      return fail(req, 400, "EMPTY_CSV", "No valid rows found", debugId);
    }

    console.log(`[istat-ispra-import] Parsed ${rows.length} rows for ${table}`);

    if (clearFirst) {
      const { error: delErr } = await supabase.from(table).delete().gte("id", 0);
      if (delErr) console.error(`[istat-ispra-import] Clear error`);
    }

    let inserted = 0;
    let errors = 0;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from(table).insert(batch);
      if (error) {
        console.error(`[istat-ispra-import] Batch ${Math.floor(i / BATCH_SIZE)} error`);
        errors += batch.length;
      } else {
        inserted += batch.length;
      }
    }

    console.log(`[istat-ispra-import] Done: ${inserted} inserted, ${errors} errors`);
    return ok(req, { table, totalRows: rows.length, inserted, errors }, [], debugId);
  } catch (_e) {
    console.error(`[istat-ispra-import] Import failed debug_id=${debugId}`);
    return fail(req, 500, "IMPORT_ERROR", `Import failed. Reference: ${debugId}`, debugId);
  }
});
