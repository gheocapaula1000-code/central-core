// civiko-bakeca-scrape
// Scraping Bakeca Padova (annunci immobili vendita) tramite Firecrawl.
// Estrae le card visibili dal markdown, classifica privato/privato_stanco,
// upserta in padova_listings con fonte='bakeca'.
//
// Auth: x-job-secret / x-internal-secret / Authorization Bearer
//       == CENTRAL_CORE_JOB_SECRET (JWT bearers ignored).

import { createClient } from "npm:@supabase/supabase-js@2";
import { classifyPrivateLead } from "../_shared/leadClassification.ts";
import { recordFirecrawlSpend, FIRECRAWL_USD_PER_PAGE, canSpendFirecrawl } from "../_shared/firecrawlBudget.ts";
import { recordPrivateLeadsSpend } from "../_shared/privateLeadsBudget.ts";
import {
  jobSecretAuthorized,
  missingJobSecretConfigResponse,
  readIncomingJobSecret,
  unauthorizedJobResponse,
} from "../_shared/jobSecretAuth.ts";
import {
  BAKECA_LISTING_PAGES,
  BAKECA_MAX_PAGES,
  bakecaPageUrl,
  parseListingsFromMarkdown,
} from "./parse.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-job-secret, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!jobSecret) return missingJobSecretConfigResponse(corsHeaders);
  if (!jobSecretAuthorized(jobSecret, readIncomingJobSecret(req.headers))) {
    return unauthorizedJobResponse(corsHeaders);
  }

  const fcKey = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
  if (!fcKey) {
    return new Response(JSON.stringify({ ok: false, error: "FIRECRAWL_API_KEY_missing" }), {
      status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const budget = await canSpendFirecrawl(BAKECA_LISTING_PAGES.length * BAKECA_MAX_PAGES);
  if (!budget.ok) {
    return new Response(JSON.stringify({
      ok: false,
      error: "firecrawl_budget_exhausted",
      reason: budget.reason ?? "cap",
      spent: budget.spent,
      cap: budget.cap,
    }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const started = Date.now();
  let totale = 0;
  let stanchi = 0;
  let pagesScraped = 0;
  const errors: string[] = [];

  try {
    for (const base of BAKECA_LISTING_PAGES) {
      for (let p = 1; p <= BAKECA_MAX_PAGES; p++) {
        const url = bakecaPageUrl(base, p);
        const fc = await fetch("https://api.firecrawl.dev/v2/scrape", {
          method: "POST",
          headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, waitFor: 1500 }),
        });
        if (!fc.ok) {
          errors.push(`page_${p}_http_${fc.status}`);
          break;
        }
        pagesScraped++;
        const j = await fc.json();
        const md: string = j?.markdown ?? j?.data?.markdown ?? "";
        if (!md || md.length < 200) break;

        const items = parseListingsFromMarkdown(md).filter((it) => it.isPrivato);
        if (items.length === 0 && p > 1) break;

        for (const it of items) {
          const c = classifyPrivateLead({
            firstSeenAt: it.firstSeenAt,
            importedAt: new Date(),
            prezzoAttuale: it.prezzo,
            prezzoOriginale: null,
            isPrivato: true,
          });
          if (c.tipo_lead === "privato_stanco") stanchi++;
          totale++;

          await sb.from("padova_listings").upsert({
            fonte: "bakeca",
            url: it.url,
            comune: "Padova",
            tipo_lead: c.tipo_lead,
            mq: it.mq,
            locali: it.locali,
            prezzo: it.prezzo,
            indirizzo: it.indirizzo,
            last_seen_at: new Date().toISOString(),
            raw_json: { titolo: it.titolo, motivo: c.motivo, age_days: c.age_days },
            imported_at: new Date().toISOString(),
          }, { onConflict: "url" }).select().maybeSingle();
        }
      }
    }

    const estUsd = pagesScraped * FIRECRAWL_USD_PER_PAGE;
    await recordFirecrawlSpend(pagesScraped, 1);
    await recordPrivateLeadsSpend("firecrawl", estUsd);

    await sb.from("private_leads_run_status").insert({
      source: "bakeca",
      opportunita_totali: totale,
      privato_stanco_count: stanchi,
      status: errors.length > 0 ? "partial" : "ok",
      error_message: errors.length > 0 ? errors.join(", ") : null,
      duration_ms: Date.now() - started,
      notes: { pages_scraped: pagesScraped, est_usd: estUsd },
    });

    return new Response(JSON.stringify({
      ok: true,
      source: "bakeca",
      opportunita_totali: totale,
      privato_stanco: stanchi,
      pages_scraped: pagesScraped,
      est_usd: estUsd,
      duration_ms: Date.now() - started,
    }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from("private_leads_run_status").insert({
      source: "bakeca",
      opportunita_totali: totale,
      privato_stanco_count: stanchi,
      status: "error",
      error_message: msg.slice(0, 500),
      duration_ms: Date.now() - started,
    });
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
