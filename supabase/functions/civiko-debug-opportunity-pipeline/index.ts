// civiko-debug-opportunity-pipeline
// GET /functions/v1/civiko-debug-opportunity-pipeline
// Admin-only end-to-end diagnostic: why the PWA radar is empty.
// No fake data, no demo records, no geographic widening.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { buildDiagnostic, type AgencyScope } from "./diagnostic.ts";
import type { EvidenceRow } from "../_shared/evidenceLedger.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

function svc() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

function ownerEmails(): string[] {
  return (Deno.env.get("CORE_ADMIN_BOOTSTRAP_EMAILS") ?? "")
    .split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

async function requireAdmin(req: Request): Promise<{ userId: string; email: string } | Response> {
  const auth = req.headers.get("Authorization");
  if (!auth) return json({ ok: false, error: { code: "UNAUTHORIZED", message: "Missing Authorization" } }, 401);
  const supabase = svc();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return json({ ok: false, error: { code: "UNAUTHORIZED", message: "Invalid token" } }, 401);
  const email = (data.user.email ?? "").toLowerCase();
  let isAdmin = ownerEmails().includes(email);
  if (!isAdmin) {
    const { data: role } = await supabase
      .from("user_roles").select("role").eq("user_id", data.user.id).eq("role", "admin").maybeSingle();
    isAdmin = !!role;
  }
  if (!isAdmin) return json({ ok: false, error: { code: "FORBIDDEN", message: "Admin only" } }, 403);
  return { userId: data.user.id, email };
}

// deno-lint-ignore no-explicit-any
async function loadAgencyScope(supabase: any, params: {
  agency_id?: string | null; workspace_id?: string | null; user_id?: string | null;
  comune?: string | null; microzone?: string | null;
}): Promise<AgencyScope> {
  let area: any = null;
  if (params.agency_id) {
    const { data } = await supabase.from("agency_operating_areas")
      .select("*").eq("agency_id", params.agency_id).eq("is_active", true).limit(1).maybeSingle();
    area = data ?? null;
  } else if (params.workspace_id) {
    const { data } = await supabase.from("agency_operating_areas")
      .select("*").eq("workspace_id", params.workspace_id).eq("is_active", true).limit(1).maybeSingle();
    area = data ?? null;
  } else if (params.user_id) {
    const { data } = await supabase.from("agency_operating_areas")
      .select("*").eq("user_id", params.user_id).eq("is_active", true).limit(1).maybeSingle();
    area = data ?? null;
  }
  const comuni: string[] = area?.comuni ?? [];
  const microzones: string[] = area?.microzones ?? [];
  const province: string[] = area?.province ?? [];
  const zone_slugs: string[] = area?.quartieri ?? [];
  // URL params may NARROW only when no agency mapping (never widen).
  const fallbackComune = params.comune?.trim() || null;
  const fallbackMicrozone = params.microzone?.trim() || null;
  const finalComuni = comuni.length ? comuni : (fallbackComune ? [fallbackComune] : []);
  const finalMicrozones = microzones.length ? microzones : (fallbackMicrozone ? [fallbackMicrozone] : []);
  return {
    agency_id: params.agency_id ?? area?.agency_id ?? null,
    workspace_id: params.workspace_id ?? area?.workspace_id ?? null,
    user_id: params.user_id ?? area?.user_id ?? null,
    comune: finalComuni[0] ?? null,
    comuni: finalComuni,
    microzones: finalMicrozones,
    zone_slugs,
    province,
    configured: finalComuni.length > 0 || finalMicrozones.length > 0,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ ok: false, error: { code: "METHOD_NOT_ALLOWED" } }, 405);

  const gate = await requireAdmin(req);
  if (gate instanceof Response) return gate;

  const url = new URL(req.url);
  const params = {
    agency_id: url.searchParams.get("agency_id"),
    workspace_id: url.searchParams.get("workspace_id"),
    user_id: url.searchParams.get("user_id") ?? gate.userId,
    comune: url.searchParams.get("comune"),
    microzone: url.searchParams.get("microzone") ?? url.searchParams.get("zone_slug"),
  };

  const supabase = svc();
  const scope = await loadAgencyScope(supabase, params);

  const { data: registry } = await supabase
    .from("civiko_source_registry").select("*").order("source_code");
  const { data: evidenceRaw } = await supabase
    .from("civiko_evidence").select("*").order("observed_at", { ascending: false }).limit(5000);

  const report = buildDiagnostic({
    scope,
    registry: registry ?? [],
    evidence: (evidenceRaw ?? []) as EvidenceRow[],
  });

  return json({ ok: true, data: report });
});
