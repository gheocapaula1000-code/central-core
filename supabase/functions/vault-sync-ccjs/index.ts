import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async () => {
  const envVal = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!envVal) return new Response(JSON.stringify({ ok: false, error: "env_missing" }), { status: 500 });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: pre, error: e1 } = await sb.rpc("vault_ccjs_status");
  if (e1) return new Response(JSON.stringify({ ok: false, stage: "pre", error: e1.message }), { status: 500 });
  const { data: post, error: e2 } = await sb.rpc("vault_ccjs_sync", { p_value: envVal });
  if (e2) return new Response(JSON.stringify({ ok: false, stage: "sync", error: e2.message, pre }), { status: 500 });
  return new Response(JSON.stringify({ ok: true, env_len: envVal.length, pre, post }, null, 2), { headers: { "Content-Type": "application/json" } });
});
