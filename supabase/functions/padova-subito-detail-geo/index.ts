// padova-subito-detail-geo — SOFT enrichment (Firecrawl only, mai Apify full)
//
// Scopo: i privati Subito attivi hanno `indirizzo` = titolo annuncio,
// quartiere/lat/lng nulli, quindi il trigger civiko_padova_listings_zone_trg
// non può zonarli. Questa funzione legge la pagina di dettaglio e scrive
// SOLO evidenza reale: odonimo (via/piazza/corso...), quartiere presente
// nell'allowlist ufficiale, coordinate dal JSON-LD/GeoCoordinates.
//
// Nessun dato inventato: se manca evidenza la riga resta invariata.
//
// Auth: x-job-secret === CENTRAL_CORE_JOB_SECRET
// Payload: { limit?: number (default 8, max 20), fonte?: string, dry_run?: boolean }

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { canSpendFirecrawl, recordFirecrawlSpend } from "../_shared/firecrawlBudget.ts";
import { buildQuartiereIndex, parseDetailLocation } from "../_shared/padovaDetailEnrich.ts";

const HARD_CAP = 20;

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

/** Coordinate reali dal markup (JSON-LD geo / meta place). Fail-closed. */
export function extractGeo(html: string): { lat: number; lng: number } | null {
  const src = typeof html === "string" ? html.slice(0, 200_000) : "";
  const patterns = [
    /"latitude"\s*:\s*"?(-?\d{1,2}\.\d{3,})"?[\s\S]{0,120}?"longitude"\s*:\s*"?(-?\d{1,3}\.\d{3,})"?/i,
    /"lat"\s*:\s*"?(-?\d{1,2}\.\d{3,})"?[\s\S]{0,80}?"(?:lng|lon|long)"\s*:\s*"?(-?\d{1,3}\.\d{3,})"?/i,
  ];
  for (const re of patterns) {
    const m = src.match(re);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    // Bounding box comune di Padova (generoso ma vincolato).
    if (lat > 45.30 && lat < 45.53 && lng > 11.72 && lng < 12.05) return { lat, lng };
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b, null, 2), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  const secret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const incoming = req.headers.get("x-job-secret") ?? req.headers.get("x-internal-secret") ?? "";
  if (!secret || incoming !== secret) return json({ ok: false, error: "unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !srk) return json({ ok: false, error: "config_missing" }, 503);

  let body: { limit?: number; fonte?: string; dry_run?: boolean } = {};
  try { body = await req.json(); } catch { /* empty ok */ }
  const limit = Math.max(1, Math.min(Number(body.limit ?? 8), HARD_CAP));
  const fonte = typeof body.fonte === "string" && body.fonte ? body.fonte : "subito";
  const dryRun = body.dry_run === true;

  const sb = createClient(url, srk, { auth: { persistSession: false } });

  const budget = await canSpendFirecrawl(limit);
  if (!budget.ok) {
    return json({ ok: true, skipped: "firecrawl_budget", reason: budget.reason ?? "daily_cap" });
  }

  const { data: rows, error: selErr } = await sb
    .from("padova_listings")
    .select("id,url,indirizzo,quartiere,lat,lng,commercial_zone_slug")
    .eq("fonte", fonte)
    .eq("comune", "Padova")
    .is("expired_at", null)
    .is("commercial_zone_slug", null)
    .is("lat", null)
    .not("url", "is", null)
    .order("id", { ascending: true })
    .limit(limit);
  if (selErr) return json({ ok: false, error: selErr.message }, 500);

  const { data: mapRows, error: mapErr } = await sb
    .from("civiko_quartiere_commercial_zone_map")
    .select("quartiere_key")
    .limit(2000);
  if (mapErr) return json({ ok: false, error: mapErr.message }, 500);
  const quartiereIndex = buildQuartiereIndex((mapRows ?? []).map((r) => r.quartiere_key as string));

  let scraped = 0, updated = 0, noEvidence = 0;
  const errors: string[] = [];

  for (const r of rows ?? []) {
    if (dryRun) { noEvidence++; continue; }
    const res = await fcScrape(String(r.url));
    scraped++;
    if (!res.ok) { errors.push(`${r.id}:${res.error ?? "scrape_failed"}`); continue; }

    const loc = parseDetailLocation("subito.it", res.markdown, res.html, quartiereIndex);
    const geo = extractGeo(res.html);

    const patch: Record<string, unknown> = {};
    if (loc.address) patch.indirizzo = loc.address;
    if (loc.quartiere && !(r.quartiere ?? "")) patch.quartiere = loc.quartiere;
    if (geo) { patch.lat = geo.lat; patch.lng = geo.lng; }

    if (Object.keys(patch).length === 0) { noEvidence++; continue; }
    const { error: upErr } = await sb.from("padova_listings").update(patch).eq("id", r.id);
    if (upErr) errors.push(`${r.id}:${upErr.message}`);
    else updated++;
  }

  if (scraped > 0) await recordFirecrawlSpend(scraped, 1);

  return json({
    ok: true,
    fonte,
    dry_run: dryRun,
    candidates: (rows ?? []).length,
    scraped,
    updated,
    no_evidence: noEvidence,
    errors: errors.slice(0, 10),
  });
});
