// demo-territory-records
// Endpoint pubblico sicuro: sottoinsieme innocuo dei record del pilota (Padova).
// Nessun dato sensibile, max 5 record, solo campi pubblici già esposti come stime.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const SUPPORTED_CITIES = new Set(["padova"]);
const MAX_RECORDS = 5;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Sanifica title: rimuove indirizzi civici espliciti e numeri lunghi.
function sanitizeTitle(t: string): string {
  if (!t) return "Opportunità nel territorio";
  let s = t.replace(/\b\d{1,4}\b/g, "").replace(/\s+/g, " ").trim();
  if (s.length > 80) s = s.slice(0, 77) + "…";
  return s || "Opportunità nel territorio";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const url = new URL(req.url);
  const cityRaw = (url.searchParams.get("city") || "").trim().toLowerCase();
  if (!cityRaw) return json({ error: "missing_city" }, 400);
  if (!SUPPORTED_CITIES.has(cityRaw)) {
    return json({ error: "city_not_supported", city: cityRaw, supported: [...SUPPORTED_CITIES] }, 400);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE);

  const { data, error } = await admin
    .from("normalized_opportunities")
    .select(
      "title,municipality,microzone,source_name,last_seen_at,freshness_days,priority_score,scoring_reason,latitude,longitude",
    )
    .ilike("municipality", cityRaw)
    .order("priority_score", { ascending: false })
    .order("last_seen_at", { ascending: false })
    .limit(MAX_RECORDS);

  if (error) return json({ error: "query_failed" }, 500);

  const records = (data ?? []).map((r: any) => ({
    title: sanitizeTitle(r.title),
    municipality: r.municipality,
    microzone: r.microzone,
    source_name: r.source_name,
    last_seen_at: r.last_seen_at,
    freshness_days: Number(r.freshness_days ?? 0),
    priority_score: Number(r.priority_score ?? 0),
    scoring_reason: r.scoring_reason,
    has_geo: r.latitude != null && r.longitude != null,
  }));

  return json({ city: cityRaw, demo: true, count: records.length, records });
});
