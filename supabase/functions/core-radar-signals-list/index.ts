// core-radar-signals-list
// Endpoint pubblico (no auth) che espone i segnali radar attivi per Padova.

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  resolveZoneFromRecord,
  resolveZoneByName,
  applyQuartiereZonaMapFallback,
  UNRESOLVED_OMI_CODE,
  UNRESOLVED_OMI_LABEL,
} from "../_shared/padovaZoneResolver.ts";

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
  zone_code: string;
  display_zone: string | null;
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

    // Build items + resolve zone using the same logic as civiko-one-signals-feed.
    const items: RadarItem[] = (data ?? []).map((r) => {
      const payload = (r.payload && typeof r.payload === "object")
        ? (r.payload as Record<string, unknown>)
        : {};
      // Merge row + payload into a record for zone resolution.
      const record: Record<string, unknown> = {
        ...payload,
        title: r.title,
        description: r.description,
        municipality: r.municipality,
        lat: r.lat,
        lng: r.lng,
      };
      let zone_code: string;
      let zone_label: string;
      let display_zone: string | null;
      const payloadZona = typeof payload.zona === "string" ? payload.zona : "";
      if (payloadZona.trim()) {
        // Use ONLY payload.zona through the shared name resolver — no title parsing.
        const byName = resolveZoneByName(payloadZona);
        zone_code = byName.zone_code;
        display_zone = byName.display_zone;
        zone_label = byName.display_zone || UNRESOLVED_OMI_LABEL;
      } else {
        const z = resolveZoneFromRecord(record);
        zone_code = z.code;
        zone_label = z.label || UNRESOLVED_OMI_LABEL;
        display_zone = z.code === UNRESOLVED_OMI_CODE
          ? (zone_label && zone_label !== UNRESOLVED_OMI_LABEL ? zone_label : null)
          : zone_label;
      }

      return {
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
        zone_code: z.code,
        // zone_label is kept internally for the fallback lookup key
        zone_label,
        display_zone,
      } as RadarItem & { zone_label: string };
    });

    // Fallback via public.quartiere_zona_map for items still UNRESOLVED.
    try {
      await applyQuartiereZonaMapFallback(supabase, items as unknown as Array<{
        zone_code: string;
        zone_label: string;
        display_zone?: string;
      }>);
    } catch (e) {
      console.error(`[core-radar-signals-list] quartiere_zona_map fallback error:`, (e as Error)?.message ?? e);
    }

    // Finalize: strip internal zone_label, ensure display_zone is null when unresolved.
    const finalItems = items.map((it) => {
      const { ...rest } = it as RadarItem & { zone_label?: string };
      delete (rest as Record<string, unknown>).zone_label;
      if (rest.zone_code === UNRESOLVED_OMI_CODE) {
        rest.display_zone = null;
      } else if (!rest.display_zone) {
        rest.display_zone = null;
      }
      return rest;
    });

    return json({
      ok: true,
      items: finalItems,
      total: finalItems.length,
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
