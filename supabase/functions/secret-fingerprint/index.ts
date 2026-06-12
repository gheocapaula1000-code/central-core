import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-fp-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const REQUIRED_TOKEN = "fp-civiko-2026-06-12";

function fingerprint(value: string | undefined): { present: boolean; len?: number; prefix?: string; suffix?: string } {
  if (!value) return { present: false };
  return {
    present: true,
    len: value.length,
    prefix: value.slice(0, 4),
    suffix: value.slice(-4),
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const token = req.headers.get("x-fp-token") ?? "";
  if (token !== REQUIRED_TOKEN) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }

  const secrets = {
    AI_CORE_SECRET_CIVIKO: fingerprint(Deno.env.get("AI_CORE_SECRET_CIVIKO")),
    CENTRAL_CORE_JOB_SECRET: fingerprint(Deno.env.get("CENTRAL_CORE_JOB_SECRET")),
    CIVIKO_BILLING_SECRET: fingerprint(Deno.env.get("CIVIKO_BILLING_SECRET")),
    CIVIKO_RADAR_SECRET: fingerprint(Deno.env.get("CIVIKO_RADAR_SECRET")),
    CORE_INTERNAL_SECRET: fingerprint(Deno.env.get("CORE_INTERNAL_SECRET")),
    STRIPE_SECRET_KEY: fingerprint(Deno.env.get("STRIPE_SECRET_KEY")),
    SUPABASE_ANON_KEY: fingerprint(Deno.env.get("SUPABASE_ANON_KEY")),
    ANON_KEY_FULL: Deno.env.get("SUPABASE_ANON_KEY") ?? null,
  };

  return new Response(JSON.stringify({ ok: true, secrets }, null, 2), {
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
});
