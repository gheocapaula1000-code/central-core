// civiko-agency-opportunities-v2
// GET /functions/v1/civiko-agency-opportunities-v2
// Reads civiko_evidence scoped to the caller's agency_operating_areas and
// returns a CLASSIFIED payload separating:
//   - focus_area          (comune-level insights)
//   - hot_microzones      (microzone-level insights)
//   - commercial_actions  (derived suggestions over area insights)
//   - deal_opportunities  (listing / auction / property / address / lead only)
//   - opportunities       (BACKWARD-COMPAT alias = deal_opportunities ONLY)
//   - audit               (full classification breakdown + empty_reason)
//
// HARD CONTRACTS:
//   - Geography never widens past the agency's configured zones.
//   - c:* / mz:* entities never appear in deal_opportunities / opportunities.
//   - F19/F22 alone cannot drive a deal.
//   - F14/F15 evidence is never serialised at audience="agency".
//   - No mocks, no demo data, no fabricated rows.
//   - The handler MUST NEVER crash: every unexpected error returns a
//     controlled JSON envelope with debug_id so the PWA never blanks out.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import type { EvidenceRow } from "../_shared/evidenceLedger.ts";
import { runOpportunityAudit, type AgencyArea } from "./audit.ts";
import { buildResponseData, buildControlledErrorBody, EMPTY_PAYLOAD } from "./response.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function svc() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

const OWNER_EMAILS = (Deno.env.get("CORE_ADMIN_BOOTSTRAP_EMAILS") ?? "")
  .split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

function controlledError(debug_id: string, status = 200) {
  return json({
    ok: false,
    data_status: "error",
    error_code: "OPPORTUNITY_V2_RUNTIME_ERROR",
    message: "Non riesco a caricare le opportunità in questo momento.",
    debug_id,
    ...EMPTY_PAYLOAD,
  }, status);
}

serve(async (req) => {
  const debug_id = (globalThis.crypto?.randomUUID?.() ?? `dbg-${Date.now()}`);
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "GET") return json({ ok: false, error: { code: "METHOD_NOT_ALLOWED" } }, 405);

    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return json({ ok: false, error: { code: "UNAUTHORIZED" } }, 401);

    if (!Deno.env.get("SUPABASE_URL") || !Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
      console.error("[opportunities-v2] missing supabase env", { debug_id });
      return controlledError(debug_id, 500);
    }

    const supabase = svc();
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ ok: false, error: { code: "UNAUTHORIZED" } }, 401);
    const user = userData.user;
    const email = (user.email ?? "").toLowerCase();

    let allowed = OWNER_EMAILS.includes(email);
    if (!allowed) {
      const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", user.id);
      const set = new Set((roles ?? []).map((r: { role: string }) => r.role));
      allowed = set.has("admin") || set.has("owner") || set.has("agency_user");
    }
    if (!allowed) return json({ ok: false, error: { code: "FORBIDDEN" } }, 403);

    const url = new URL(req.url);
    const agencyId = url.searchParams.get("agency_id");

    let q = supabase.from("agency_operating_areas").select("agency_id,user_id,comuni,microzones,quartieri");
    if (agencyId) q = q.eq("agency_id", agencyId);
    else q = q.or(`user_id.eq.${user.id},agency_id.in.(select agency_id from agency_memberships where user_id=${user.id} and status='active')`);
    const { data: areas, error: areasErr } = await q;
    if (areasErr) {
      console.error("[opportunities-v2] areas query failed", { debug_id, message: areasErr.message });
      return controlledError(debug_id, 500);
    }

    const areaList = (areas ?? []) as AgencyArea[];
    if (
      areaList.length === 0 ||
      areaList.every(
        (a) =>
          (a?.comuni?.length ?? 0) === 0 &&
          (a?.microzones?.length ?? 0) === 0 &&
          (a?.quartieri?.length ?? 0) === 0,
      )
    ) {
      return json({
        ok: true,
        data: {
          data_status: "setup_required",
          message: "Configura le zone operative dell'agenzia per attivare il radar.",
          ...EMPTY_PAYLOAD,
          audit: null,
        },
      });
    }

    const { data: evidence, error: evErr } = await supabase
      .from("civiko_evidence")
      .select("entity_type,entity_key,source_code,evidence_type,evidence_value,confidence,freshness_days,observed_at,explanation,raw_ref_id,compliance_visibility")
      .in("compliance_visibility", ["public", "admin_only"])
      .order("observed_at", { ascending: false })
      .limit(5000);
    if (evErr) {
      console.error("[opportunities-v2] evidence query failed", { debug_id, message: evErr.message });
      return controlledError(debug_id, 500);
    }

    const result = runOpportunityAudit((evidence ?? []) as EvidenceRow[], areaList);
    const data = buildResponseData(result, areaList);
    return json({ ok: true, data });
  } catch (err) {
    console.error("[opportunities-v2] RUNTIME_ERROR", { debug_id, error: (err as Error)?.message, stack: (err as Error)?.stack });
    return controlledError(debug_id, 200);
  }
});
