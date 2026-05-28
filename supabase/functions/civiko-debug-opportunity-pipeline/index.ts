// civiko-debug-opportunity-pipeline
// GET /functions/v1/civiko-debug-opportunity-pipeline
// Admin-only end-to-end diagnostic: why the PWA radar is empty.
//
// PRINCIPLE: never widen geography. Report the truth per agency scope:
//   - which sources never ran
//   - which sources have records but no evidence
//   - which evidence is out-of-scope, weak-only, restricted
//   - which opportunity candidates were dropped and why
//   - which PWA endpoint would return what count
//
// No fake data, no demo records, no geographic widening.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { SOURCE_PLAN, isStale, type SourcePlan } from "../_shared/sourceScheduler.ts";
import {
  SOURCE_FAMILY,
  buildOpportunityFromEvidence,
  filterEvidenceForAudience,
} from "../_shared/opportunityEngine.ts";
import { SOURCE_STRENGTH, FORBIDDEN_SOLO_SOURCES, MIN_SOURCES_FOR_STRONG } from "../_shared/scoringOrchestration.ts";
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

// ───────────────────────── Scope helpers ─────────────────────────

export interface AgencyScope {
  agency_id: string | null;
  workspace_id: string | null;
  user_id: string | null;
  comune: string | null;
  comuni: string[];
  microzones: string[];
  zone_slugs: string[];
  province: string[];
  configured: boolean;
}

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

export function buildScopeMatchers(scope: AgencyScope) {
  const comuni = new Set(scope.comuni.map(norm).filter(Boolean));
  const microzones = new Set(scope.microzones.map(norm).filter(Boolean));
  const zoneSlugs = new Set(scope.zone_slugs.map(norm).filter(Boolean));
  return {
    matchesEntityKey(entity_key: string): boolean {
      const k = norm(entity_key);
      if (!k) return false;
      // areaKey: area:comune:cap:microzona — token-based contains
      const tokens = k.split(":").map(norm).filter(Boolean);
      for (const c of comuni) if (tokens.includes(c)) return true;
      for (const m of microzones) if (tokens.includes(m)) return true;
      for (const z of zoneSlugs) if (tokens.includes(z)) return true;
      return false;
    },
    hasScope: comuni.size + microzones.size + zoneSlugs.size > 0,
  };
}

async function loadAgencyScope(
  supabase: ReturnType<typeof svc>,
  params: { agency_id?: string | null; workspace_id?: string | null; user_id?: string | null; comune?: string | null; microzone?: string | null },
): Promise<AgencyScope> {
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
  // Allow URL params to NARROW (never widen). Only used when no agency mapping.
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

// ───────────────────────── Core diagnostic ─────────────────────────

export interface DiagnosticInput {
  scope: AgencyScope;
  registry: Array<Record<string, any>>;
  evidence: EvidenceRow[];
}

export interface DiagnosticReport {
  data_status: "setup_required" | "ok" | "empty";
  message?: string;
  agency_scope: AgencyScope;
  source_registry: {
    total_sources: number;
    active_sources: number;
    automated_sources: number;
    stale_sources: number;
    failed_sources: number;
  };
  ingestion_status: Array<{
    source_code: string;
    automation_status: string;
    status: string;
    last_run_at: string | null;
    last_success_at: string | null;
    last_error: string | null;
    record_count: number;
    records_in_agency_scope: number;
    stale: boolean;
    reason_if_zero: string | null;
  }>;
  evidence_status: {
    total_evidence_rows: number;
    evidence_rows_in_agency_scope: number;
    by_source_code: Record<string, number>;
    by_source_family: Record<string, number>;
    weak_only_count: number;
    restricted_filtered_count: number;
  };
  opportunity_engine: {
    candidates_before_filters: number;
    removed_insufficient_evidence: number;
    removed_weak_only: number;
    removed_restricted: number;
    removed_outside_scope: number;
    final_opportunities_count: number;
    confidence_distribution: Record<string, number>;
  };
  pwa_payload: {
    endpoint_name: string;
    returned_count: number;
    empty_reason: string | null;
    last_payload_at: string | null;
  };
  recommended_fixes: string[];
}

export function buildDiagnostic(input: DiagnosticInput): DiagnosticReport {
  const { scope, registry, evidence } = input;

  // ── Setup required short-circuit
  if (!scope.configured) {
    return {
      data_status: "setup_required",
      message: "Configura le zone operative dell'agenzia per attivare il radar.",
      agency_scope: scope,
      source_registry: { total_sources: registry.length, active_sources: 0, automated_sources: 0, stale_sources: 0, failed_sources: 0 },
      ingestion_status: [],
      evidence_status: { total_evidence_rows: evidence.length, evidence_rows_in_agency_scope: 0, by_source_code: {}, by_source_family: {}, weak_only_count: 0, restricted_filtered_count: 0 },
      opportunity_engine: { candidates_before_filters: 0, removed_insufficient_evidence: 0, removed_weak_only: 0, removed_restricted: 0, removed_outside_scope: 0, final_opportunities_count: 0, confidence_distribution: {} },
      pwa_payload: { endpoint_name: "agency-opportunities", returned_count: 0, empty_reason: "setup_required", last_payload_at: null },
      recommended_fixes: ["Configurare almeno un comune o una microzona in agency_operating_areas per l'agenzia."],
    };
  }

  const matchers = buildScopeMatchers(scope);
  const evidenceInScope = evidence.filter((e) => matchers.matchesEntityKey(e.entity_key));

  // ── Source registry summary
  const active = registry.filter((r) => r.implementation_status === "live" || r.implementation_status === "partial");
  const automated = registry.filter((r) => r.automation_status === "automated" || r.automation_status === "semi_automated");
  const failed = registry.filter((r) => r.last_error && !r.last_success_at);
  const stale = registry.filter((r) => isStale(r.last_success_at, r.stale_after_days));

  // ── Ingestion per source
  const evBySourceAll = new Map<string, EvidenceRow[]>();
  for (const e of evidence) {
    if (!evBySourceAll.has(e.source_code)) evBySourceAll.set(e.source_code, []);
    evBySourceAll.get(e.source_code)!.push(e);
  }
  const evBySourceScope = new Map<string, EvidenceRow[]>();
  for (const e of evidenceInScope) {
    if (!evBySourceScope.has(e.source_code)) evBySourceScope.set(e.source_code, []);
    evBySourceScope.get(e.source_code)!.push(e);
  }

  const ingestion_status = registry.map((r) => {
    const plan: SourcePlan | undefined = SOURCE_PLAN[r.source_code];
    const stale_b = isStale(r.last_success_at, r.stale_after_days);
    const inScopeCount = evBySourceScope.get(r.source_code)?.length ?? 0;
    let reason: string | null = null;
    if ((r.record_count ?? 0) === 0 && (evBySourceAll.get(r.source_code)?.length ?? 0) === 0) {
      if (!r.last_run_at && !r.last_success_at) {
        reason = plan?.automation_status === "manual_fallback"
          ? "manual_fallback: nessun import eseguito"
          : plan?.automation_status === "premium_on_demand"
          ? "premium_on_demand: nessuna richiesta gated registrata"
          : "source never ran";
      } else if (r.last_error && !r.last_success_at) {
        reason = "source failed (vedi last_error)";
      } else if (r.last_run_at && !r.last_success_at) {
        reason = "source ran ma nessun record prodotto";
      } else {
        reason = "no records / evidence writer non collegato";
      }
    } else if ((r.record_count ?? 0) > 0 && (evBySourceAll.get(r.source_code)?.length ?? 0) === 0) {
      reason = "records esistono ma evidence writer non wired";
    } else if (inScopeCount === 0) {
      reason = "records esistono ma non mappati alla zona dell'agenzia";
    } else if (stale_b) {
      reason = "evidence presente ma source stale";
    }
    return {
      source_code: r.source_code,
      automation_status: r.automation_status ?? plan?.automation_status ?? "unknown",
      status: r.implementation_status ?? "unknown",
      last_run_at: r.last_run_at ?? null,
      last_success_at: r.last_success_at ?? null,
      last_error: r.last_error ?? null,
      record_count: r.record_count ?? 0,
      records_in_agency_scope: inScopeCount,
      stale: stale_b,
      reason_if_zero: reason,
    };
  });

  // ── Evidence stats
  const by_source_code: Record<string, number> = {};
  const by_source_family: Record<string, number> = {};
  let weak_only_count = 0;
  let restricted_filtered_count = 0;
  for (const e of evidenceInScope) {
    by_source_code[e.source_code] = (by_source_code[e.source_code] ?? 0) + 1;
    const fam = SOURCE_FAMILY[e.source_code] ?? `unknown:${e.source_code}`;
    by_source_family[fam] = (by_source_family[fam] ?? 0) + 1;
    if ((SOURCE_STRENGTH[e.source_code] ?? "weak") === "weak") weak_only_count++;
    if (e.compliance_visibility === "restricted" || e.compliance_visibility === "aggregate_only") restricted_filtered_count++;
  }

  // ── Opportunity engine pass (group by entity_key)
  const groups = new Map<string, EvidenceRow[]>();
  for (const e of evidenceInScope) {
    if (!groups.has(e.entity_key)) groups.set(e.entity_key, []);
    groups.get(e.entity_key)!.push(e);
  }

  let candidates_before_filters = 0;
  let removed_insufficient_evidence = 0;
  let removed_weak_only = 0;
  let removed_restricted = 0;
  const final_opps: ReturnType<typeof buildOpportunityFromEvidence>[] = [];
  const confidence_distribution: Record<string, number> = { low: 0, medium: 0, high: 0 };

  for (const [key, rows] of groups) {
    candidates_before_filters++;
    const visible = filterEvidenceForAudience(rows, "agency");
    if (visible.length === 0) { removed_restricted++; continue; }
    const codes = new Set(visible.map((r) => r.source_code));
    const families = new Set([...codes].map((c) => SOURCE_FAMILY[c] ?? c));
    const hasNonWeak = [...codes].some((c) => (SOURCE_STRENGTH[c] ?? "weak") !== "weak");
    const onlyForbidden = [...codes].every((c) => FORBIDDEN_SOLO_SOURCES.has(c));
    if (onlyForbidden) { removed_restricted++; continue; }
    if (families.size < MIN_SOURCES_FOR_STRONG) { removed_insufficient_evidence++; continue; }
    if (!hasNonWeak) { removed_weak_only++; continue; }
    const opp = buildOpportunityFromEvidence(rows[0].entity_type, key, rows, "agency");
    if (!opp) { removed_insufficient_evidence++; continue; }
    final_opps.push(opp);
    confidence_distribution[opp.evidence_summary.confidence] =
      (confidence_distribution[opp.evidence_summary.confidence] ?? 0) + 1;
  }

  const removed_outside_scope = evidence.length - evidenceInScope.length;
  const final_count = final_opps.length;

  // ── PWA payload mirror
  let empty_reason: string | null = null;
  if (final_count === 0) {
    if (evidenceInScope.length === 0 && evidence.length > 0) empty_reason = "evidence_outside_agency_scope";
    else if (evidence.length === 0) empty_reason = "no_evidence_ingested";
    else if (removed_insufficient_evidence > 0) empty_reason = "insufficient_corroboration";
    else if (removed_weak_only > 0) empty_reason = "only_weak_aggregate_sources";
    else if (removed_restricted > 0) empty_reason = "only_restricted_sources";
    else empty_reason = "no_candidates";
  }

  // ── Recommended fixes
  const fixes: string[] = [];
  if (evidence.length === 0) {
    fixes.push("Eseguire civiko-scheduler /run-scheduled per popolare civiko_evidence dalle fonti automatizzate.");
  }
  for (const row of ingestion_status) {
    if (row.reason_if_zero === "records esistono ma evidence writer non wired") {
      fixes.push(`Collegare ${row.source_code} all'evidence ledger (recordEvidence).`);
    }
  }
  if (evidence.length > 0 && evidenceInScope.length === 0) {
    fixes.push(`Nessuna evidence mappata alla zona ${scope.comune ?? ""}. Verificare normalizzazione entity_key (areaKey/microzoneKey).`);
  }
  if (removed_insufficient_evidence > 0) {
    fixes.push("Aumentare corroborazione: serve almeno 2 famiglie di fonti indipendenti per ogni opportunità.");
  }
  if (removed_weak_only > 0) {
    fixes.push("Aggiungere almeno una fonte non-weak (es. F1 OMI, F16 PVP, F21 portali) accanto alle aggregate.");
  }
  if (stale.length > 0) {
    fixes.push(`Rieseguire ${stale.length} fonti stale: ${stale.map((s) => s.source_code).join(", ")}.`);
  }

  return {
    data_status: final_count > 0 ? "ok" : "empty",
    agency_scope: scope,
    source_registry: {
      total_sources: registry.length,
      active_sources: active.length,
      automated_sources: automated.length,
      stale_sources: stale.length,
      failed_sources: failed.length,
    },
    ingestion_status,
    evidence_status: {
      total_evidence_rows: evidence.length,
      evidence_rows_in_agency_scope: evidenceInScope.length,
      by_source_code,
      by_source_family,
      weak_only_count,
      restricted_filtered_count,
    },
    opportunity_engine: {
      candidates_before_filters,
      removed_insufficient_evidence,
      removed_weak_only,
      removed_restricted,
      removed_outside_scope,
      final_opportunities_count: final_count,
      confidence_distribution,
    },
    pwa_payload: {
      endpoint_name: "agency-opportunities",
      returned_count: final_count,
      empty_reason,
      last_payload_at: null,
    },
    recommended_fixes: fixes,
  };
}

// ───────────────────────── HTTP entry ─────────────────────────

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

  const { data: registry = [] } = await supabase
    .from("civiko_source_registry").select("*").order("source_code");

  const { data: evidenceRaw = [] } = await supabase
    .from("civiko_evidence").select("*").order("observed_at", { ascending: false }).limit(5000);

  const report = buildDiagnostic({
    scope,
    registry: registry ?? [],
    evidence: (evidenceRaw ?? []) as EvidenceRow[],
  });

  return json({ ok: true, data: report });
});
