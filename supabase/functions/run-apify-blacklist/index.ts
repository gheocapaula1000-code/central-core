// run-apify-blacklist
// Scrapes Immobiliare.it / Idealista listings via Apify and inserts them into
// normalized_opportunities tagged as portal sources, so the classify_opportunity
// trigger + check_if_marketed() can instantly burn matching off-market records.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { getApifyToken } from "../_shared/apify.ts";

const APIFY_BASE = "https://api.apify.com/v2";

interface ApifyItem {
  url?: string;
  address?: string;
  location?: string;
  zip?: string;
  cap?: string;
  city?: string;
  municipality?: string;
  price?: number | string;
  surface?: number | string;
  area?: number | string;
  title?: string;
  source?: string;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function runActor(actorId: string, input: Record<string, unknown>, token: string, timeoutMs = 110_000): Promise<ApifyItem[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&clean=true`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: ctrl.signal },
    );
    if (!res.ok) throw new Error(`apify_${res.status}`);
    const items = await res.json();
    return Array.isArray(items) ? items as ApifyItem[] : [];
  } finally {
    clearTimeout(t);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (req.headers.get("x-job-secret") !== jobSecret || !jobSecret) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const city: string = body.city ?? "Padova";
    const province: string = body.province ?? "PD";
    const limit: number = Math.min(Number(body.limit ?? 100), 500);
    const portals: string[] = Array.isArray(body.portals) && body.portals.length ? body.portals : ["immobiliare", "idealista"];

    const token = getApifyToken();
    if (!token) {
      return new Response(JSON.stringify({ ok: false, error: "APIFY_API_TOKEN_missing" }), { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    const stats = { fetched: 0, inserted: 0, bruciato: 0, errors: [] as string[] };

    // Actor IDs must be configured per workspace allow-list; default to generic search actors.
    const actorMap: Record<string, { actor: string; input: Record<string, unknown> }> = {
      immobiliare: {
        actor: Deno.env.get("APIFY_ACTOR_IMMOBILIARE") ?? "epctex~immobiliare-scraper",
        input: { startUrls: [{ url: `https://www.immobiliare.it/vendita-case/${city.toLowerCase()}/` }], maxItems: limit },
      },
      idealista: {
        actor: Deno.env.get("APIFY_ACTOR_IDEALISTA") ?? "petr_cermak~idealista-scraper",
        input: { startUrls: [{ url: `https://www.idealista.it/vendita-case/${city.toLowerCase()}-${province.toLowerCase()}/` }], maxItems: limit },
      },
    };

    const allItems: { portal: string; item: ApifyItem }[] = [];
    for (const portal of portals) {
      const cfg = actorMap[portal];
      if (!cfg) { stats.errors.push(`unknown_portal_${portal}`); continue; }
      try {
        const items = await runActor(cfg.actor, cfg.input, token);
        for (const it of items) allItems.push({ portal, item: it });
        stats.fetched += items.length;
      } catch (e) {
        stats.errors.push(`${portal}:${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Insert into normalized_opportunities (one-by-one so the trigger fires per row).
    for (const { portal, item } of allItems) {
      const addr = String(item.address ?? item.location ?? "").trim();
      const muni = String(item.city ?? item.municipality ?? city).trim();
      const cap = String(item.cap ?? item.zip ?? "").replace(/\D/g, "").slice(0, 5) || null;
      const price = num(item.price);
      const surface = num(item.surface ?? item.area);
      const url = String(item.url ?? "");
      if (!addr && !url) continue;

      const row = {
        title: String(item.title ?? `${portal} ${muni}`).slice(0, 240),
        source_name: portal === "immobiliare" ? "immobiliare.it" : "idealista.it",
        source_url: url || null,
        address_text: addr || null,
        municipality: muni,
        cap,
        ask_price: price,
        surface_mq: surface,
        category: "portale",
        tags: ["portale", portal],
        data_rilevamento: new Date().toISOString(),
      };

      const { error } = await sb.from("normalized_opportunities").insert(row);
      if (error) { stats.errors.push(`insert:${error.message}`.slice(0, 200)); continue; }
      stats.inserted += 1;
    }

    // Count how many existing off-market records got burned by these new portal entries.
    const { count } = await sb
      .from("normalized_opportunities")
      .select("id", { count: "exact", head: true })
      .eq("status", "bruciato")
      .gte("updated_at", new Date(Date.now() - 5 * 60_000).toISOString());
    stats.bruciato = count ?? 0;

    return new Response(JSON.stringify({ ok: true, data: stats, error: null }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, data: null, error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
