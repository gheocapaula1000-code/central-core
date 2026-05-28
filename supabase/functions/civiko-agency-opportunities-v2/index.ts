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
import { buildResponseData, buildControlledErrorBody, EMPTY_PAYLOAD, safeStringify } from "./response.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(safeStringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type StageName = "STAGE_REQUEST" | "STAGE_AUTH" | "STAGE_SCOPE" | "STAGE_EVIDENCE_QUERY" | "STAGE_CLASSIFICATION" | "STAGE_RESPONSE_SERIALIZATION";

function errorInfo(err: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  return { error_name: e.name, error_message: e.message, error_stack: e.stack };
}

function logStage(debug_id: string, stage: StageName, ok: boolean, err?: unknown) {
  const extra = err ? errorInfo(err) : {};
  console[ok ? "log" : "error"]("[opportunities-v2] stage", { debug_id, stage, ok, ...extra });
}

function svc() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

const OWNER_EMAILS = (Deno.env.get("CORE_ADMIN_BOOTSTRAP_EMAILS") ?? "")
  .split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

function controlledError(debug_id: string, stage: StageName, err: unknown, status = 200) {
  logStage(debug_id, stage, false, err);
  const { error_name, error_message } = errorInfo(err);
  return json(buildControlledErrorBody(debug_id, stage, error_message, error_name), status);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
}

function normalizeArea(row: Record<string, unknown>): AgencyArea {
  return {
    agency_id: typeof row.agency_id === "string" ? row.agency_id : null,
    user_id: typeof row.user_id === "string" ? row.user_id : null,
    comuni: asStringArray(row.comuni),
    microzones: asStringArray(row.microzones),
    quartieri: asStringArray(row.quartieri),
  };
}

serve(async (req) => {
  const debug_id = (globalThis.crypto?.randomUUID?.() ?? `dbg-${Date.now()}`);
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "GET") return json({ ok: false, error: { code: "METHOD_NOT_ALLOWED" }, debug_id }, 405);
    logStage(debug_id, "STAGE_REQUEST", true);

    const authStage = await (async () => {
      const auth = req.headers.get("Authorization") ?? "";
      if (!auth.startsWith("Bearer ")) return { response: json({ ok: false, error: { code: "UNAUTHORIZED" } }, 401) };

      if (!Deno.env.get("SUPABASE_URL") || !Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
        throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
      }

      const supabase = svc();
      const token = auth.replace(/^Bearer\s+/i, "").trim();
      const { data: userData, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userData?.user) return { response: json({ ok: false, error: { code: "UNAUTHORIZED" } }, 401) };
      const user = userData.user;
      const email = (user.email ?? "").toLowerCase();

      const { data: roles, error: roleErr } = await supabase.from("user_roles").select("role").eq("user_id", user.id);
      if (roleErr) throw new Error(`roles query failed: ${roleErr.message}`);
      const { data: memberships, error: membershipErr } = await supabase
        .from("agency_memberships")
        .select("agency_id,status")
        .eq("user_id", user.id)
        .eq("status", "active");
      if (membershipErr) throw new Error(`memberships query failed: ${membershipErr.message}`);

      const roleSet = new Set((roles ?? []).map((r: { role: string }) => r.role));
      const membershipAgencyIds = [...new Set((memberships ?? []).map((m: { agency_id: string | null }) => m.agency_id).filter((id): id is string => !!id))];
      const allowed = OWNER_EMAILS.includes(email) || roleSet.has("admin") || roleSet.has("owner") || roleSet.has("agency_user") || membershipAgencyIds.length > 0;
      if (!allowed) return { response: json({ ok: false, error: { code: "FORBIDDEN" } }, 403) };
      return { supabase, user, membershipAgencyIds };
    })().catch((err) => ({ response: controlledError(debug_id, "STAGE_AUTH", err, 200) }));
    if ("response" in authStage) return authStage.response;
    logStage(debug_id, "STAGE_AUTH", true);

    const { supabase, user, membershipAgencyIds } = authStage;

    const url = new URL(req.url);
    const agencyId = url.searchParams.get("agency_id");

    const scopeStage = await (async () => {
      const rows: Record<string, unknown>[] = [];
      const select = "agency_id,user_id,comuni,microzones,quartieri,is_active";
      if (agencyId) {
        const { data, error } = await supabase.from("agency_operating_areas").select(select).eq("agency_id", agencyId).eq("is_active", true);
        if (error) throw new Error(`areas by agency query failed: ${error.message}`);
        rows.push(...((data ?? []) as Record<string, unknown>[]));
      } else {
        const { data: ownAreas, error: ownErr } = await supabase.from("agency_operating_areas").select(select).eq("user_id", user.id).eq("is_active", true);
        if (ownErr) throw new Error(`areas by user query failed: ${ownErr.message}`);
        rows.push(...((ownAreas ?? []) as Record<string, unknown>[]));
        if (membershipAgencyIds.length > 0) {
          const { data: agencyAreas, error: agencyErr } = await supabase.from("agency_operating_areas").select(select).in("agency_id", membershipAgencyIds).eq("is_active", true);
          if (agencyErr) throw new Error(`areas by memberships query failed: ${agencyErr.message}`);
          rows.push(...((agencyAreas ?? []) as Record<string, unknown>[]));
        }
      }
      const dedup = new Map<string, AgencyArea>();
      for (const row of rows) {
        const key = `${row.agency_id ?? ""}:${row.user_id ?? ""}:${asStringArray(row.comuni).join("|")}:${asStringArray(row.microzones).join("|")}:${asStringArray(row.quartieri).join("|")}`;
        dedup.set(key, normalizeArea(row));
      }
      return [...dedup.values()];
    })().catch((err) => ({ error: err }));
    if (!Array.isArray(scopeStage)) return controlledError(debug_id, "STAGE_SCOPE", scopeStage.error, 200);
    logStage(debug_id, "STAGE_SCOPE", true);

    const areaList = scopeStage;
    if (
      areaList.length === 0 ||
      areaList.every(
        (a) =>
          (Array.isArray(a?.comuni) ? a.comuni.length : 0) === 0 &&
          (Array.isArray(a?.microzones) ? a.microzones.length : 0) === 0 &&
          (Array.isArray(a?.quartieri) ? a.quartieri.length : 0) === 0,
      )
    ) {
      return json({
        ok: true,
        data: {
          data_status: "setup_required",
          message: "Configura le zone operative dell'agenzia per attivare il radar.",
          ...EMPTY_PAYLOAD,
        },
      });
    }

    const evidenceStage = await (async () => {
      const { data: evidence, error: evErr } = await supabase
        .from("civiko_evidence")
        .select("entity_type,entity_key,source_code,evidence_type,evidence_value,confidence,freshness_days,observed_at,explanation,raw_ref_id,compliance_visibility")
        .in("compliance_visibility", ["public", "admin_only"])
        .order("observed_at", { ascending: false })
        .limit(5000);
      if (evErr) throw new Error(`evidence query failed: ${evErr.message}`);
      return (evidence ?? []) as EvidenceRow[];
    })().catch((err) => ({ error: err }));
    if (!Array.isArray(evidenceStage)) return controlledError(debug_id, "STAGE_EVIDENCE_QUERY", evidenceStage.error, 200);
    logStage(debug_id, "STAGE_EVIDENCE_QUERY", true);

    const sectionFailures: unknown[] = [];
    const result = await (async () => runOpportunityAudit(evidenceStage, areaList, {
      onSectionFailure: (failure) => {
        sectionFailures.push(failure);
        console.error("[opportunities-v2] stage", { debug_id, stage: "STAGE_CLASSIFICATION", ok: false, ...failure });
      },
    }))().catch((err) => ({ error: err }));
    if ("error" in result) return controlledError(debug_id, "STAGE_CLASSIFICATION", result.error, 200);
    logStage(debug_id, "STAGE_CLASSIFICATION", true);

    const serialized = await (async () => {
      const data = buildResponseData({ ...result, warnings: [...(result.warnings ?? []), ...sectionFailures.map((f) => String((f as { message?: string }).message ?? "section_failed"))] }, areaList);
      return safeStringify({ ok: true, data });
    })().catch((err) => ({ error: err }));
    if (typeof serialized !== "string") return controlledError(debug_id, "STAGE_RESPONSE_SERIALIZATION", serialized.error, 200);
    logStage(debug_id, "STAGE_RESPONSE_SERIALIZATION", true);
    return new Response(serialized, { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    return controlledError(debug_id, "STAGE_RESPONSE_SERIALIZATION", err, 200);
  }
});
