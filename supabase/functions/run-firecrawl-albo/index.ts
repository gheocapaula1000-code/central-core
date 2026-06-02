// run-firecrawl-albo
// 1) Discovers Albo Pretorio PDFs/pages via Firecrawl /v2/map
// 2) Scrapes each as markdown via Firecrawl /v2/scrape
// 3) Passes the markdown to Perplexity (sonar) with a strict extraction prompt
//    -> JSON { address, cap, type } where type ∈ { successione, cambio_destinazione, edilizia, altro }
// 4) Inserts qualified records into normalized_opportunities tagged 'albo_pretorio'
//    so the classify_opportunity trigger applies anti-portal + off-market_puro logic.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const FC = "https://api.firecrawl.dev/v2";
const PX = "https://api.perplexity.ai/chat/completions";

interface Extracted {
  address?: string | null;
  cap?: string | null;
  type?: string | null;
  municipality?: string | null;
  notes?: string | null;
}

async function fcMap(url: string, key: string, search?: string): Promise<string[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const res = await fetch(`${FC}/map`, {
      method: "POST", signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, search, limit: 50, includeSubdomains: false }),
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    const raw: unknown[] = Array.isArray(data?.links) ? data.links
      : Array.isArray(data?.data?.links) ? data.data.links
      : Array.isArray(data?.data) ? data.data : [];
    return raw.map((l) => typeof l === "string" ? l : (l as { url?: string })?.url ?? "").filter(Boolean) as string[];
  } catch { return []; } finally { clearTimeout(t); }
}

async function fcScrape(url: string, key: string): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 55_000);
  try {
    const res = await fetch(`${FC}/scrape`, {
      method: "POST", signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const md: string | null = data?.data?.markdown ?? data?.markdown ?? null;
    return md ? md.slice(0, 8000) : null;
  } catch { return null; } finally { clearTimeout(t); }
}

async function perplexityExtract(markdown: string, key: string): Promise<Extracted | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(PX, {
      method: "POST", signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          { role: "system", content: "Estrai indirizzo, CAP e tipologia (successione, cambio destinazione, edilizia, altro) da questo testo legale italiano. Rispondi SOLO con JSON valido nel formato {\"address\": string|null, \"cap\": string|null, \"municipality\": string|null, \"type\": \"successione\"|\"cambio_destinazione\"|\"edilizia\"|\"altro\", \"notes\": string|null}. Se non trovi dati, restituisci campi null." },
          { role: "user", content: markdown.slice(0, 6000) },
        ],
        temperature: 0.1,
        response_format: { type: "json_schema", json_schema: { name: "albo_extract", schema: {
          type: "object", properties: {
            address: { type: ["string","null"] },
            cap: { type: ["string","null"] },
            municipality: { type: ["string","null"] },
            type: { type: "string", enum: ["successione","cambio_destinazione","edilizia","altro"] },
            notes: { type: ["string","null"] },
          }, required: ["type"], additionalProperties: false,
        } } },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const content: string = data?.choices?.[0]?.message?.content ?? "";
    try { return JSON.parse(content) as Extracted; } catch { return null; }
  } catch { return null; } finally { clearTimeout(t); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (req.headers.get("x-job-secret") !== jobSecret || !jobSecret) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const albi: { municipality: string; url: string }[] = Array.isArray(body.albi) && body.albi.length
      ? body.albi
      : [
          { municipality: "Padova",       url: "https://albopretorio.regione.veneto.it/AlboEnte/padova/" },
          { municipality: "Albignasego",  url: "https://www.comune.albignasego.pd.it/c028002/albo/" },
          { municipality: "Selvazzano",   url: "https://www.comune.selvazzano-dentro.pd.it/c028078/albo/" },
        ];
    const maxPerAlbo: number = Math.min(Number(body.max_per_albo ?? 10), 30);
    const keywords: string = body.search ?? "successione cambio destinazione edilizia";

    const fcKey = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
    const pxKey = Deno.env.get("PERPLEXITY_API_KEY") ?? "";
    if (!fcKey || !pxKey) {
      return new Response(JSON.stringify({ ok: false, error: "missing_api_keys", data: { firecrawl: !!fcKey, perplexity: !!pxKey } }), {
        status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    const stats = { albi: albi.length, urls_found: 0, scraped: 0, extracted: 0, inserted: 0, errors: [] as string[] };

    for (const albo of albi) {
      try {
        const urls = (await fcMap(albo.url, fcKey, keywords)).slice(0, maxPerAlbo);
        stats.urls_found += urls.length;

        for (const u of urls) {
          const md = await fcScrape(u, fcKey);
          if (!md) continue;
          stats.scraped += 1;

          const ext = await perplexityExtract(md, pxKey);
          if (!ext || !ext.type || ext.type === "altro") continue;
          stats.extracted += 1;

          const tagMap: Record<string, string[]> = {
            successione: ["albo_pretorio", "successione"],
            cambio_destinazione: ["albo_pretorio", "cambio_destinazione"],
            edilizia: ["albo_pretorio", "edilizia"],
          };

          const row = {
            title: `Albo ${albo.municipality} — ${ext.type}`.slice(0, 240),
            source_name: `albo_pretorio_${albo.municipality.toLowerCase()}`,
            source_url: u,
            address_text: ext.address ?? null,
            municipality: ext.municipality ?? albo.municipality,
            cap: (ext.cap ?? "").replace(/\D/g, "").slice(0, 5) || null,
            category: ext.type,
            tags: tagMap[ext.type] ?? ["albo_pretorio"],
            scoring_reason: ext.notes ? `[ALBO] ${ext.notes}`.slice(0, 500) : null,
            data_rilevamento: new Date().toISOString(),
          };

          const { data: inserted, error } = await sb
            .from("normalized_opportunities").insert(row).select("id").single();
          if (error) { stats.errors.push(`insert:${error.message}`.slice(0, 200)); continue; }
          stats.inserted += 1;

          if (inserted?.id) {
            await sb.rpc("generate_predictive_insight", { p_opportunity_id: inserted.id });
          }
        }
      } catch (e) {
        stats.errors.push(`${albo.municipality}:${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
      }
    }

    return new Response(JSON.stringify({ ok: true, data: stats, error: null }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, data: null, error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
