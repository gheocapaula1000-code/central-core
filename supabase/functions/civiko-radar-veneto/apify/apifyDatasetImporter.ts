// Imports normalized Apify records into operational tables.
// dryRun=true never writes. import=true writes only to source_documents
// (other targets require their own dedicated mappers; we save raw evidence).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { ApifySourceBinding } from "./apifySourceRegistry.ts";
import type { NormalizedRecord } from "./apifyMapper.ts";

export interface ImportResult {
  attempted: number;
  inserted: number;
  skipped_existing: number;
  errors: string[];
}

export async function importApifyRecords(
  records: NormalizedRecord[],
  binding: ApifySourceBinding,
  opts: { dryRun: boolean; doImport: boolean },
): Promise<ImportResult> {
  const result: ImportResult = { attempted: records.length, inserted: 0, skipped_existing: 0, errors: [] };
  if (opts.dryRun || !opts.doImport) return result;
  if (records.length === 0) return result;

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) {
    result.errors.push("supabase_credentials_missing");
    return result;
  }
  const supa = createClient(url, key);

  for (const rec of records) {
    try {
      // Dedup by source_url
      const { data: existing } = await supa
        .from("source_documents")
        .select("id")
        .eq("source_url", rec.source_url)
        .limit(1)
        .maybeSingle();
      if (existing?.id) { result.skipped_existing++; continue; }

      const { error } = await supa.from("source_documents").insert({
        source_url: rec.source_url,
        url: rec.source_url,
        title: rec.title,
        markdown: rec.content,
        text_excerpt: rec.content ? rec.content.slice(0, 1000) : null,
        source_name: binding.source_name,
        source_type: binding.source_type,
        data_basis: rec.data_basis,
        import_reason: "apify_ingest",
        importability: true,
        content_hash: rec.hash,
        raw_hash: rec.hash,
        metadata: { ingestion_method: "apify", actor_id: binding.actor_id },
      });
      if (error) {
        result.errors.push(`insert:${error.message.slice(0, 120)}`);
      } else {
        result.inserted++;
      }
    } catch (e) {
      result.errors.push(e instanceof Error ? e.message.slice(0, 120) : String(e));
    }
  }

  return result;
}
