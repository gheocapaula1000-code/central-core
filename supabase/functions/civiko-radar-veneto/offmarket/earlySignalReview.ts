// ═══════════════════════════════════════════════════════════════
// earlySignalReview.ts — rescore esistenti + promotion controllata.
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { evaluateCandidatePage, type EvalResult } from "./earlySignalScoring.ts";

function sb() {
  const url = Deno.env.get("SUPABASE_URL");
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !svc) throw new Error("supabase service role missing");
  return createClient(url, svc, { auth: { persistSession: false } });
}

export interface RescoreBody {
  run_id?: string;
  candidate_ids?: string[];
  dryRun?: boolean;
  import?: boolean;
  limit?: number;
}

export async function runRescoreEarlyCandidates(body: RescoreBody) {
  const dryRun = body.dryRun !== false;
  const doImport = body.import === true && !dryRun;
  const limit = Math.min(body.limit ?? 500, 1000);
  const client = sb();

  let q = client.from("early_offmarket_signal_candidates")
    .select("id, run_id, comune, provincia, title, summary, source_url, source_name, payload, status, confidence_score, signal_type")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (body.run_id) q = q.eq("run_id", body.run_id);
  if (body.candidate_ids?.length) q = q.in("id", body.candidate_ids);

  const { data: rows, error } = await q;
  if (error) throw new Error(`fetch candidates: ${error.message}`);
  const list = rows ?? [];

  const before: Record<string, number> = {};
  const after: Record<string, number> = {};
  let upgraded_to_needs_review = 0, upgraded_to_importable = 0;
  let rejected_non_real_estate = 0, rejected_generic = 0;
  const updates: Array<{ id: string; r: EvalResult }> = [];
  const sample_rejected: any[] = [];

  for (const r of list) {
    before[r.status ?? "discovered"] = (before[r.status ?? "discovered"] ?? 0) + 1;
    const text = `${r.title ?? ""}\n${r.summary ?? ""}\n${(r.payload as any)?.markdown ?? ""}`;
    const res = evaluateCandidatePage({
      title: r.title ?? null,
      text,
      source_url: r.source_url,
      source_name: r.source_name ?? null,
      comune: r.comune ?? "",
      provincia: r.provincia ?? "",
    });
    after[res.status] = (after[res.status] ?? 0) + 1;

    if (res.status === "needs_review" && r.status !== "needs_review") upgraded_to_needs_review++;
    if (res.importable) upgraded_to_importable++;
    if (res.rejection_reason === "non_real_estate_asset") rejected_non_real_estate++;
    if (res.status === "rejected" && res.rejection_reason && res.rejection_reason !== "non_real_estate_asset") rejected_generic++;
    if (res.status === "rejected" && sample_rejected.length < 10) {
      sample_rejected.push({ id: r.id, title: r.title, reason: res.rejection_reason, url: r.source_url });
    }
    updates.push({ id: r.id, r: res });
  }

  // Sort top by priority
  updates.sort((a, b) => b.r.priority_score - a.r.priority_score);
  const top_candidates = updates.slice(0, 10).map(({ id, r }) => ({
    id, priority: r.priority_score, status: r.status, asset_type: r.asset_type,
    re_rel: r.real_estate_relevance_score, cv: r.commercial_value_score, conf: r.confidence_score,
    title: list.find((x) => x.id === id)?.title,
  }));

  let written = 0;
  if (doImport) {
    for (const u of updates) {
      const { error: uerr } = await client.from("early_offmarket_signal_candidates").update({
        status: u.r.status,
        priority_score: u.r.priority_score,
        commercial_value_score: u.r.commercial_value_score,
        real_estate_relevance_score: u.r.real_estate_relevance_score,
        confidence_score: u.r.confidence_score,
        asset_type: u.r.asset_type,
        location_detail: u.r.location_detail ?? null,
        amount_text: u.r.amount_text ?? null,
        deadline_text: u.r.deadline_text ?? null,
        publication_date: u.r.publication_date ?? null,
        review_reason: u.r.review_reason ?? null,
        rejection_reason: u.r.rejection_reason ?? null,
        ai_summary: u.r.ai_summary ?? null,
        agent_action: u.r.agent_action ?? null,
        owner_pitch: u.r.owner_pitch ?? null,
        investor_pitch: u.r.investor_pitch ?? null,
        needs_review: u.r.needs_review,
        privacy_safe: u.r.privacy_safe,
        quality: u.r.quality,
        signal_type: String(u.r.signal_type),
        import_recommendation: u.r.importable ? "importable" : (u.r.status === "needs_review" ? "needs_review" : "reject"),
      }).eq("id", u.id);
      if (!uerr) written++;
    }
  }

  return {
    ok: true,
    run_id: body.run_id ?? null,
    dryRun,
    imported: doImport,
    total_candidates: list.length,
    before_status_distribution: before,
    after_status_distribution: after,
    upgraded_to_needs_review,
    upgraded_to_importable,
    rejected_non_real_estate,
    rejected_generic,
    written,
    top_candidates,
    sample_rejected,
  };
}

export interface PromoteBody {
  candidate_id: string;
  target?: "territorial_signals" | "radar_signals";
  reviewer_note?: string;
  reviewer?: string;
  force?: boolean;
}

export async function runPromoteEarlyCandidate(body: PromoteBody) {
  if (!body.candidate_id) return { ok: false, error: "candidate_id required" };
  const target = body.target ?? "territorial_signals";
  const client = sb();

  const { data: cand, error } = await client.from("early_offmarket_signal_candidates")
    .select("*").eq("id", body.candidate_id).maybeSingle();
  if (error || !cand) return { ok: false, error: error?.message ?? "candidate not found" };

  if (cand.status === "promoted") return { ok: false, reason: "already_promoted" };
  if (cand.status === "rejected") return { ok: false, reason: "rejected_cannot_promote" };
  if (cand.privacy_safe === false) return { ok: false, reason: "privacy_unsafe" };
  if (cand.status === "needs_review" && !(body.force === true && body.reviewer_note)) {
    return { ok: false, reason: "needs_review_requires_force_and_note" };
  }
  if (!["approved","needs_review"].includes(cand.status) && !body.force) {
    return { ok: false, reason: `status ${cand.status} not promotable` };
  }

  // Check if territorial_signals table exists; if not, just mark as promoted with target="candidate_only"
  let promoted_to = `${target}:not_persisted`;
  try {
    if (target === "territorial_signals") {
      // Check table existence by attempting an insert; many projects don't have it yet.
      const row = {
        comune: cand.comune,
        provincia: cand.provincia,
        signal_type: cand.signal_type,
        title: cand.title,
        description: cand.ai_summary ?? cand.summary,
        source_url: cand.source_url,
        source_name: cand.source_name,
        confidence_score: cand.confidence_score,
        quality: cand.quality,
        data_basis: cand.data_basis,
        payload: { ...(cand.payload ?? {}), candidate_id: cand.id, reviewer_note: body.reviewer_note ?? null },
        fingerprint: cand.fingerprint,
      };
      const { error: insErr } = await client.from("territorial_signals").insert(row);
      if (insErr && !/duplicate key|unique/i.test(insErr.message)) {
        // Table likely missing — fall back to candidate-only promotion
        promoted_to = `territorial_signals:skipped(${insErr.message.slice(0, 60)})`;
      } else {
        promoted_to = "territorial_signals";
      }
    }

    if (cand.commercial_value_score >= 70 && target === "territorial_signals") {
      // optional radar_signal mirror; ignore if table missing
      try {
        await client.from("radar_signals").insert({
          comune: cand.comune, provincia: cand.provincia,
          signal_type: cand.signal_type, title: cand.title,
          source_url: cand.source_url, payload: cand.payload, fingerprint: cand.fingerprint,
        });
        promoted_to += "+radar_signals";
      } catch { /* ignore */ }
    }
  } catch (e) {
    promoted_to = `error:${e instanceof Error ? e.message : String(e)}`;
  }

  await client.from("early_offmarket_signal_candidates").update({
    status: "promoted",
    promoted_at: new Date().toISOString(),
    promoted_to,
    reviewed_at: new Date().toISOString(),
    reviewed_by: body.reviewer ?? null,
    review_reason: body.reviewer_note ?? cand.review_reason,
  }).eq("id", cand.id);

  return { ok: true, candidate_id: cand.id, promoted_to, status: "promoted" };
}
