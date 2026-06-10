// test-apify-actors-multi-padova
// Solo TEST: per ogni portale (casa/subito/idealista) lancia un actor Apify sync su 5 URL
// (o, se search-only, su 1 search URL Padova e rimatcha). Ritorna risultati grezzi + verdetto.
// NESSUN import nel DB. NESSUN ricalcolo contendibili.
//
// Auth: x-job-secret == CENTRAL_CORE_JOB_SECRET.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getApifyToken } from "../_shared/apify.ts";

const APIFY = "https://api.apify.com/v2";

interface PortalCfg {
  portal: "casa" | "subito" | "idealista";
  actor_id: string;
  mode: "url-list" | "search-url";
  input: Record<string, unknown>;
  price_per_1k_usd: number;
  extract: (it: Record<string, unknown>) => Normalized;
  fallback_match_url?: string[]; // for search-mode: list of test URLs to look for
}

interface Normalized {
  url: string | null;
  agency: string | null;
  mq: number | null;
  locali: number | null;
  price: number | null;
  lat: number | null;
  lng: number | null;
  raw_keys: string[];
}

function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function looksCleanAgency(s: string | null): boolean {
  if (!s) return false;
  if (s.length > 80) return false;
  if (/trova\s+agenzia|navbar|menu|cerca/i.test(s)) return false;
  if (/[\[\]\{\}#|]/.test(s)) return false;
  return /[A-Za-z]/.test(s) && s.trim().length >= 2;
}

async function apifyRunSync(actor: string, input: Record<string, unknown>, token: string, timeoutMs = 180_000): Promise<{ ok: boolean; items: Record<string, unknown>[]; cost_usd: number | null; status: number; runId?: string; datasetId?: string; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // run-sync-get-dataset-items: blocks until run finishes, returns items array
    const url = `${APIFY}/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return { ok: false, items: [], cost_usd: null, status: r.status, error: txt.slice(0, 400).replace(/token=[^&\s]+/gi, "token=[redacted]") };
    }
    const runId = r.headers.get("x-apify-pagination-actor-run-id") ?? undefined;
    const items = (await r.json()) as Record<string, unknown>[];
    // try fetch usage
    let cost: number | null = null;
    if (runId) {
      try {
        const s = await fetch(`${APIFY}/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
        const sj = await s.json();
        cost = typeof sj?.data?.usageTotalUsd === "number" ? sj.data.usageTotalUsd : null;
      } catch { /* ignore */ }
    }
    return { ok: true, items: Array.isArray(items) ? items : [], cost_usd: cost, status: r.status, runId };
  } catch (e) {
    return { ok: false, items: [], cost_usd: null, status: 0, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const hasJobSecret = jobSecret && req.headers.get("x-job-secret") === jobSecret;
  const authHeader = req.headers.get("Authorization") ?? "";
  let hasAuthedUser = false;
  if (!hasJobSecret && authHeader.startsWith("Bearer ")) {
    try {
      const sbAuth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
      const { data } = await sbAuth.auth.getClaims(authHeader.replace("Bearer ", ""));
      if (data?.claims?.sub) hasAuthedUser = true;
    } catch { /* ignore */ }
  }
  if (!hasJobSecret && !hasAuthedUser) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const token = getApifyToken();
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: "APIFY_API_TOKEN_missing" }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  let body: { test_urls?: Record<string, string[]> } = {};
  try { body = await req.json(); } catch { /* allow empty */ }
  const tu = body.test_urls ?? {};
  const casaUrls = tu.casa ?? [];
  const subitoUrls = tu.subito ?? [];
  const idealistaUrls = tu.idealista ?? [];

  const portals: PortalCfg[] = [
    {
      portal: "casa",
      actor_id: "solidcode/casa-property-search-scraper",
      mode: "url-list",
      price_per_1k_usd: 1.5,
      input: {
        startUrls: casaUrls.map((u) => ({ url: u })),
        maxResultsPerUrl: 1,
        ignoreUrlFailures: true,
        language: "it",
      },
      extract: (it) => ({
        url: (it.url as string) ?? (it.detailUrl as string) ?? null,
        agency: (it.agencyName as string) ?? (it.publisherName as string) ?? (it.agency as string) ?? ((it.publisher as Record<string, unknown>)?.name as string) ?? null,
        mq: num((it.surface as unknown) ?? (it.area as unknown) ?? (it.size as unknown) ?? (it.sqm as unknown)),
        locali: num((it.rooms as unknown) ?? (it.locali as unknown)),
        price: num((it.price as unknown) ?? ((it.price as Record<string, unknown>)?.amount as unknown)),
        lat: num((it.latitude as unknown) ?? (it.lat as unknown) ?? ((it.location as Record<string, unknown>)?.lat as unknown)),
        lng: num((it.longitude as unknown) ?? (it.lng as unknown) ?? ((it.location as Record<string, unknown>)?.lng as unknown)),
        raw_keys: Object.keys(it).slice(0, 30),
      }),
    },
    {
      portal: "subito",
      actor_id: "azzouzana/subito-scraper-pro-by-search-url",
      mode: "search-url",
      price_per_1k_usd: 1.5,
      input: {
        searchUrl: "https://www.subito.it/annunci-veneto/vendita/immobili/padova/",
        maxItems: 50,
      },
      fallback_match_url: subitoUrls,
      extract: (it) => {
        const seller = (it.seller as Record<string, unknown>) ?? {};
        const price = (it.price as Record<string, unknown>) ?? {};
        const loc = (it.location as Record<string, unknown>) ?? {};
        return {
          url: (it.url as string) ?? null,
          agency: (seller.name as string) ?? null,
          mq: num((it.surface as unknown) ?? (it.mq as unknown)),
          locali: num((it.rooms as unknown) ?? (it.locali as unknown)),
          price: num((price.amount as unknown) ?? (it.price as unknown)),
          lat: num((loc.lat as unknown) ?? (it.latitude as unknown)),
          lng: num((loc.lng as unknown) ?? (it.longitude as unknown)),
          raw_keys: Object.keys(it).slice(0, 30),
        };
      },
    },
    {
      portal: "idealista",
      actor_id: "dz_omar/idealista-scraper-api",
      mode: "url-list",
      price_per_1k_usd: 0.5,
      input: {
        Property_urls: idealistaUrls.map((u) => ({ url: u })),
        desiredResults: 10,
      },
      extract: (it) => {
        const contact = (it.contactInfo as Record<string, unknown>) ?? (it.contact as Record<string, unknown>) ?? {};
        const ui = (it.ui as Record<string, unknown>) ?? {};
        return {
          url: (it.url as string) ?? null,
          agency: (it.agency as string) ?? (it.agencyName as string) ?? (contact.agencyName as string) ?? (contact.name as string) ?? (ui.agencyName as string) ?? null,
          mq: num((it.size as unknown) ?? (it.surface as unknown) ?? (it.constructedArea as unknown)),
          locali: num((it.rooms as unknown) ?? (it.bedrooms as unknown)),
          price: num(it.price),
          lat: num((it.latitude as unknown) ?? (it.lat as unknown)),
          lng: num((it.longitude as unknown) ?? (it.lng as unknown)),
          raw_keys: Object.keys(it).slice(0, 30),
        };
      },
    },
  ];

  // Run all 3 in parallel
  const results = await Promise.all(portals.map(async (p) => {
    if (p.mode === "url-list" && Array.isArray((p.input.startUrls ?? p.input.Property_urls ?? p.input.urls) as unknown[]) && ((p.input.startUrls ?? p.input.Property_urls ?? p.input.urls) as unknown[]).length === 0) {
      return { portal: p.portal, actor: p.actor_id, error: "no_test_urls_provided", items_raw: [], normalized: [], cost_usd: 0 };
    }
    const t0 = Date.now();
    const r = await apifyRunSync(p.actor_id, p.input, token);
    const elapsed = Date.now() - t0;
    const items = r.items.slice(0, 20);
    let normalized = items.map(p.extract);
    // if search-mode and we have known URLs, prefer matched items
    if (p.mode === "search-url" && (p.fallback_match_url?.length ?? 0) > 0) {
      const want = new Set(p.fallback_match_url);
      const matched = normalized.filter((n) => n.url && want.has(n.url));
      normalized = matched.length > 0 ? matched.slice(0, 5) : normalized.slice(0, 5);
    } else {
      normalized = normalized.slice(0, 5);
    }
    const cleanCount = normalized.filter((n) => looksCleanAgency(n.agency)).length;
    const mqOk = normalized.filter((n) => n.mq != null).length;
    const localiOk = normalized.filter((n) => n.locali != null).length;
    const priceOk = normalized.filter((n) => n.price != null).length;
    const llOk = normalized.filter((n) => n.lat != null && n.lng != null).length;
    return {
      portal: p.portal,
      actor: p.actor_id,
      mode: p.mode,
      apify_status: r.status,
      apify_error: r.error,
      elapsed_ms: elapsed,
      items_count_total: r.items.length,
      items_count_showed: normalized.length,
      raw_keys_sample: items[0] ? Object.keys(items[0]).slice(0, 40) : [],
      sample: items.slice(0, 2), // FULL raw for first 2 items so user can audit field names
      normalized,
      agency_clean_count: cleanCount,
      mq_ok: mqOk,
      locali_ok: localiOk,
      price_ok: priceOk,
      latlng_ok: llOk,
      cost_usd: r.cost_usd,
      price_per_1k_usd: p.price_per_1k_usd,
    };
  }));

  // Verdict + full-run cost estimate (using DB counts is caller's job; we use rough Padova counts)
  const FULL_COUNTS = { casa: 1465, subito: 600, idealista: 100 };
  const verdetto = results.map((r) => {
    const ready = r.normalized.length >= 3 && r.agency_clean_count >= 1 && r.mq_ok >= 3;
    const fullCount = FULL_COUNTS[r.portal as keyof typeof FULL_COUNTS] ?? 0;
    const stimaFull = Number(((fullCount * r.price_per_1k_usd) / 1000).toFixed(3));
    return {
      portale: r.portal,
      actor_scelto: r.actor,
      tipo: r.mode,
      test_ok: `${r.normalized.length}/5`,
      agenzia_pulita: r.agency_clean_count >= 1 ? `SI (${r.agency_clean_count}/${r.normalized.length})` : `NO (0/${r.normalized.length})`,
      mq_locali_prezzo_ok: `mq=${r.mq_ok}, loc=${r.locali_ok}, prezzo=${r.price_ok}`,
      latlng_ok: `${r.latlng_ok}/${r.normalized.length}`,
      costo_test_usd: r.cost_usd ?? 0,
      pronto_per_full: ready ? "SI" : "NO",
      stima_full_usd: stimaFull,
      apify_error: r.apify_error,
    };
  });

  const costoTotale = results.reduce((s, r) => s + (r.cost_usd ?? 0), 0);

  return new Response(JSON.stringify({
    ok: true,
    test_only: true,
    nessun_import: true,
    risultati_per_portale: results,
    verdetto,
    costo_apify_totale_test_usd: Number(costoTotale.toFixed(4)),
  }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
