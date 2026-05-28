// civiko-agency-opportunities-v2
// GET /functions/v1/civiko-agency-opportunities-v2
// Reads civiko_evidence scoped to the caller's agency_operating_areas,
// runs the shared opportunityEngine, and returns the full filter audit so
// the PWA can render an honest "why empty" reason instead of a silent [].
//
// HARD CONTRACTS:
//   - Geography never widens past the agency's configured zones.
//   - If the agency has no zones → data_status:"setup_required".
//   - F19 alone cannot drive an opportunity (engine enforces it).
//   - F14/F15 evidence is never serialised at audience="agency".
//   - No mocks, no demo data, no fabricated rows.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { buildOpportunityFromEvidence } from "../_shared/opportunityEngine.ts";
import type { EvidenceRow } from "../_shared/evidenceLedger.ts";
import { microzoneKey, comuneKey } from "../_shared/entityKey.ts";

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

interface AgencyArea {
  agency_id: string | null;
  user_id: string | null;
  comuni: string[];
  microzones: string[];
  quartieri: string[];
}

export interface OpportunityAudit {
  candidates_before_filters: number;
  removed_insufficient_evidence: number;
  removed_weak_only: number;
  removed_restricted: number;
  removed_outside_scope: number;
  removed_stale: number;
  final_opportunities_count: number;
  confidence_distribution: { low: number; medium: number; high: number };
  empty_reason: string | null;
}

export interface ScopeMatcher {
  comuni: Set<string>;
  microzones: Set<string>;
  expectedKeys: Set<string>;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Pure: build the set of entity_keys this agency is allowed to see. */
export function buildScopeMatcher(areas: AgencyArea[]): ScopeMatcher {
  const comuni = new Set<string>();
  const microzones = new Set<string>();
  const expectedKeys = new Set<string>();
  for (const a of areas) {
    for (const c of a.comuni ?? []) {
      const cn = norm(c);
      if (!cn) continue;
      comuni.add(cn);
      expectedKeys.add(comuneKey({ comune: c }));
    }
    for (const mz of [...(a.microzones ?? []), ...(a.quartieri ?? [])]) {
      const mn = norm(mz);
      if (!mn) continue;
      microzones.add(mn);
      // microzone is per-comune; we add the bare-microzone key match too
      for (const c of a.comuni ?? []) {
        expectedKeys.add(microzoneKey({ comune: c, microzona: mz }));
      }
      // also accept agencies that define only microzones with no comune
      expectedKeys.add(microzoneKey({ comune: "", microzona: mz }));
    }
  }
  return { comuni, microzones, expectedKeys };
}

/** Pure: bucket evidence by entity_key after compliance + scope filtering. */
export function filterAndGroup(
  rows: EvidenceRow[],
  scope: ScopeMatcher,
  staleAfterDays = 365,
): { groups: Map<string, EvidenceRow[]>; removed_outside_scope: number; removed_stale: number } {
  const groups = new Map<string, EvidenceRow[]>();
  let removed_outside_scope = 0;
  let removed_stale = 0;
  for (const r of rows) {
    // scope
    const inScope = scope.expectedKeys.has(r.entity_key) ||
      // best-effort: also accept exact microzone match across comuni
      [...scope.microzones].some((mz) => r.entity_key.endsWith(`:${mz}`));
    if (!inScope) { removed_outside_scope++; continue; }
    // staleness
    if (typeof r.freshness_days === "number" && r.freshness_days > staleAfterDays) {
      removed_stale++; continue;
    }
    const arr = groups.get(r.entity_key) ?? [];
    arr.push(r);
    groups.set(r.entity_key, arr);
  }
  return { groups, removed_outside_scope, removed_stale };
}

/** Pure: full audit pipeline. Exported for tests. */
export function runOpportunityAudit(
  rows: EvidenceRow[],
  areas: AgencyArea[],
): { opportunities: ReturnType<typeof buildOpportunityFromEvidence>[]; audit: OpportunityAudit } {
  const scope = buildScopeMatcher(areas);
  const { groups, removed_outside_scope, removed_stale } = filterAndGroup(rows, scope);

  let candidates_before_filters = 0;
  let removed_insufficient_evidence = 0;
  let removed_weak_only = 0;
  let removed_restricted = 0;
  const dist = { low: 0, medium: 0, high: 0 };
  const final: ReturnType<typeof buildOpportunityFromEvidence>[] = [];

  for (const [key, group] of groups) {
    candidates_before_filters++;
    const [entity_type] = [group[0]?.entity_type ?? "area"] as const;
    const opp = buildOpportunityFromEvidence(entity_type as EvidenceRow["entity_type"], key, group, "agency");
    if (!opp) {
      // determine which guard tripped
      const hasOnlyRestricted = group.every((r) => r.compliance_visibility === "restricted" || r.compliance_visibility === "aggregate_only");
      if (hasOnlyRestricted) { removed_restricted++; continue; }
      const families = new Set(group.map((r) => r.source_code));
      if (families.size < 2) { removed_insufficient_evidence++; continue; }
      removed_weak_only++;
      continue;
    }
    dist[opp.evidence_summary.confidence]++;
    final.push(opp);
  }

  let empty_reason: string | null = null;
  if (final.length === 0) {
    if (candidates_before_filters === 0 && removed_outside_scope === 0 && rows.length === 0) {
      empty_reason = "evidence_ledger_empty";
    } else if (candidates_before_filters === 0 && removed_outside_scope > 0) {
      empty_reason = "no_evidence_inside_agency_scope";
    } else if (removed_insufficient_evidence > 0 && removed_weak_only === 0 && removed_restricted === 0) {
      empty_reason = "all_candidates_single_source";
    } else if (removed_restricted > 0 && removed_weak_only === 0) {
      empty_reason = "all_candidates_restricted";
    } else {
      empty_reason = "all_candidates_filtered";
    }
  }

  return {
    opportunities: final,
    audit: {
      candidates_before_filters,
      removed_insufficient_evidence,
      removed_weak_only,
      removed_restricted,
      removed_outside_scope,
      removed_stale,
      final_opportunities_count: final.length,
      confidence_distribution: dist,
      empty_reason,
    },
  };
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

  // Role check: admin OR agency_user OR owner email
  let allowed = OWNER_EMAILS.includes(email);
  if (!allowed) {
    const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", user.id);
    const set = new Set((roles ?? []).map((r: { role: string }) => r.role));
    allowed = set.has("admin") || set.has("owner") || set.has("agency_user");
  }
  if (!allowed) return json({ ok: false, error: { code: "FORBIDDEN" } }, 403);

  const url = new URL(req.url);
  const agencyId = url.searchParams.get("agency_id");

  // Load agency operating areas (scope-bound, never widened)
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
        opportunities: [],
        audit: null,
      },
    });
  }

  // Load evidence (admin_only + public, scope-bounded by entity_key prefix)
  const { data: evidence, error: evErr } = await supabase
    .from("civiko_evidence")
    .select("entity_type,entity_key,source_code,evidence_type,evidence_value,confidence,freshness_days,observed_at,explanation,raw_ref_id,compliance_visibility")
    .in("compliance_visibility", ["public", "admin_only"])
    .order("observed_at", { ascending: false })
    .limit(5000);
  if (evErr) return json({ ok: false, error: { code: "DB_ERROR", message: evErr.message } }, 500);

  const { opportunities, audit } = runOpportunityAudit((evidence ?? []) as EvidenceRow[], areaList);

  return json({
    ok: true,
    data: {
      data_status: opportunities.length > 0 ? "ok" : "empty",
      opportunities,
      audit,
      scope: {
        comuni: [...new Set(areaList.flatMap((a) => a.comuni ?? []))],
        microzones: [...new Set(areaList.flatMap((a) => [...(a.microzones ?? []), ...(a.quartieri ?? [])]))],
      },
    },
  });
});
