// TEMP test wrapper - to be deleted after use
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
Deno.serve(async (req) => {
  let overrides: Record<string, unknown> = {};
  try { overrides = await req.json(); } catch {}
  const body = { dry_run: true, mode: "refresh", max_urls_from_db: 20, max_items: 50, wait_seconds: 300, ...overrides };
  const res = await fetch(`${SUPABASE_URL}/functions/v1/padova-apify-idealista-collect`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-job-secret": JOB_SECRET },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return new Response(text, { status: res.status, headers: { "Content-Type": "application/json" } });
});
