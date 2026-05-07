import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { endpoint, method, payload, timeout } = await req.json();
    if (!endpoint) return new Response(JSON.stringify({ error: "missing endpoint" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const authHeader = req.headers.get("Authorization") ?? `Bearer ${ANON_KEY}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (timeout ?? 10000) + 2000);

    const res = await fetch(`${SUPABASE_URL}/functions/v1/sottra`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader,
        "apikey": ANON_KEY,
      },
      body: JSON.stringify({ route: endpoint.replace(/^\//, ""), ...((payload as Record<string, unknown>) ?? {}) }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: true, message: e instanceof Error ? e.message : "proxy error" }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
