// civiko-restricted-report — F15 Conservatoria/ipotecarie via OpenAPI.it.
// Gate paid/restricted, NIENTE mass scan, NIENTE persistenza dati persona.
// Flow:
//   1. JWT utente valido
//   2. feature flag F15_CONSERVATORIA_ENABLED === "true"
//   3. body.acknowledged_cost === true
//   4. log audit ROW PRIMA della chiamata upstream
//   5. (placeholder) chiamata OpenAPI.it — non implementata finché provider/credenziali non confermati
//   6. update audit row status
// Risposta: payload ephemeral, mai salvato in tabelle dedicate.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });

function svc() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "POST only" } }, 405);

  try {
    // Auth utente
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ ok: false, error: { code: "UNAUTHORIZED", message: "Missing Authorization" } }, 401);
    const supabase = svc();
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    const { data: userData, error: uErr } = await supabase.auth.getUser(token);
    if (uErr || !userData.user) {
      return json({ ok: false, error: { code: "UNAUTHORIZED", message: "Invalid token" } }, 401);
    }
    const userId = userData.user.id;

    // Body
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* ignore */ }
    const targetRaw = String(body.target_ref ?? "").trim();
    const acknowledged = body.acknowledged_cost === true;
    const agencyId = (body.agency_id as string | undefined) ?? null;

    if (!targetRaw) {
      return json({ ok: false, error: { code: "TARGET_REF_REQUIRED", message: "target_ref required" } }, 400);
    }
    if (!acknowledged) {
      return json({ ok: false, error: { code: "COST_ACKNOWLEDGMENT_REQUIRED", message: "acknowledged_cost must be true" } }, 400);
    }

    // Feature flag
    const flag = (Deno.env.get("F15_CONSERVATORIA_ENABLED") ?? "").toLowerCase() === "true";
    const providerToken = Deno.env.get("OPENAPI_IT_TOKEN") ?? "";

    // Hash target prima di scrivere audit
    const targetRefHash = await sha256Hex(`${userId}:${targetRaw.toLowerCase()}`);

    // Audit row PRIMA del provider
    const { data: audit, error: aErr } = await supabase
      .from("restricted_report_audit")
      .insert({
        user_id: userId,
        agency_id: agencyId,
        feature_code: "F15_CONSERVATORIA",
        target_ref: targetRefHash,
        cost_cents: 0,
        provider: "openapi_it",
        status: flag && providerToken ? "requested" : "denied",
        error_message: flag && providerToken ? null : "FEATURE_NOT_ENABLED",
      })
      .select("id")
      .single();

    if (aErr) {
      return json({ ok: false, error: { code: "AUDIT_INSERT_FAILED", message: aErr.message } }, 500);
    }
    const auditId = audit.id;

    if (!flag || !providerToken) {
      return json({
        ok: false,
        data: { audit_id: auditId },
        error: {
          code: "FEATURE_NOT_ENABLED",
          message: "F15 conservatoria gate disabled. Set F15_CONSERVATORIA_ENABLED=true and OPENAPI_IT_TOKEN.",
        },
      }, 403);
    }

    // Placeholder upstream call. Quando il provider/endpoint sarà confermato, sostituire qui.
    // Mass-scan vietato: una richiesta = un target_ref.
    await supabase
      .from("restricted_report_audit")
      .update({ status: "failed", error_message: "Provider integration not implemented yet", completed_at: new Date().toISOString() })
      .eq("id", auditId);

    return json({
      ok: false,
      data: { audit_id: auditId },
      error: {
        code: "PROVIDER_NOT_IMPLEMENTED",
        message: "OpenAPI.it conservatoria endpoint not yet wired. Audit row created.",
      },
    }, 501);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.error("civiko-restricted-report error:", msg);
    return json({ ok: false, error: { code: "INTERNAL_ERROR", message: msg } }, 500);
  }
});
