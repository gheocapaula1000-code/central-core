import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-fp-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REQUIRED_TOKEN = "fp-civiko-2026-06-12";

function fp(value: string | undefined) {
  if (!value) return { present: false };
  return { present: true, len: value.length, prefix: value.slice(0, 4), suffix: value.slice(-4) };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if ((req.headers.get("x-fp-token") ?? "") !== REQUIRED_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }

  const payload = await req.json().catch(() => ({}));
  const mode = String(payload.mode ?? "jobOnly");
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const civikoSecret = Deno.env.get("AI_CORE_SECRET_CIVIKO") ?? "";
  const internalSecret = Deno.env.get("CORE_INTERNAL_SECRET") ?? "";

  const headers: Record<string, string> = {
    Authorization: `Bearer ${anon}`,
    apikey: anon,
    "x-source-app": "civiko",
    "x-job-secret": civikoSecret,
    "content-type": "application/json",
  };
  if (mode === "bothHeaders") headers["x-internal-secret"] = internalSecret;

  const body = {
    plan: "monthly",
    workspace_id: "00000000-0000-0000-0000-000000000001",
    supabase_user_id: "00000000-0000-0000-0000-000000000001",
    email: "test@civiko.it",
    success_url: "https://civikoone.com/abbonamento/success",
    cancel_url: "https://civikoone.com/abbonamento",
  };

  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/civiko-billing/create-checkout-direct`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();

  return new Response(JSON.stringify({
    ok: true,
    mode,
    status: res.status,
    response: text ? JSON.parse(text) : null,
    fingerprints: {
      AI_CORE_SECRET_CIVIKO: fp(civikoSecret),
      CORE_INTERNAL_SECRET: fp(internalSecret),
      SUPABASE_ANON_KEY: fp(anon),
    },
  }, null, 2), {
    status: 200,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
});