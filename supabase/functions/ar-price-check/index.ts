// Temporary diagnostic: verifies AR price secrets at runtime without leaking values.
// Auth: x-diagnostic-secret = DIAGNOSTIC_SECRET
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-diagnostic-secret, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function mask(v: string | undefined): string | null {
  if (!v) return null;
  if (v.length <= 12) return v.slice(0, 2) + "***";
  return `${v.slice(0, 8)}...${v.slice(-4)}`;
}

serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const m = Deno.env.get("AR_STRIPE_PRICE_AGENZIA_MONTHLY");
  const a = Deno.env.get("AR_STRIPE_PRICE_AGENZIA_ANNUAL");
  const body = {
    monthly: {
      present: !!m,
      length: m?.length ?? 0,
      starts_with_price_: !!m?.startsWith("price_"),
      masked: mask(m),
    },
    annual: {
      present: !!a,
      length: a?.length ?? 0,
      starts_with_price_: !!a?.startsWith("price_"),
      masked: mask(a),
    },
    different: !!m && !!a && m !== a,
  };
  return new Response(JSON.stringify(body), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
