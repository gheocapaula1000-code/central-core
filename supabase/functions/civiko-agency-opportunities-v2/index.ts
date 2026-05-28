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

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import type { EvidenceRow } from "../_shared/evidenceLedger.ts";
import { runOpportunityAudit, type AgencyArea } from "./audit.ts";

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ ok: false, error: { code: "METHOD_NOT_ALLOWED" } }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ ok: false, error: { code: "UNAUTHORIZED" } }, 401);

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
  if (areasErr) return json({ ok: false, error: { code: "DB_ERROR", message: areasErr.message } }, 500);

  const areaList = (areas ?? []) as AgencyArea[];
  if (areaList.length === 0 || areaList.every((a) => (a.comuni?.length ?? 0) === 0 && (a.microzones?.length ?? 0) === 0 && (a.quartieri?.length ?? 0) === 0)) {
    return json({
      ok: true,
      data: {
        data_status: "setup_required",
        message: "Configura le zone operative dell'agenzia per attivare il radar.",
        focus_area: [],
        hot_microzones: [],
        commercial_actions: [],
        deal_opportunities: [],
        opportunities: [],
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
  if (evErr) return json({ ok: false, error: { code: "DB_ERROR", message: evErr.message } }, 500);

  const result = runOpportunityAudit((evidence ?? []) as EvidenceRow[], areaList);

  const data_status = result.deal_opportunities.length > 0
    ? "ok"
    : (result.focus_area.length + result.hot_microzones.length > 0 ? "area_insights_only" : "empty");

  const empty_message = result.deal_opportunities.length === 0
    ? "Nessuna opportunità immobiliare specifica disponibile ora."
    : null;

  return json({
    ok: true,
    data: {
      data_status,
      message: empty_message,
      focus_area: result.focus_area,
      hot_microzones: result.hot_microzones,
      commercial_actions: result.commercial_actions,
      deal_opportunities: result.deal_opportunities,
      opportunities: result.opportunities, // alias = deal_opportunities only
      audit: result.audit,
      scope: {
        comuni: [...new Set(areaList.flatMap((a) => a.comuni ?? []))],
        microzones: [...new Set(areaList.flatMap((a) => [...(a.microzones ?? []), ...(a.quartieri ?? [])]))],
      },
    },
  });
});
