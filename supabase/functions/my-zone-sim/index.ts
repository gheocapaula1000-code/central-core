// TEMP smoke test — calls /civiko-billing/my-zone with the real internal secret.
Deno.serve(async () => {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/civiko-billing/my-zone`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-source-app": "civiko",
      "x-job-secret": Deno.env.get("AI_CORE_SECRET_CIVIKO") ?? "",
      "x-workspace-id": "5d02861b-ec1f-44f1-8ddd-096bdaf286a6",
      "x-user-id": "9d8d4fc3-80ca-4b05-92a6-b2dea72b82b5",
      "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      "Authorization": `Bearer ${Deno.env.get("SUPABASE_ANON_KEY") ?? ""}`,
    },
  });
  const body = await res.text();
  return new Response(JSON.stringify({ status: res.status, body: body.slice(0, 2000) }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
