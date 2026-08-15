// padova-detail-enrich-collect
// Arricchimento "detail" dei collect Padova (Subito / Idealista) PRIMA della promote.
//
// Cosa fa:
//   1. Seleziona da padova_collect_v2_items le righe recenti di subito/idealista
//      senza quartiere e con indirizzo generico ("Padova (PD)").
//   2. Scrapa la pagina di dettaglio via Firecrawl (budget guard obbligatorio).
//   3. Scrive SOLO quartiere/raw_address dimostrabili (allowlist ufficiale dei
//      quartieri + odonimo reale). Nessun dato inventato.
//
// Auth: x-job-secret === CENTRAL_CORE_JOB_SECRET.
// Payload: { since_hours?: number, limit?: number, dry_run?: boolean }

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { canSpendFirecrawl, recordFirecrawlSpend } from "../_shared/firecrawlBudget.ts";
import {
  buildCollectPatch,
  buildQuartiereIndex,
  DETAIL_ENRICH_DEFAULT_LIMIT,
  DETAIL_ENRICH_HARD_CAP,
  normalizeDetailPortal,
  parseDetailLocation,
  selectDetailEnrichCandidates,
} from "../_shared/padovaDetailEnrich.ts";

async function fcScrape(
  url: string,
  timeoutMs = 25_000,
): Promise<{ ok: boolean; markdown: string; html: string; error?: string }> {
  const key = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
  if (!key) return { ok: false, markdown: "", html: "", error: "FIRECRAWL_API_KEY missing" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown", "html"], onlyMainContent: false }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    const root = data?.data ?? data;
    if (!res.ok) return { ok: false, markdown: "", html: "", error: `HTTP ${res.status}` };
    return {
      ok: true,
      markdown: typeof root?.markdown === "string" ? root.markdown.slice(0, 40_000) : "",
      html: typeof root?.html === "string" ? root.html.slice(0, 120_000) : "",
    };
  } catch (e) {
    return { ok: false, markdown: "", html: "", error: String((e as Error)?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b, null, 2), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  const secret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!secret || req.headers.get("x-job-secret") !== secret) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !srk) return json({ ok: false, error: "config_missing" }, 503);

  let body: { since_hours?: number; limit?: number; dry_run?: boolean } = {};
  try { body = await req.json(); } catch { /* empty ok */ }
  const sinceHours = Math.max(1, Math.min(Number(body.since_hours ?? 24), 168));
  const limit = Math.max(
    1,
    Math.min(Number(body.limit ?? DETAIL_ENRICH_DEFAULT_LIMIT), DETAIL_ENRICH_HARD_CAP),
  );
  const dryRun = body.dry_run === true;

  const sb = createClient(url, srk, { auth: { persistSession: false } });

  // Budget guard: 1 pagina Firecrawl per candidato.
  const budget = await canSpendFirecrawl(limit);
  if (!budget.ok) {
    return json({
      ok: true,
      skipped: "firecrawl_budget",
      reason: budget.reason ?? "daily_cap",
      spent: budget.spent,
      cap: budget.cap,
    });
  }

  const sinceIso = new Date(Date.now() - sinceHours * 3600_000).toISOString();
  const { data: rows, error: selErr } = await sb
    .from("padova_collect_v2_items")
    .select("id, portal, url, quartiere, raw_address, updated_at")
    .gte("updated_at", sinceIso)
    .in("portal", ["subito", "subito.it", "idealista", "idealista.it"])
    .is("quartiere", null)
    .order("updated_at", { ascending: false })
    .limit(400);
  if (selErr) return json({ ok: false, error: selErr.message }, 500);

  const candidates = selectDetailEnrichCandidates(
    (rows ?? []).map((r) => ({ ...r, id: String(r.id) })),
    limit,
  );

  // Allowlist ufficiale dei quartieri: nessun valore fuori mappa.
  const { data: mapRows, error: mapErr } = await sb
    .from("civiko_quartiere_commercial_zone_map")
    .select("quartiere_key")
    .limit(2000);
  if (mapErr) return json({ ok: false, error: mapErr.message }, 500);
  const quartiereIndex = buildQuartiereIndex((mapRows ?? []).map((r) => r.quartiere_key as string));

  let scraped = 0;
  let updated = 0;
  let noEvidence = 0;
  const errors: string[] = [];

  for (const c of candidates) {
    const portal = normalizeDetailPortal(c.portal);
    if (!portal || !c.url) continue;
    if (dryRun) { noEvidence++; continue; }
    const res = await fcScrape(c.url);
    scraped++;
    if (!res.ok) { errors.push(`${c.id}:${res.error ?? "scrape_failed"}`); continue; }
    const loc = parseDetailLocation(portal, res.markdown, res.html, quartiereIndex);
    const patch = buildCollectPatch(c, loc);
    if (!patch) { noEvidence++; continue; }
    const { error: upErr } = await sb
      .from("padova_collect_v2_items")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", c.id);
    if (upErr) errors.push(`${c.id}:${upErr.message}`);
    else updated++;
  }

  if (scraped > 0) await recordFirecrawlSpend(scraped, 1);

  return json({
    ok: true,
    dry_run: dryRun,
    candidates: candidates.length,
    scraped,
    updated,
    no_evidence: noEvidence,
    errors: errors.slice(0, 10),
  });
});
