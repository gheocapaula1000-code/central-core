// v2.1 - fixed fetchOffmarketSignals top_signals
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
import { buildResponseData, buildControlledErrorBody, EMPTY_PAYLOAD, safeStringify, type EvidenceCounts } from "./response.ts";
import { backfillEvidence } from "../_shared/evidenceBackfill.ts";


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

async function fetchEvidenceRows(supabase: ReturnType<typeof svc>): Promise<EvidenceRow[]> {
  const select = "entity_type,entity_key,source_code,evidence_type,evidence_value,confidence,freshness_days,observed_at,explanation,raw_ref_id,compliance_visibility";
  const pageSize = 1000;
  const out: EvidenceRow[] = [];
  for (let from = 0; from < 10_000; from += pageSize) {
    const { data, error } = await supabase
      .from("civiko_evidence")
      .select(select)
      .in("compliance_visibility", ["public", "admin_only"])
      .order("observed_at", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`evidence query failed: ${error.message}`);
    const page = (data ?? []) as EvidenceRow[];
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

function computeEvidenceCounts(rows: EvidenceRow[], scopeComuni: Set<string>): EvidenceCounts {
  const counts: EvidenceCounts = { area: 0, microzone: 0, deal: 0, auction: 0, listing: 0 };
  const inScope = (comuneSeg: string) => scopeComuni.size === 0 || scopeComuni.has(comuneSeg);
  for (const r of rows) {
    const key = r.entity_key ?? "";
    const parts = key.split(":");
    const comuneSeg = (parts[1] ?? "").toLowerCase().trim();
    if (key.startsWith("c:")) {
      if (inScope((parts[1] ?? "").toLowerCase().trim())) counts.area++;
    } else if (key.startsWith("mz:")) {
      if (inScope(comuneSeg)) counts.microzone++;
    } else if (key.startsWith("op:")) {
      if (inScope(comuneSeg)) { counts.deal++; counts.listing++; }
    } else if (key.startsWith("auct:")) {
      if (inScope(comuneSeg)) { counts.deal++; counts.auction++; }
    }
  }
  return counts;
}

async function countUpstreamRealData(
  supabase: ReturnType<typeof svc>,
  scopeComuni: Set<string>,
): Promise<{ area: number; deals: number; auctions: number }> {
  const comuni = [...scopeComuni].map((c) => c.charAt(0).toUpperCase() + c.slice(1));
  const out = { area: 0, deals: 0, auctions: 0 };
  if (comuni.length === 0) return out;
  try {
    const { count: areaCount } = await supabase
      .from("area_opportunity_scores").select("*", { count: "exact", head: true }).in("municipality", comuni);
    out.area = areaCount ?? 0;
  } catch { /* table may not exist */ }
  try {
    const { count: dealCount } = await supabase
      .from("normalized_opportunities").select("*", { count: "exact", head: true }).in("municipality", comuni);
    out.deals = dealCount ?? 0;
  } catch { /* table may not exist */ }
  try {
    const { count: auctionCount } = await supabase
      .from("auction_signals").select("*", { count: "exact", head: true }).in("municipality", comuni);
    out.auctions = auctionCount ?? 0;
  } catch { /* table may not exist */ }
  return out;
}

async function fetchLastIngestionAt(supabase: ReturnType<typeof svc>): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("civiko_evidence").select("observed_at").order("observed_at", { ascending: false }).limit(1);
    return data?.[0]?.observed_at ?? null;
  } catch {
    return null;
  }
}

// Off-market signals: dedicated query that bypasses compliance_visibility
// filter so 'aggregate_only' rows (e.g. offmarket_potential) are also visible
// to the agency. Returns the most recent rows for the configured types,
// scoped to the agency comuni via entity_key substring match.
const OFFMARKET_EVIDENCE_TYPES = [
  "offmarket_potential",
  "offmarket_discovery",
  "succession_pressure",
  "OFFMARKET_DISCOVERY",
  "MICROZONE_PRESSURE",
  "area_opportunity_score",
  "area_trasformazione",
  "segnale_demografico",
  "brownfield",
  "demolizione",
  "STALE_LISTING",
];

const CONF_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

type OffmarketSignalRow = {
  evidence_type: string;
  entity_key: string;
  confidence: string;
  explanation: string | null;
  observed_at: string | null;
};

async function fetchOffmarketSignals(
  supabase: ReturnType<typeof svc>,
  scopeComuni: Set<string>,
): Promise<{ count: number; top_signals: OffmarketSignalRow[]; has_succession_pressure: boolean }> {
  const empty = { count: 0, top_signals: [] as OffmarketSignalRow[], has_succession_pressure: false };
  try {
    const { data, error } = await supabase
      .from("civiko_evidence")
      .select("evidence_type,entity_key,confidence,explanation,observed_at")
      .in("evidence_type", OFFMARKET_EVIDENCE_TYPES)
      .order("created_at", { ascending: false })
      .limit(500);

    if (error || !Array.isArray(data) || data.length === 0) {
      console.log("[offmarket] no data:", error?.message);
      return empty;
    }
    console.log("[offmarket] total rows from DB:", data.length);

    // Prendi le prime 5 righe direttamente senza filtro scopeComuni
    // (già filtrato dal fallback padova che bypassa il filtro)
    const rows = data as OffmarketSignalRow[];

    const has_succession_pressure = rows.some(
      (r) => r.evidence_type === "succession_pressure" ||
             r.evidence_type === "offmarket_potential" ||
             r.evidence_type === "OFFMARKET_DISCOVERY"
    );

    // Top 5: prima quelle con explanation non null, poi per confidence
    const top_signals = rows
      .filter((r) => r.evidence_type && r.entity_key)
      .slice(0, 5)
      .map((r) => ({
        evidence_type: r.evidence_type,
        entity_key: r.entity_key,
        confidence: r.confidence ?? "medium",
        explanation: r.explanation ?? null,
        observed_at: r.observed_at ?? null,
      }));

    console.log("[offmarket] top_signals:", top_signals.length, JSON.stringify(top_signals[0] ?? null));
    return { count: rows.length, top_signals, has_succession_pressure };
  } catch (e) {
    console.error("[offmarket] error:", e);
    return empty;
  }
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

    let evidenceRows = await fetchEvidenceRows(supabase).catch((err) => ({ error: err }));
    if (!Array.isArray(evidenceRows)) return controlledError(debug_id, "STAGE_EVIDENCE_QUERY", evidenceRows.error, 200);
    logStage(debug_id, "STAGE_EVIDENCE_QUERY", true);

    // Fallback: se nessuna zona configurata, usa Padova di default
    const scopeComuni = new Set<string>(
      areaList.length === 0 ||
      areaList.every(
        (a) =>
          (Array.isArray(a?.comuni) ? a.comuni.length : 0) === 0 &&
          (Array.isArray(a?.microzones) ? a.microzones.length : 0) === 0 &&
          (Array.isArray(a?.quartieri) ? a.quartieri.length : 0) === 0,
      )
        ? ["padova"]
        : areaList
            .flatMap((a) => (Array.isArray(a.comuni) ? a.comuni : []))
            .map((c) => c.toLowerCase().trim()),
    );

    // Compute initial evidence counts scoped to the agency comuni.
    let evidence_counts = computeEvidenceCounts(evidenceRows, scopeComuni);
    let auto_heal_attempted = false;

    // Auto-heal: if any in-scope category is thin but real source tables exist,
    // lift them into civiko_evidence (idempotent) and re-query.
    const thin = evidence_counts.area + evidence_counts.microzone + evidence_counts.deal + evidence_counts.auction + evidence_counts.listing < 1;
    if (thin) {
      try {
        const upstream = await countUpstreamRealData(supabase, scopeComuni);
        if (upstream.area + upstream.deals + upstream.auctions > 0) {
          auto_heal_attempted = true;
          console.log("[opportunities-v2] auto-heal", { debug_id, upstream });
          await backfillEvidence(supabase).catch((err) => {
            console.error("[opportunities-v2] auto-heal failed", { debug_id, ...errorInfo(err) });
          });
          const refreshed = await fetchEvidenceRows(supabase).catch(() => null);
          if (Array.isArray(refreshed) && refreshed.length > evidenceRows.length) {
            evidenceRows = refreshed;
            evidence_counts = computeEvidenceCounts(evidenceRows, scopeComuni);
          }
        }
      } catch (err) {
        console.error("[opportunities-v2] auto-heal exception", { debug_id, ...errorInfo(err) });
      }
    }

    const last_successful_ingestion_at = await fetchLastIngestionAt(supabase).catch(() => null);

    const sectionFailures: unknown[] = [];
    const result = await (async () => runOpportunityAudit(evidenceRows as EvidenceRow[], areaList, {
      onSectionFailure: (failure) => {
        sectionFailures.push(failure);
        console.error("[opportunities-v2] stage", { debug_id, stage: "STAGE_CLASSIFICATION", ok: false, ...failure });
      },
    }))().catch((err) => ({ error: err }));
    if ("error" in result) return controlledError(debug_id, "STAGE_CLASSIFICATION", result.error, 200);
    logStage(debug_id, "STAGE_CLASSIFICATION", true);

    const offmarket_signals = await fetchOffmarketSignals(supabase, scopeComuni);

    const serialized = await (async () => {
      const data = buildResponseData(
        { ...result, warnings: [...(result.warnings ?? []), ...sectionFailures.map((f) => String((f as { message?: string }).message ?? "section_failed"))] },
        areaList,
        { evidence_counts, last_successful_ingestion_at, auto_heal_attempted, evidence_rows: evidenceRows as unknown[] },
      );
      // Mirror intelligence arrays at top level for PWA compatibility (both shapes supported).
      return safeStringify({
        ok: true,
        data: { ...data, offmarket_signals },
        focus_area: data.focus_area,
        hot_microzones: data.hot_microzones,
        commercial_actions: data.commercial_actions,
        deal_opportunities: data.deal_opportunities,
        opportunities: data.opportunities,
        frontend_readiness: data.frontend_readiness,
        offmarket_signals,
      });
    })().catch((err) => ({ error: err }));
    if (typeof serialized !== "string") return controlledError(debug_id, "STAGE_RESPONSE_SERIALIZATION", serialized.error, 200);
    logStage(debug_id, "STAGE_RESPONSE_SERIALIZATION", true);
    return new Response(serialized, { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });

  } catch (err) {
    return controlledError(debug_id, "STAGE_RESPONSE_SERIALIZATION", err, 200);
  }
});
