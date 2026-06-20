// civiko-bakeca-scrape
// Scraping Bakeca Padova (annunci immobili vendita) tramite Firecrawl.
// Estrae le card visibili dal markdown, classifica privato/privato_stanco,
// upserta in padova_listings con fonte='bakeca'.
//
// Auth: x-job-secret == CENTRAL_CORE_JOB_SECRET.
// Costo stimato: ~5 pagine Firecrawl per giro = ~$0.005.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { classifyPrivateLead } from "../_shared/leadClassification.ts";
import { recordFirecrawlSpend, FIRECRAWL_USD_PER_PAGE } from "../_shared/firecrawlBudget.ts";
import { recordPrivateLeadsSpend } from "../_shared/privateLeadsBudget.ts";

const BAKECA_BASE = "https://www.bakeca.it/annunci/immobili-vendita/padova/";
const MAX_PAGES = 5;

interface ParsedListing {
  url: string;
  titolo: string;
  prezzo: number | null;
  mq: number | null;
  locali: number | null;
  indirizzo: string | null;
  isPrivato: boolean;
  firstSeenAt: string | null;
}

function parseEuro(s: string): number | null {
  const m = s.match(/€\s*([\d.]+)/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/\./g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function parseInt2(s: string, pat: RegExp): number | null {
  const m = s.match(pat);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function parseListingsFromMarkdown(md: string): ParsedListing[] {
  const out: ParsedListing[] = [];
  // Bakeca renderizza ogni annuncio come blocco con [titolo](url) seguito da prezzo, dettagli, eventuale "Privato".
  // Pattern resiliente: cattura [text](url-bakeca.it) e i 400 char successivi.
  const linkRe = /\[([^\]\n]{4,200})\]\((https?:\/\/[^\s)]*bakeca\.it[^\s)]*)\)/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(md)) !== null) {
    const titolo = m[1].trim();
    const url = m[2].split("?")[0];
    if (!/\/(annunci|dettaglio)\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const tail = md.slice(m.index, m.index + 800);
    const isPrivato = /\bprivato\b/i.test(tail) && !/\bagenzia\b/i.test(tail.slice(0, 200));
    const prezzo = parseEuro(tail);
    const mq = parseInt2(tail, /(\d{2,4})\s*m(?:q|²)/i);
    const locali = parseInt2(tail, /(\d{1,2})\s*(?:local[ie]|stanze)/i);
    const indMatch = tail.match(/(?:Via|Viale|Piazza|Corso|Largo|Vicolo|Strada)\s+[A-ZÀÈÌÒÙ][^,\n]{3,80}/i);
    const indirizzo = indMatch ? indMatch[0].trim() : null;

    // Bakeca espone l'età relativa (es. "3 mesi fa", "ieri") raramente nel listing → null,
    // verrà classificato come privato finché non rivisto.
    out.push({ url, titolo, prezzo, mq, locali, indirizzo, isPrivato, firstSeenAt: null });
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // DISATTIVATA 2026-06-20.
  // Motivazione: solo 14 annunci di privati su tutta Padova provincia (verifica sul vivo).
  // Volume troppo basso per giustificare il costo Firecrawl. Parser preservato sotto
  // (parseListingsFromMarkdown) per eventuale riattivazione futura: basta rimuovere
  // questo short-circuit e ripristinare is_active=true in civiko_data_sources.
  return new Response(JSON.stringify({
    ok: true,
    disabled: true,
    since: "2026-06-20",
    reason: "Volume troppo basso (14 annunci privati su Padova provincia). Parser conservato.",
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  // deno-lint-ignore no-unreachable
  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!jobSecret || req.headers.get("x-job-secret") !== jobSecret) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }


  const fcKey = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
  if (!fcKey) {
    return new Response(JSON.stringify({ ok: false, error: "FIRECRAWL_API_KEY_missing" }), {
      status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
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
    for (let p = 1; p <= MAX_PAGES; p++) {
      const url = p === 1 ? BAKECA_BASE : `${BAKECA_BASE}?page=${p}`;
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
          tipo_lead: c.tipo_lead,
          mq: it.mq,
          locali: it.locali,
          prezzo: it.prezzo,
          indirizzo: it.indirizzo,
          raw_json: { titolo: it.titolo, motivo: c.motivo, age_days: c.age_days },
          imported_at: new Date().toISOString(),
        }, { onConflict: "url" }).select().maybeSingle();
      }
    }

    // Spend tracking
    const estUsd = pagesScraped * FIRECRAWL_USD_PER_PAGE;
    await recordFirecrawlSpend(pagesScraped, 1);
    await recordPrivateLeadsSpend("firecrawl", estUsd);

    // Status row
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
