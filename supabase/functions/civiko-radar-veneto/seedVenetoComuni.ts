import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { VENETO_COMUNI_SEED } from "../../../src/data/veneto-comuni-seed.ts";

export async function seedVenetoComuni(): Promise<{ ok: boolean; inserted: number; skipped: number; errors: string[] }> {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return { ok: false, inserted: 0, skipped: 0, errors: ["missing env"] };

  const supa = createClient(url, key);
  const errors: string[] = [];
  let inserted = 0;
  let skipped = 0;

  // Batch insert da 100 record
  const BATCH = 100;
  for (let i = 0; i < VENETO_COMUNI_SEED.length; i += BATCH) {
    const batch = VENETO_COMUNI_SEED.slice(i, i + BATCH);
    const { error, count } = await supa
      .from("veneto_comuni")
      .upsert(batch, { onConflict: "codice_istat", ignoreDuplicates: true })
      .select("codice_istat", { count: "exact", head: true });
    if (error) {
      errors.push(`batch ${i}: ${error.message}`);
    } else {
      inserted += count ?? 0;
    }
  }
  skipped = VENETO_COMUNI_SEED.length - inserted;
  return { ok: errors.length === 0, inserted, skipped, errors };
}
