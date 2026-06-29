// civiko-zones-reserve — prenota una zona commerciale in trial (7gg) per l'agenzia chiamante.
// Auth: JWT utente + header x-workspace-id (= agencies.id). Membership verificata.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { authorizeCivikoOne, civikoOneCors, errorResponse, jsonResponse } from "../_shared/civikoOneAuth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: civikoOneCors });
  if (req.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", "POST only", 405);

  const debug_id = crypto.randomUUID();

  let body: { slug?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "errore", message: "invalid JSON", debug_id }, 400);
  }
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  if (!slug) {
    return jsonResponse({ ok: false, error: "errore", message: "slug required", debug_id }, 400);
  }

  const workspaceId = req.headers.get("x-workspace-id");
  const auth = await authorizeCivikoOne(req, workspaceId);
  if (!auth.ok) {
    return jsonResponse({ ok: false, error: "errore", message: auth.message, debug_id }, auth.status);
  }

  const { serviceClient, agencyId } = auth;

  const { data, error } = await serviceClient.rpc("reserve_commercial_zone", {
    p_slug: slug,
    p_agency_id: agencyId,
  });

  if (error) {
    const msg = (error.message || "").toLowerCase();
    let code: "zona_in_trial" | "zona_occupata" | "errore" = "errore";
    if (msg.includes("trial") || msg.includes("reserved")) code = "zona_in_trial";
    else if (msg.includes("occup")) code = "zona_occupata";
    return jsonResponse({ ok: false, error: code, message: error.message, debug_id }, 409);
  }

  return jsonResponse({ ok: true, data, debug_id });
});
