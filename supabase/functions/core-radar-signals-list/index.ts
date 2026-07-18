// core-radar-signals-list
// Endpoint pubblico (no auth) che espone i segnali radar attivi per Padova.

import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

type RadarItem = {
  fingerprint: string;
  signal_type: string;
  title: string;
  description: string | null;
  municipality: string | null;
  province: string | null;
  lat: number | null;
  lng: number | null;
  evidence_url: string | null;
  source: string | null;
  confidence: string;
  urgency: string;
  payload: Record<string, unknown> | null;
  detected_at: string;
  expires_at: string | null;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const { data, error } = await supabase
      .from("radar_signals")
      .select(
        "fingerprint, signal_type, title, description, municipality, province, lat, lng, evidence_url, source, confidence, urgency, payload, detected_at, expires_at",
      )
      .eq("is_active", true)
      .gt("expires_at", new Date().toISOString())
      .ilike("municipality", "padova")
      .order("detected_at", { ascending: false })
      .limit(500);

    if (error) {
      return json({ ok: false, error: "query_error", message: error.message }, 500);
    }

    const items: RadarItem[] = (data ?? []).map((r) => ({
      fingerprint: r.fingerprint,
      signal_type: r.signal_type,
      title: r.title,
      description: r.description ?? null,
      municipality: r.municipality ?? null,
      province: r.province ?? null,
      lat: r.lat ?? null,
      lng: r.lng ?? null,
      evidence_url: r.evidence_url ?? null,
      source: r.source ?? null,
      confidence: r.confidence,
      urgency: r.urgency,
      payload: r.payload ? (r.payload as Record<string, unknown>) : null,
      detected_at: r.detected_at ? new Date(r.detected_at).toISOString() : new Date().toISOString(),
      expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    }));

    return json({
      ok: true,
      items,
      total: items.length,
    });
  } catch (e) {
    return json({
      ok: false,
      error: "internal_error",
      message: (e as Error).message,
      items: [],
      total: 0,
    }, 500);
  }
});
