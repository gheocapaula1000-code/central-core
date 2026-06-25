// TEMP — Step 6 test proxy. Will be deleted.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? "b2b-finder-update-status";
  const overrideSecret = url.searchParams.get("bad") === "1" ? "WRONG_SECRET" : Deno.env.get("B2B_FINDER_SECRET") ?? "";
  const omit = url.searchParams.get("omit") === "1";

  const body = await req.text();
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-source-app": "b2b-finder",
  };
  if (!omit) headers["x-internal-secret"] = overrideSecret;

  const r = await fetch(`${SUPABASE_URL}/functions/v1/${path}`, {
    method: "POST",
    headers,
    body,
  });
  const txt = await r.text();
  return new Response(JSON.stringify({ status: r.status, ct: r.headers.get("content-type"), body: txt }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
