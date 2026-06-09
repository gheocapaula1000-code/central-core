// test-detail-coverage-padova
// Mini-test: misura copertura campi dettaglio su ~10 annunci per portale.
// Usa Firecrawl per TUTTI i portali (Apify detail actors non validati = rischio spreco).
// Spesa Apify: $0. Spesa Firecrawl: ~40 scrape, trascurabile.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
const FIRECRAWL_V2 = "https://api.firecrawl.dev/v2";
async function fcScrape(url: string, opts: { timeoutMs?: number; formats?: string[] } = {}): Promise<{ ok: boolean; url: string; markdown?: string | null; error?: string }> {
  const k = Deno.env.get("FIRECRAWL_API_KEY");
  if (!k) return { ok: false, url, error: "FIRECRAWL_API_KEY missing" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch(`${FIRECRAWL_V2}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: opts.formats ?? ["markdown"], onlyMainContent: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, url, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    const root = (data as { data?: unknown }).data ?? data;
    const md: string | null = (root as { markdown?: string }).markdown ?? null;
    return { ok: true, url, markdown: md ? md.slice(0, 15_000) : null };
  } catch (e) {
    return { ok: false, url, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
import { canSpendApify, recordApifySpend } from "../_shared/apifyBudget.ts";

const JOB_ID = "e9709a73-e91f-49c4-bc11-a8bf27829875";
const PORTALS = ["immobiliare", "idealista", "casa", "subito"] as const;
const PER_PORTAL = 10;

type Extracted = {
  mq: number | null;
  locali: number | null;
  piano: string | null;
  bagni: number | null;
  civico: string | null;
  agency: string | null;
  tipologia: string | null;
  riscaldamento: string | null;
  stato: string | null;
  lat: number | null;
  lng: number | null;
};

function num(s: string | undefined | null): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractFromMarkdown(md: string): Extracted {
  const t = md.replace(/\s+/g, " ");
  const lower = t.toLowerCase();

  // mq / superficie
  let mq: number | null = null;
  const mqM = lower.match(/(?:superficie[^0-9]{0,30}|\b)(\d{2,4})\s*(?:m²|mq|m2|metri\s*quadr)/);
  if (mqM) mq = num(mqM[1]);

  // locali
  let locali: number | null = null;
  const locM = lower.match(/(\d{1,2})\s*(?:local[ei]|stanze|vani)\b/);
  if (locM) locali = num(locM[1]);

  // piano
  let piano: string | null = null;
  const pM = lower.match(/\bpiano[^0-9a-z]{0,8}(terra|rialzato|seminterrato|interrato|attico|\d{1,2}°?)/);
  if (pM) piano = pM[1];

  // bagni
  let bagni: number | null = null;
  const bM = lower.match(/(\d{1,2})\s*bagn[io]/);
  if (bM) bagni = num(bM[1]);

  // civico — dopo via/viale/piazza
  let civico: string | null = null;
  const cM = lower.match(/\b(?:via|viale|v\.le|piazza|p\.zza|piazzale|corso|c\.so|largo|vicolo|strada|borgo)\s+[a-zà-ú' .]{2,40}?,?\s*(\d{1,4}[a-z]?)\b/);
  if (cM) civico = cM[1];

  // agency — euristica grossolana
  let agency: string | null = null;
  const aM = t.match(/(?:Agenzia|Pubblicato da|Annuncio di|Contatta)\s*[:\-]?\s*([A-Z][A-Za-z0-9&.' \-]{2,40})/);
  if (aM) agency = aM[1].trim();

  // tipologia
  let tipologia: string | null = null;
  const tipM = lower.match(/\b(appartamento|attico|villa|villetta|bilocale|trilocale|quadrilocale|monolocale|loft|mansarda|rustico|casa indipendente|porzione di casa)\b/);
  if (tipM) tipologia = tipM[1];

  // riscaldamento
  let riscaldamento: string | null = null;
  const riM = lower.match(/riscaldamento[^a-z]{0,8}(autonomo|centralizzato|a pavimento|a metano|a pellet)/);
  if (riM) riscaldamento = riM[1];

  // stato
  let stato: string | null = null;
  const stM = lower.match(/\bstato[^a-z]{0,8}(nuovo|ottimo|buono|da ristrutturare|ristrutturato|abitabile)/);
  if (stM) stato = stM[1];

  // lat/lng da pattern JSON nel markdown (raro)
  let lat: number | null = null, lng: number | null = null;
  const llM = t.match(/"lat(?:itude)?"\s*:\s*(4\d\.\d+)[^0-9]+"l(?:o|n)g(?:itude)?"\s*:\s*(1\d\.\d+)/);
  if (llM) { lat = Number(llM[1]); lng = Number(llM[2]); }

  return { mq, locali, piano, bagni, civico, agency, tipologia, riscaldamento, stato, lat, lng };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!jobSecret || req.headers.get("x-job-secret") !== jobSecret) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Apify budget guard (anche se non spendiamo, lo richiediamo per rispetto regole)
  const estApify = 0;
  const guard = await canSpendApify(estApify);
  if (!guard.ok) {
    return new Response(JSON.stringify({ ok: false, error: "apify_budget_blocked", guard }), {
      status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // 1. Pick 10 URLs per portal
  const samples: { portal: string; url: string }[] = [];
  for (const p of PORTALS) {
    const { data } = await sb
      .from("padova_collect_v2_items")
      .select("url")
      .eq("job_id", JOB_ID)
      .eq("portal", p)
      .not("url", "is", null)
      .limit(PER_PORTAL);
    for (const row of (data ?? [])) {
      const u = (row as { url?: string }).url;
      if (u) samples.push({ portal: p, url: u });
    }
  }

  // 2. Scrape ciascuno con Firecrawl
  const results: { portale: string; url: string; ok: boolean; extracted: Extracted | null; error?: string }[] = [];
  const t0 = Date.now();
  for (const s of samples) {
    const r = await fcScrape(s.url, { timeoutMs: 30_000, formats: ["markdown"] });
    if (!r.ok || !r.markdown) {
      results.push({ portale: s.portal, url: s.url, ok: false, extracted: null, error: r.error ?? "no_markdown" });
      continue;
    }
    const ex = extractFromMarkdown(r.markdown);
    results.push({ portale: s.portal, url: s.url, ok: true, extracted: ex });
  }
  const elapsedMs = Date.now() - t0;

  await recordApifySpend(0, 0);

  // 3. Copertura % (per campo, su tutti i risultati ok)
  const oks = results.filter((r) => r.ok && r.extracted);
  const total = oks.length || 1;
  const cov = (k: keyof Extracted) =>
    Math.round((oks.filter((r) => r.extracted![k] !== null && r.extracted![k] !== "").length / total) * 100);

  const copertura = {
    mq: cov("mq"),
    locali: cov("locali"),
    piano: cov("piano"),
    bagni: cov("bagni"),
    civico: cov("civico"),
    agency: cov("agency"),
    tipologia: cov("tipologia"),
    lat_lng: Math.round((oks.filter((r) => r.extracted!.lat !== null && r.extracted!.lng !== null).length / total) * 100),
  };

  const per_portal: Record<string, number> = {};
  for (const p of PORTALS) per_portal[p] = results.filter((r) => r.portale === p).length;

  const esempi = results.slice(0, 8).map((r) => ({
    portale: r.portale,
    url: r.url,
    ok: r.ok,
    mq: r.extracted?.mq ?? 0,
    locali: r.extracted?.locali ?? 0,
    piano: r.extracted?.piano ?? "",
    bagni: r.extracted?.bagni ?? 0,
    civico: r.extracted?.civico ?? "",
    agency: r.extracted?.agency ?? "",
    tipologia: r.extracted?.tipologia ?? "",
    error: r.error,
  }));

  // Costo Firecrawl: ~$0.002/scrape (stima conservativa)
  const costoFirecrawl = Number((samples.length * 0.002).toFixed(3));
  const costoPerAnn = samples.length ? Number((costoFirecrawl / samples.length).toFixed(4)) : 0;
  const stimaFull = Number((5514 * costoPerAnn).toFixed(2));

  const coreCov = (copertura.mq + copertura.locali + copertura.piano + copertura.civico) / 4;
  const verdetto = coreCov >= 70
    ? `copertura ALTA (${coreCov.toFixed(0)}%) — fix contendibili AFFIDABILE via Firecrawl. Costo full stimato ~$${stimaFull}.`
    : coreCov >= 40
    ? `copertura MEDIA (${coreCov.toFixed(0)}%) — fix parzialmente affidabile. Valutare Apify detail actor per immobiliare/idealista. Costo full Firecrawl ~$${stimaFull}.`
    : `copertura BASSA (${coreCov.toFixed(0)}%) — Firecrawl insufficiente, servono Apify detail actor dedicati. NON procedere col fix attuale.`;

  return new Response(JSON.stringify({
    ok: true,
    mini_test: true,
    nota: "Apify detail actors NON usati per evitare spesa su attori non validati. Tutto via Firecrawl.",
    costo_reale_usd: costoFirecrawl,
    costo_per_annuncio_dettaglio_usd: costoPerAnn,
    apify_spesa_usd: 0,
    elapsed_ms: elapsedMs,
    attori_dettaglio_usati: {
      immobiliare: "firecrawl-detail",
      idealista: "firecrawl-detail",
      casa: "firecrawl-detail",
      subito: "firecrawl-detail",
    },
    annunci_testati_per_portale: per_portal,
    annunci_ok: oks.length,
    annunci_fail: results.length - oks.length,
    copertura_campi_percentuale: copertura,
    esempi,
    stima_costo_full_5514_usd: stimaFull,
    verdetto,
  }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
