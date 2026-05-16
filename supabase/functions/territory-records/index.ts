// territory-records
// Endpoint protetto per la PWA Civiko: restituisce record reali normalizzati
// del pilota (Padova), già puliti — senza raw_payload né campi tecnici interni.
//
// Accesso: utente autenticato con ruolo 'admin' o 'moderator'.
// Sorgente: public.normalized_opportunities.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const SUPPORTED_CITIES = new Set(["padova"]);

type CleanRecord = {
  title: string;
  municipality: string | null;
  microzone: string | null;
  source_name: string;
  last_seen_at: string;
  freshness_days: number;
  priority_score: number;
  scoring_reason: string | null;
  has_geo: boolean;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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

  // Auth: verifica JWT + ruolo admin/moderator
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
  const userId = userData.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE);
  const { data: roleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["admin", "moderator"])
    .limit(1)
    .maybeSingle();
  if (!roleRow) return json({ error: "forbidden" }, 403);

  // Match municipality case-insensitive (es. "Padova", "padova")
  const { data, error } = await admin
    .from("normalized_opportunities")
    .select(
      "title,municipality,microzone,source_name,last_seen_at,freshness_days,priority_score,scoring_reason,latitude,longitude",
    )
    .ilike("municipality", cityRaw)
    .order("priority_score", { ascending: false })
    .order("last_seen_at", { ascending: false })
    .limit(200);

  if (error) return json({ error: "query_failed", message: error.message }, 500);

  const records: CleanRecord[] = (data ?? []).map((r: any) => ({
    title: r.title,
    municipality: r.municipality,
    microzone: r.microzone,
    source_name: r.source_name,
    last_seen_at: r.last_seen_at,
    freshness_days: Number(r.freshness_days ?? 0),
    priority_score: Number(r.priority_score ?? 0),
    scoring_reason: r.scoring_reason,
    has_geo: r.latitude != null && r.longitude != null,
  }));

  return json({ city: cityRaw, count: records.length, records });
});
