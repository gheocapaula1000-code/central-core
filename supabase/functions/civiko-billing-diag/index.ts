Deno.serve(async () => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const SECRET = Deno.env.get("AI_CORE_SECRET_CIVIKO") ?? "";
  const out: Record<string, unknown> = {
    has_url: !!SUPABASE_URL,
    anon_present: !!ANON,
    anon_prefix16: ANON.slice(0, 16),
    anon_len: ANON.length,
    secret_present: !!SECRET,
    secret_len: SECRET.length,
  };
  const res = await fetch(`${SUPABASE_URL}/functions/v1/civiko-billing/create-checkout-direct`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ANON}`,
      "apikey": ANON,
      "x-source-app": "civiko",
      "x-job-secret": SECRET,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      plan: "monthly",
      workspace_id: "00000000-0000-0000-0000-000000000001",
      supabase_user_id: "00000000-0000-0000-0000-000000000001",
      email: "test@civiko.it",
      success_url: "https://civikoone.com/abbonamento/success",
      cancel_url: "https://civikoone.com/abbonamento",
    }),
  });
  out.status = res.status;
  out.body = await res.text();
  return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json" } });
});
