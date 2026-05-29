// civiko-agency-data-readiness
// GET /functions/v1/civiko-agency-data-readiness?agency_id=...
// Admin/owner-only diagnostic: returns scope, evidence counts, readiness score,
// missing arrays, last ingestion, auto-heal status, and a snapshot of v2 counts
// for the given agency. Never widens scope, never fabricates data.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import type { EvidenceRow } from "../_shared/evidenceLedger.ts";
import { runOpportunityAudit, type AgencyArea } from "../civiko-agency-opportunities-v2/audit.ts";
import { buildFrontendReadiness, type EvidenceCounts } from "../civiko-agency-opportunities-v2/response.ts";
import { backfillEvidence } from "../_shared/evidenceBackfill.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-diagnostic-secret",
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
const DIAG_SECRET = Deno.env.get("DIAGNOSTIC_SECRET") ?? "";

async function requireAdmin(req: Request): Promise<{ userId: string | null } | Response> {
  const diag = req.headers.get("x-diagnostic-secret") ?? "";
  if (DIAG_SECRET && diag && diag === DIAG_SECRET) return { userId: null };
  const auth = req.headers.get("Authorization");
  if (!auth) return json({ ok: false, error: { code: "UNAUTHORIZED" } }, 401);
  const supabase = svc();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return json({ ok: false, error: { code: "UNAUTHORIZED" } }, 401);
  const email = (data.user.email ?? "").toLowerCase();
  let allowed = OWNER_EMAILS.includes(email);
  if (!allowed) {
    const { data: role } = await supabase
      .from("user_roles").select("role").eq("user_id", data.user.id).in("role", ["admin", "owner"]).limit(1);
    allowed = (role ?? []).length > 0;
  }
  if (!allowed) return json({ ok: false, error: { code: "FORBIDDEN" } }, 403);
  return { userId: data.user.id };
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
}

function computeCounts(rows: EvidenceRow[], scopeComuni: Set<string>): EvidenceCounts {
  const c: EvidenceCounts = { area: 0, microzone: 0, deal: 0, auction: 0, listing: 0 };
  for (const r of rows) {
    const k = r.entity_key ?? "";
    const parts = k.split(":");
    const seg = (parts[1] ?? "").toLowerCase().trim();
    if (scopeComuni.size > 0 && !scopeComuni.has(seg)) continue;
    if (k.startsWith("c:")) c.area++;
    else if (k.startsWith("mz:")) c.microzone++;
    else if (k.startsWith("op:")) { c.deal++; c.listing++; }
    else if (k.startsWith("auct:")) { c.deal++; c.auction++; }
  }
  return c;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ ok: false, error: { code: "METHOD_NOT_ALLOWED" } }, 405);

  const gate = await requireAdmin(req);
  if (gate instanceof Response) return gate;

  const url = new URL(req.url);
  const agency_id = url.searchParams.get("agency_id");
  const user_id = url.searchParams.get("user_id");
  const auto_heal = url.searchParams.get("auto_heal") !== "false"; // default on

  const supabase = svc();
  const select = "agency_id,user_id,comuni,microzones,quartieri,is_active";
  let areaRows: Record<string, unknown>[] = [];
  if (agency_id) {
    const { data } = await supabase.from("agency_operating_areas").select(select).eq("agency_id", agency_id).eq("is_active", true);
    areaRows = (data ?? []) as Record<string, unknown>[];
  } else if (user_id) {
    const { data } = await supabase.from("agency_operating_areas").select(select).eq("user_id", user_id).eq("is_active", true);
    areaRows = (data ?? []) as Record<string, unknown>[];
  }

  const areaList: AgencyArea[] = areaRows.map((row) => ({
    agency_id: typeof row.agency_id === "string" ? row.agency_id : null,
    user_id: typeof row.user_id === "string" ? row.user_id : null,
    comuni: asStringArray(row.comuni),
    microzones: asStringArray(row.microzones),
    quartieri: asStringArray(row.quartieri),
  }));
  const scopeComuni = new Set(areaList.flatMap((a) => a.comuni).map((c) => c.toLowerCase().trim()));

  async function fetchAllEvidence(): Promise<EvidenceRow[]> {
    const out: EvidenceRow[] = [];
    for (let from = 0; from < 10_000; from += 1000) {
      const { data, error } = await supabase
        .from("civiko_evidence")
        .select("entity_type,entity_key,source_code,evidence_type,evidence_value,confidence,freshness_days,observed_at,explanation,raw_ref_id,compliance_visibility")
        .in("compliance_visibility", ["public", "admin_only"])
        .order("observed_at", { ascending: false })
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      const page = (data ?? []) as EvidenceRow[];
      out.push(...page);
      if (page.length < 1000) break;
    }
    return out;
  }

  let evidence = await fetchAllEvidence().catch(() => [] as EvidenceRow[]);
  let counts = computeCounts(evidence, scopeComuni);

  // Upstream real-source snapshot (no widening).
  const comuniCanonical = [...scopeComuni].map((c) => c.charAt(0).toUpperCase() + c.slice(1));
  let upstream = { area: 0, deals: 0, auctions: 0 };
  if (comuniCanonical.length > 0) {
    try {
      const r1 = await supabase.from("area_opportunity_scores").select("*", { count: "exact", head: true }).in("municipality", comuniCanonical);
      upstream.area = r1.count ?? 0;
    } catch { /* ignore */ }
    try {
      const r2 = await supabase.from("normalized_opportunities").select("*", { count: "exact", head: true }).in("municipality", comuniCanonical);
      upstream.deals = r2.count ?? 0;
    } catch { /* ignore */ }
    try {
      const r3 = await supabase.from("auction_signals").select("*", { count: "exact", head: true }).in("municipality", comuniCanonical);
      upstream.auctions = r3.count ?? 0;
    } catch { /* ignore */ }
  }

  let auto_heal_attempted = false;
  const totalInScope = counts.area + counts.microzone + counts.deal;
  if (auto_heal && totalInScope < 1 && (upstream.area + upstream.deals + upstream.auctions) > 0) {
    auto_heal_attempted = true;
    await backfillEvidence(supabase).catch(() => null);
    evidence = await fetchAllEvidence().catch(() => evidence);
    counts = computeCounts(evidence, scopeComuni);
  }

  const result = runOpportunityAudit(evidence, areaList);
  const { data: lastIngest } = await supabase
    .from("civiko_evidence").select("observed_at").order("observed_at", { ascending: false }).limit(1);
  const last_successful_ingestion_at = lastIngest?.[0]?.observed_at ?? null;

  const readiness = buildFrontendReadiness(
    {
      focus_area: result.focus_area,
      hot_microzones: result.hot_microzones,
      commercial_actions: result.commercial_actions,
      deal_opportunities: result.deal_opportunities,
    },
    { evidence_counts: counts, last_successful_ingestion_at, auto_heal_attempted },
  );

  return json({
    ok: true,
    data: {
      scope: { comuni: [...scopeComuni], microzones: [...new Set(areaList.flatMap((a) => [...a.microzones, ...a.quartieri]))] },
      areas: areaList,
      evidence_counts: counts,
      upstream_real_sources: upstream,
      v2_counts: {
        focus_area: result.focus_area.length,
        hot_microzones: result.hot_microzones.length,
        commercial_actions: result.commercial_actions.length,
        deal_opportunities: result.deal_opportunities.length,
      },
      audit: result.audit,
      frontend_readiness: readiness,
      auto_heal_attempted,
      last_successful_ingestion_at,
    },
  });
});
