// ═══════════════════════════════════════════════════════════════
// ingest-opportunity — MVP motore dati Civiko One (pilota Padova)
// Riceve un payload grezzo, lo salva in raw_sources_ingest,
// poi normalizza + score + dedupe e scrive in normalized_opportunities.
// Nessuna AI, nessuno scraping: solo accept + normalize.
// ═══════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";

const PADOVA_MICROZONE = new Set([
  "arcella", "centro storico", "portello", "sacra famiglia", "forcellini",
  "guizza", "madonna pellegrina", "albignasego", "selvazzano dentro", "abano terme",
]);

interface RawInput {
  source_name: string;
  source_url?: string;
  municipality?: string;
  microzone?: string;
  title?: string;
  address_text?: string;
  property_type?: string;
  ask_price?: number | string | null;
  surface_mq?: number | string | null;
  fetched_at?: string;
  raw_payload?: Record<string, unknown>;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.,-]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function norm(s?: string | null): string {
  return (s ?? "").toString().trim().toLowerCase().replace(/\s+/g, " ");
}

function dedupeKey(r: { title?: string; municipality?: string; address_text?: string; ask_price?: number | null; surface_mq?: number | null }): string {
  return [
    norm(r.title).slice(0, 60),
    norm(r.municipality),
    norm(r.address_text).slice(0, 60),
    r.ask_price ?? "",
    r.surface_mq ?? "",
  ].join("|");
}

function score(r: {
  title?: string; municipality?: string; microzone?: string; address_text?: string;
  property_type?: string; ask_price?: number | null; surface_mq?: number | null;
  source_url?: string; fetched_at: string;
}): { freshness_days: number; completeness: number; priority: number; reason: string } {
  const reasons: string[] = [];
  // freshness
  const ageMs = Date.now() - Date.parse(r.fetched_at);
  const freshness_days = Math.max(0, Math.floor(ageMs / 86_400_000));
  const freshnessScore = freshness_days <= 7 ? 30 : freshness_days <= 30 ? 20 : freshness_days <= 90 ? 10 : 0;
  reasons.push(`freshness=${freshnessScore} (${freshness_days}gg)`);

  // completeness (7 campi chiave)
  const fields = [r.title, r.municipality, r.address_text, r.property_type, r.ask_price, r.surface_mq, r.source_url];
  const filled = fields.filter((f) => f != null && f !== "").length;
  const completeness = Math.round((filled / fields.length) * 100);
  reasons.push(`completeness=${completeness}% (${filled}/7)`);

  // rilevanza territoriale
  const muni = norm(r.municipality);
  const mz = norm(r.microzone);
  let territory = 0;
  if (muni === "padova") territory += 25;
  else if (muni) territory += 10;
  if (mz && PADOVA_MICROZONE.has(mz)) territory += 15;
  reasons.push(`territory=${territory}`);

  // qualità minima del dato
  const minQuality = r.title && (r.address_text || r.microzone) && (r.ask_price || r.surface_mq) ? 15 : 0;
  reasons.push(`minQuality=${minQuality}`);

  const priority = Math.min(100, freshnessScore + Math.round(completeness * 0.3) + territory + minQuality);
  return {
    freshness_days,
    completeness,
    priority,
    reason: reasons.join(" | "),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: { code: "method_not_allowed" } }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // fail-closed: il job secret è obbligatorio
  if (!JOB_SECRET) {
    return new Response(JSON.stringify({ error: { code: "misconfigured", message: "CENTRAL_CORE_JOB_SECRET not set" } }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const provided = req.headers.get("x-job-secret") ?? "";
  if (provided.length !== JOB_SECRET.length || provided !== JOB_SECRET) {
    return new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: { code: "bad_json" } }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const items: RawInput[] = Array.isArray(body) ? body as RawInput[] : [body as RawInput];
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const out: Array<{ raw_id?: string; normalized_id?: string; warning?: string; error?: string }> = [];

  for (const item of items) {
    if (!item || typeof item !== "object" || !item.source_name) {
      out.push({ error: "missing source_name" });
      continue;
    }
    const fetched_at = item.fetched_at ?? new Date().toISOString();

    // 1) save raw
    const { data: raw, error: rawErr } = await sb.from("raw_sources_ingest").insert({
      source_name: item.source_name,
      source_url: item.source_url ?? null,
      fetched_at,
      raw_payload: item.raw_payload ?? item,
      municipality: item.municipality ?? null,
      microzone: item.microzone ?? null,
    }).select("id").single();

    if (rawErr || !raw) {
      out.push({ error: `raw_insert: ${rawErr?.message ?? "unknown"}` });
      continue;
    }

    // 2) normalize
    const ask_price = num(item.ask_price);
    const surface_mq = num(item.surface_mq);
    const title = (item.title ?? "").toString().slice(0, 200) || "(senza titolo)";
    const normalized = {
      raw_id: raw.id,
      title,
      municipality: item.municipality ?? null,
      microzone: item.microzone ?? null,
      address_text: item.address_text ?? null,
      property_type: item.property_type ?? null,
      ask_price,
      surface_mq,
      source_name: item.source_name,
      source_url: item.source_url ?? null,
    };
    const dk = dedupeKey({
      title: normalized.title,
      municipality: normalized.municipality ?? undefined,
      address_text: normalized.address_text ?? undefined,
      ask_price,
      surface_mq,
    });
    const s = score({ ...normalized, fetched_at });

    // 3) dedupe — match prudente
    const { data: existing } = await sb.from("normalized_opportunities")
      .select("id, first_seen_at")
      .eq("dedupe_key", dk)
      .limit(1)
      .maybeSingle();

    let possible_duplicate = false;
    if (!existing) {
      // ricerca fuzzy semplice: stesso comune + stesso prezzo + stessi mq -> dubbio
      if (normalized.municipality && (ask_price || surface_mq)) {
        const q = sb.from("normalized_opportunities")
          .select("id")
          .eq("municipality", normalized.municipality)
          .limit(1);
        if (ask_price) q.eq("ask_price", ask_price);
        if (surface_mq) q.eq("surface_mq", surface_mq);
        const { data: fuzzy } = await q;
        if (fuzzy && fuzzy.length > 0) possible_duplicate = true;
      }
    }

    if (existing) {
      // update: refresh last_seen + score
      const { data: upd, error: updErr } = await sb.from("normalized_opportunities").update({
        ...normalized,
        last_seen_at: new Date().toISOString(),
        freshness_days: s.freshness_days,
        completeness_score: s.completeness,
        priority_score: s.priority,
        scoring_reason: s.reason,
        dedupe_key: dk,
      }).eq("id", existing.id).select("id").single();
      if (updErr) out.push({ raw_id: raw.id, error: `norm_update: ${updErr.message}` });
      else out.push({ raw_id: raw.id, normalized_id: upd.id });
    } else {
      const { data: ins, error: insErr } = await sb.from("normalized_opportunities").insert({
        ...normalized,
        freshness_days: s.freshness_days,
        completeness_score: s.completeness,
        priority_score: s.priority,
        scoring_reason: s.reason,
        possible_duplicate,
        dedupe_key: dk,
      }).select("id").single();
      if (insErr) out.push({ raw_id: raw.id, error: `norm_insert: ${insErr.message}` });
      else out.push({ raw_id: raw.id, normalized_id: ins.id, warning: possible_duplicate ? "possible_duplicate" : undefined });
    }
  }

  return new Response(JSON.stringify({ ok: true, results: out }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
