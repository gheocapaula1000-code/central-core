// One-shot: allinea vault.secrets['CENTRAL_CORE_JOB_SECRET'] all'env omonimo.
// Non stampa mai il valore. Ritorna solo nomi e length prima/dopo.
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async () => {
  const envVal = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const envLen = envVal.length;
  if (!envVal) {
    return new Response(JSON.stringify({ ok: false, error: "env_missing", env_len: 0 }), { status: 500 });
  }
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: rows, error: e1 } = await sb.rpc("exec_sql_vault_ccjs_lookup");
  // Fallback inline query via from
  let found: Array<{ id: string; name: string; len: number; matches: boolean }> = [];
  if (e1) {
    // Use raw REST: query via PostgREST not possible on vault; use rpc we create.
  }

  // Direct SQL via pg meta not available; use a custom function created below.
  const { data: pre, error: e2 } = await sb.rpc("vault_ccjs_status");
  if (e2) return new Response(JSON.stringify({ ok: false, stage: "pre", error: e2.message }), { status: 500 });

  const { data: post, error: e3 } = await sb.rpc("vault_ccjs_sync", { p_value: envVal });
  if (e3) return new Response(JSON.stringify({ ok: false, stage: "sync", error: e3.message, pre }), { status: 500 });

  return new Response(JSON.stringify({ ok: true, env_len: envLen, pre, post }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
