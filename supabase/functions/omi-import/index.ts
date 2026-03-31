// OMI Import — Edge Function
// Receives CSV data and imports into omi_zone or omi_valori tables
// Protected by AI_CORE_SECRET

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

// CSV field mappings per table
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
  // Italian decimals: 7,5 → 7.5
  const normalized = cleaned.replace(",", ".");
  const num = isInteger ? parseInt(normalized, 10) : parseFloat(normalized);
  return isNaN(num) ? null : num;
}

function parseCSVLine(line: string): string[] {
  // Simple semicolon-separated parser
  return line.split(";");
}

function parseCSV(csv: string, fields: string[]): Record<string, unknown>[] {
  const lines = csv.split("\n").filter((l) => l.trim());
  // Skip header line
  const dataLines = lines.slice(1);
  const rows: Record<string, unknown>[] = [];

  for (const line of dataLines) {
    const values = parseCSVLine(line);
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

  // Origin policy — consistent with all other functions
  const originErr = enforceOriginPolicy(req, debugId);
  if (originErr) return originErr;

  const authErr = requireSecret(req, debugId);
  if (authErr) return authErr;

  if (req.method !== "POST") {
    return fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId);
  }

  try {
    const body = await req.json();
    const table = body.table as string;
    const csv = body.csv as string;

    if (!table || !csv) {
      return fail(req, 400, "MISSING_FIELDS", "Provide table and csv", debugId);
    }
    if (table !== "omi_zone" && table !== "omi_valori") {
      return fail(req, 400, "INVALID_TABLE", "table must be omi_zone or omi_valori", debugId);
    }

    const fields = table === "omi_zone" ? ZONE_FIELDS : VALORI_FIELDS;
    const rows = parseCSV(csv, fields);

    if (rows.length === 0) {
      return fail(req, 400, "EMPTY_CSV", "No valid rows found in CSV", debugId);
    }

    // Use service role to bypass RLS
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, serviceKey);

    let inserted = 0;
    let errors = 0;

    // Insert in batches
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from(table).insert(batch);
      if (error) {
        console.error(`[omi-import] Batch ${i / BATCH_SIZE} error:`, error.message);
        errors += batch.length;
      } else {
        inserted += batch.length;
      }
    }

    console.log(`[omi-import] table=${table} total=${rows.length} inserted=${inserted} errors=${errors}`);
    return ok(req, { table, totalRows: rows.length, inserted, errors }, [], debugId);
  } catch (e) {
    return fail(req, 500, "IMPORT_ERROR", `Import failed: ${String(e).slice(0, 200)}`, debugId);
  }
});
