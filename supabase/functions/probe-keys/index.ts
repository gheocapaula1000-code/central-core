Deno.serve(() => {
  const keys = ["SUPABASE_ANON_KEY","SUPABASE_PUBLISHABLE_KEY","SUPABASE_PUBLISHABLE_KEYS","SUPABASE_SECRET_KEYS","SUPABASE_SERVICE_ROLE_KEY"];
  const out: Record<string,string> = {};
  for (const k of keys) {
    const v = Deno.env.get(k) ?? "";
    out[k] = v ? `${v.slice(0,12)}...len=${v.length}` : "MISSING";
  }
  return new Response(JSON.stringify(out), { headers: {"content-type":"application/json"} });
});
