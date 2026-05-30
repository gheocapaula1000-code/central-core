// civiko-agency-data-readiness
// GET /functions/v1/civiko-agency-data-readiness?agency_id=...
// Admin/owner-only diagnostic: returns scope, evidence counts, readiness score,
// missing arrays, last ingestion, auto-heal status. Self-contained (no cross-
// function imports) so the Supabase bundler can deploy it standalone.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import type { EvidenceRow } from "../_shared/evidenceLedger.ts";
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

interface EvidenceCounts { area: number; microzone: number; deal: number; auction: number; listing: number }

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

const SUCCESSION_TYPES = new Set(["SUCCESSION_PRESSURE", "LEGAL_EVENT", "INHERITANCE_SIGNAL"]);
const REVALUATION_TYPES = new Set(["MICROZONE_PRESSURE", "VELOCITY_ANOMALY", "PRICE_REVALUATION"]);

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

function computeSignalCounts(rows: EvidenceRow[], scopeComuni: Set<string>): Record<string, { succession_pressure_count: number; revaluation_count: number }> {
  const out: Record<string, { succession_pressure_count: number; revaluation_count: number }> = {};
  for (const r of rows) {
    const k = r.entity_key ?? "";
    const t = String((r as { evidence_type?: string }).evidence_type ?? "");
    const parts = k.split(":");
    const seg = (parts[1] ?? "").toLowerCase().trim();
    if (!seg) continue;
    if (scopeComuni.size > 0 && !scopeComuni.has(seg)) continue;
    if (!out[seg]) out[seg] = { succession_pressure_count: 0, revaluation_count: 0 };
    if (k.startsWith("leg:") || SUCCESSION_TYPES.has(t)) out[seg].succession_pressure_count++;
    if (REVALUATION_TYPES.has(t)) out[seg].revaluation_count++;
  }
  return out;
}


function buildReadiness(counts: EvidenceCounts, opts: { last_successful_ingestion_at: string | null; auto_heal_attempted: boolean }) {
  const missing: string[] = [];
  const required_actions: string[] = [];
  if (counts.area < 1) { missing.push("focus_area"); required_actions.push("ingest_area_opportunity_scores"); }
  if (counts.microzone < 1 && counts.deal < 1) { missing.push("hot_microzones"); required_actions.push("ingest_microzone_evidence"); }
  if (counts.deal < 1) { missing.push("deal_opportunities"); required_actions.push("ingest_normalized_opportunities_and_auctions"); }
  if (counts.area < 1 || counts.microzone < 1 || counts.deal < 1) {
    missing.push("commercial_actions");
    required_actions.push("derive_commercial_actions");
  }
  let score = 0;
  if (counts.deal > 0) score += 40;
  if (counts.area > 0) score += 20;
  if (counts.microzone > 0 || counts.deal > 0) score += 20;
  if (counts.area > 0 || counts.deal > 0) score += 20;
  return {
    ready: missing.length === 0,
    score,
    missing: [...new Set(missing)],
    required_actions: [...new Set(required_actions)],
    last_successful_ingestion_at: opts.last_successful_ingestion_at,
    evidence_counts: counts,
    auto_heal_attempted: opts.auto_heal_attempted,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ ok: false, error: { code: "METHOD_NOT_ALLOWED" } }, 405);

  const gate = await requireAdmin(req);
  if (gate instanceof Response) return gate;

  const url = new URL(req.url);
  const agency_id = url.searchParams.get("agency_id");
  const user_id = url.searchParams.get("user_id");
  const auto_heal = url.searchParams.get("auto_heal") !== "false";

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

  const areas = areaRows.map((row) => ({
    agency_id: typeof row.agency_id === "string" ? row.agency_id : null,
    user_id: typeof row.user_id === "string" ? row.user_id : null,
    comuni: asStringArray(row.comuni),
    microzones: asStringArray(row.microzones),
    quartieri: asStringArray(row.quartieri),
  }));
  const scopeComuni = new Set(areas.flatMap((a) => a.comuni).map((c) => c.toLowerCase().trim()));

  async function fetchEvidence(): Promise<EvidenceRow[]> {
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

  let evidence = await fetchEvidence().catch(() => [] as EvidenceRow[]);
  let counts = computeCounts(evidence, scopeComuni);

  const comuniCanonical = [...scopeComuni].map((c) => c.charAt(0).toUpperCase() + c.slice(1));
  const upstream = { area: 0, deals: 0, auctions: 0 };
  if (comuniCanonical.length > 0) {
    try { const r = await supabase.from("area_opportunity_scores").select("*", { count: "exact", head: true }).in("municipality", comuniCanonical); upstream.area = r.count ?? 0; } catch { /* ignore */ }
    try { const r = await supabase.from("normalized_opportunities").select("*", { count: "exact", head: true }).in("municipality", comuniCanonical); upstream.deals = r.count ?? 0; } catch { /* ignore */ }
    try { const r = await supabase.from("auction_signals").select("*", { count: "exact", head: true }).in("municipality", comuniCanonical); upstream.auctions = r.count ?? 0; } catch { /* ignore */ }
  }

  let auto_heal_attempted = false;
  if (auto_heal && (counts.area + counts.microzone + counts.deal) < 1 && (upstream.area + upstream.deals + upstream.auctions) > 0) {
    auto_heal_attempted = true;
    await backfillEvidence(supabase).catch(() => null);
    evidence = await fetchEvidence().catch(() => evidence);
    counts = computeCounts(evidence, scopeComuni);
  }

  const { data: lastIngest } = await supabase
    .from("civiko_evidence").select("observed_at").order("observed_at", { ascending: false }).limit(1);
  const last_successful_ingestion_at = lastIngest?.[0]?.observed_at ?? null;

  const readiness = buildReadiness(counts, { last_successful_ingestion_at, auto_heal_attempted });

  return json({
    ok: true,
    data: {
      scope: { comuni: [...scopeComuni], microzones: [...new Set(areas.flatMap((a) => [...a.microzones, ...a.quartieri]))] },
      areas,
      evidence_counts: counts,
      upstream_real_sources: upstream,
      frontend_readiness: readiness,
      auto_heal_attempted,
      last_successful_ingestion_at,
    },
  });
});
