// b2b-finder-enrich — Deep enrichment of saved B2B leads.
// Reads from b2b_companies, optionally fetches official website + contacts page,
// extracts emails/phones/socials/commercial signals, refines category and fit_reason.
// Writes only metadata.enrichment plus careful fills on missing fields.
// Never overwrites status, notes, metadata.notes_structured.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders, handlePreflight, pickOrigin } from "../_shared/b2b/cors.ts";
import { authorizeB2BFinder } from "../_shared/b2b/auth.ts";

interface EnrichInput {
  job_id?: string;
  company_ids?: string[];
  limit?: number;
  force?: boolean;
  dry_run?: boolean;
}

const HARD_MAX = 20;
const DEFAULT_LIMIT = 10;
const ENRICH_TTL_DAYS = 30;
const FETCH_TIMEOUT_MS = 8000;
const COST_PER_DIRECT_FETCH_EUR = 0; // direct fetch is free
const COST_PER_FIRECRAWL_EUR = 0.002; // conservative estimate

function newDebugId(): string {
  return "b2be_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function envelope(
  ok: boolean,
  data: unknown,
  error: string | null,
  debug_id: string,
  warnings: string[] = [],
) {
  return { ok, data, warnings, debug_id, error };
}

function jsonResponse(req: Request, status: number, body: ReturnType<typeof envelope>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json",
      "X-Function": "b2b-finder-enrich",
      "X-Contract": "b2b-finder/v0.2",
    },
  });
}

// ── Extraction helpers ───────────────────────────────────────────────────────

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_RE = /(?:\+39[\s.-]?)?(?:0\d{1,3}|3\d{2})[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g;

const SOCIAL_HOSTS = [
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "youtube.com",
];

const CATEGORY_RULES: Array<{ kw: RegExp; cat: string }> = [
  { kw: /\bagriturism/i, cat: "agriturismo" },
  { kw: /\bself[\s-]?service\b/i, cat: "self service" },
  { kw: /\bmensa\b|tavola\s+calda/i, cat: "mensa" },
  { kw: /\btrattoria\b/i, cat: "trattoria" },
  { kw: /\bpizzeria\b/i, cat: "pizzeria" },
  { kw: /\bristorante\b/i, cat: "ristorante" },
  { kw: /\bbar\b.*\b(tavola|cucina|pranzo)/i, cat: "bar tavola calda" },
];

const COMMERCIAL_SIGNAL_RULES: Array<{ kw: RegExp; label: string }> = [
  { kw: /pranz[oi]\s+(di\s+)?lavoro|menu\s+lavoro|business\s+lunch/i, label: "pranzi di lavoro" },
  { kw: /menu\s+fisso|menù\s+fisso|prezzo\s+fisso/i, label: "menu fisso" },
  { kw: /eventi|cerimoni[ae]|banchett[oi]|matrimoni/i, label: "eventi" },
  { kw: /catering/i, label: "catering" },
  { kw: /\b(\d{2,4})\s*coperti\b|gran(de)?\s+sala|ampia\s+sala/i, label: "molti coperti" },
  { kw: /asporto|d'asporto|delivery|consegna\s+a\s+domicilio/i, label: "consegna/asporto" },
];

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x?\d+;/gi, " ");
}

function extractEmails(text: string, html: string): string[] {
  const found = new Set<string>();
  const mailto = html.match(/mailto:([^"'\s>]+)/gi) ?? [];
  for (const m of mailto) {
    const addr = m.replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase();
    if (addr && /@/.test(addr)) found.add(addr);
  }
  const plain = text.match(EMAIL_RE) ?? [];
  for (const e of plain) {
    const lo = e.toLowerCase();
    if (lo.endsWith(".png") || lo.endsWith(".jpg") || lo.endsWith(".webp")) continue;
    if (lo.includes("sentry") || lo.includes("example.")) continue;
    found.add(lo);
  }
  return Array.from(found).slice(0, 10);
}

function extractPhones(text: string, html: string): string[] {
  const found = new Set<string>();
  const tel = html.match(/tel:([^"'\s>]+)/gi) ?? [];
  for (const m of tel) {
    const n = m.replace(/^tel:/i, "").replace(/[^\d+]/g, "");
    if (n.length >= 8) found.add(n);
  }
  const plain = text.match(PHONE_RE) ?? [];
  for (const p of plain) {
    const n = p.replace(/[^\d+]/g, "");
    if (n.length >= 9 && n.length <= 15) found.add(n);
  }
  return Array.from(found).slice(0, 5);
}

function extractSocialLinks(html: string): string[] {
  const out = new Set<string>();
  const hrefs = html.match(/href=["']([^"']+)["']/gi) ?? [];
  for (const raw of hrefs) {
    const m = raw.match(/href=["']([^"']+)["']/i);
    if (!m) continue;
    const url = m[1];
    for (const host of SOCIAL_HOSTS) {
      if (url.toLowerCase().includes(host)) {
        out.add(url.split("#")[0].split("?")[0]);
        break;
      }
    }
  }
  return Array.from(out).slice(0, 8);
}

function refineCategory(text: string, current: string | null): string | null {
  for (const r of CATEGORY_RULES) if (r.kw.test(text)) return r.cat;
  return current ?? null;
}

function detectCommercialSignals(text: string): string[] {
  const out = new Set<string>();
  for (const r of COMMERCIAL_SIGNAL_RULES) if (r.kw.test(text)) out.add(r.label);
  return Array.from(out);
}

function findContactPage(html: string, baseUrl: string): string | null {
  const re = /href=["']([^"']+)["'][^>]*>([^<]{0,80})</gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1];
    const label = m[2].toLowerCase();
    if (/contat|contact/.test(href.toLowerCase()) || /contat|contact/.test(label)) {
      try {
        return new URL(href, baseUrl).toString();
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function fetchWithTimeout(url: string, timeout = FETCH_TIMEOUT_MS): Promise<{ ok: boolean; status: number; html: string; finalUrl: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctl.signal,
      headers: {
        "User-Agent": "CivikoBot/1.0 (+contact)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "it-IT,it;q=0.9",
      },
    });
    const html = await res.text();
    return { ok: res.ok, status: res.status, html, finalUrl: res.url };
  } finally {
    clearTimeout(t);
  }
}

function isValidHttpUrl(u: string | null | undefined): u is string {
  if (!u) return false;
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

interface CompanyRow {
  id: string;
  name: string | null;
  category: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  fit_reason: string | null;
  status: string | null;
  metadata: Record<string, unknown> | null;
}

interface EnrichOutcome {
  company_id: string;
  company_name: string | null;
  updated: boolean;
  email: string | null;
  phone: string | null;
  website: string | null;
  category_refined: string | null;
  commercial_signals: string[];
  confidence: number;
  warnings: string[];
  skipped_reason?: string;
}

async function enrichOne(
  c: CompanyRow,
  force: boolean,
): Promise<{ outcome: EnrichOutcome; enrichmentPatch: Record<string, unknown> | null; costEur: number; methodUsed: string }> {
  const warnings: string[] = [];
  const sourceUrls: string[] = [];
  let cost = 0;
  let method = "skipped";

  // Skip if already enriched recently
  const existingEnrich = (c.metadata?.["enrichment"] as Record<string, unknown> | undefined) ?? null;
  if (!force && existingEnrich?.enriched_at) {
    const at = new Date(String(existingEnrich.enriched_at));
    const ageDays = (Date.now() - at.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays < ENRICH_TTL_DAYS) {
      return {
        outcome: {
          company_id: c.id,
          company_name: c.name,
          updated: false,
          email: c.email,
          phone: c.phone,
          website: c.website,
          category_refined: c.category,
          commercial_signals: [],
          confidence: Number(existingEnrich.confidence ?? 0),
          warnings: [],
          skipped_reason: `already_enriched_${Math.round(ageDays)}d_ago`,
        },
        enrichmentPatch: null,
        costEur: 0,
        methodUsed: "skipped_recent",
      };
    }
  }

  let website = isValidHttpUrl(c.website) ? c.website : null;
  if (!website) {
    return {
      outcome: {
        company_id: c.id,
        company_name: c.name,
        updated: false,
        email: c.email,
        phone: c.phone,
        website: null,
        category_refined: c.category,
        commercial_signals: [],
        confidence: 0,
        warnings: ["no_website_available_for_enrichment"],
        skipped_reason: "no_website",
      },
      enrichmentPatch: null,
      costEur: 0,
      methodUsed: "skipped_no_website",
    };
  }

  let html = "";
  let finalUrl = website;
  try {
    const r = await fetchWithTimeout(website);
    if (!r.ok) warnings.push(`home_status_${r.status}`);
    html = r.html ?? "";
    finalUrl = r.finalUrl || website;
    sourceUrls.push(finalUrl);
    cost += COST_PER_DIRECT_FETCH_EUR;
    method = "website_enrichment";
  } catch (e) {
    const msg = e instanceof Error ? e.message : "fetch_error";
    warnings.push(`home_fetch_failed:${msg.slice(0, 80)}`);
  }

  // Try contact page
  let contactPage: string | null = null;
  let contactHtml = "";
  if (html) {
    contactPage = findContactPage(html, finalUrl);
    if (contactPage && contactPage !== finalUrl) {
      try {
        const r = await fetchWithTimeout(contactPage);
        if (r.ok) {
          contactHtml = r.html ?? "";
          sourceUrls.push(r.finalUrl || contactPage);
        } else {
          warnings.push(`contact_status_${r.status}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "fetch_error";
        warnings.push(`contact_fetch_failed:${msg.slice(0, 80)}`);
      }
    }
  }

  const fullHtml = html + "\n" + contactHtml;
  const fullText = normalizeWhitespace(stripHtml(fullHtml));

  const emails = extractEmails(fullText, fullHtml);
  const phones = extractPhones(fullText, fullHtml);
  const socials = extractSocialLinks(fullHtml);
  const categoryRefined = refineCategory(fullText, c.category);
  const signals = detectCommercialSignals(fullText);

  // Confidence
  let conf = 0;
  if (html) conf += 0.3;
  if (contactHtml) conf += 0.15;
  if (emails.length) conf += 0.2;
  if (phones.length) conf += 0.15;
  if (signals.length) conf += Math.min(0.2, signals.length * 0.05);
  conf = Math.max(0, Math.min(1, conf));

  // Improved fit reason for Coprimacchia TNT
  let fitReason: string | null = null;
  const cat = (categoryRefined ?? c.category ?? "").toLowerCase();
  const signalPart = signals.length ? ` (${signals.slice(0, 2).join(", ")})` : "";
  if (/trattoria|ristorante|pizzeria|agriturismo|mensa|self|tavola/.test(cat)) {
    fitReason = `${cat.charAt(0).toUpperCase() + cat.slice(1)} con uso ricorrente di Coprimacchia TNT${signalPart}.`;
  }

  const enrichment = {
    enriched_at: new Date().toISOString(),
    method,
    confidence: Number(conf.toFixed(2)),
    official_website: finalUrl,
    contact_page: contactPage,
    emails_found: emails,
    phones_found: phones,
    social_links: socials,
    commercial_signals: signals,
    category_refined: categoryRefined,
    source_urls: sourceUrls,
    warnings,
  };

  const outcome: EnrichOutcome = {
    company_id: c.id,
    company_name: c.name,
    updated: true,
    email: c.email ?? emails[0] ?? null,
    phone: c.phone ?? phones[0] ?? null,
    website: finalUrl,
    category_refined: categoryRefined,
    commercial_signals: signals,
    confidence: enrichment.confidence,
    warnings,
  };

  return { outcome, enrichmentPatch: enrichment, costEur: cost, methodUsed: method };
}

Deno.serve(async (req: Request) => {
  const debug_id = newDebugId();
  try {
    const preflight = handlePreflight(req);
    if (preflight) return preflight;

    if (req.headers.get("origin") && !pickOrigin(req)) {
      return jsonResponse(req, 403, envelope(false, null, "Forbidden origin", debug_id));
    }
    if (req.method !== "POST") {
      return jsonResponse(req, 405, envelope(false, null, "Method not allowed", debug_id));
    }

    const auth = authorizeB2BFinder(req);
    if (!auth.ok) {
      console.warn(`[b2b-finder-enrich] auth rejected debug_id=${debug_id} reason=${auth.reason}`);
      return jsonResponse(req, 401, envelope(false, null, "Unauthorized", debug_id));
    }

    let input: EnrichInput;
    try {
      const ct = req.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        return jsonResponse(req, 400, envelope(false, null, "Content-Type must be application/json", debug_id));
      }
      input = await req.json();
    } catch {
      return jsonResponse(req, 400, envelope(false, null, "Invalid JSON body", debug_id));
    }

    const warnings: string[] = [];
    const isDryRun = input.dry_run !== false; // default true
    const force = input.force === true;
    const requested = Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT));
    const limit = Math.min(requested, HARD_MAX);
    if (limit < requested) warnings.push(`limit clamped from ${requested} to ${limit} (max ${HARD_MAX})`);

    const hasJob = typeof input.job_id === "string" && input.job_id.length > 0;
    const hasIds = Array.isArray(input.company_ids) && input.company_ids.length > 0;
    if (!hasJob && !hasIds) {
      return jsonResponse(req, 400, envelope(false, null, "job_id or company_ids required", debug_id));
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SERVICE_KEY) {
      console.error(`[b2b-finder-enrich] missing env debug_id=${debug_id}`);
      return jsonResponse(req, 500, envelope(false, null, "Server misconfigured", debug_id, warnings));
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Validate job exists
    let jobId: string | null = null;
    if (hasJob) {
      const { data: job, error: jErr } = await supabase
        .from("b2b_search_jobs")
        .select("id")
        .eq("id", input.job_id!)
        .maybeSingle();
      if (jErr) {
        return jsonResponse(req, 500, envelope(false, null, "Job lookup failed", debug_id, warnings));
      }
      if (!job) {
        return jsonResponse(req, 404, envelope(false, null, "Job not found", debug_id, warnings));
      }
      jobId = job.id as string;
    }

    // Resolve company list
    let companyIds: string[] = [];
    if (hasIds) {
      companyIds = (input.company_ids ?? []).filter((s) => typeof s === "string" && s.length > 0);
    } else if (jobId) {
      const { data: srcRows, error: sErr } = await supabase
        .from("b2b_company_sources")
        .select("company_id")
        .eq("job_id", jobId)
        .limit(500);
      if (sErr) {
        return jsonResponse(req, 500, envelope(false, null, "Sources lookup failed", debug_id, warnings));
      }
      companyIds = Array.from(new Set((srcRows ?? []).map((r: { company_id: string }) => r.company_id)));
    }
    if (companyIds.length === 0) {
      return jsonResponse(req, 404, envelope(false, null, "No companies to enrich", debug_id, warnings));
    }

    // Daily budget check
    const dailyCap = parseFloat(Deno.env.get("B2B_FINDER_DAILY_BUDGET_EUR") ?? "2") || 2;
    const today = new Date().toISOString().slice(0, 10);
    const { data: ledgerToday } = await supabase
      .from("b2b_usage_ledger")
      .select("cost_eur")
      .eq("day", today);
    const spentToday = (ledgerToday ?? []).reduce(
      (acc: number, r: { cost_eur: number | string }) => acc + Number(r.cost_eur ?? 0),
      0,
    );
    if (spentToday >= dailyCap) {
      return jsonResponse(
        req,
        429,
        envelope(false, null, "Daily budget exceeded", debug_id, [
          ...warnings,
          `budget_spent_today=${spentToday.toFixed(4)} cap=${dailyCap}`,
        ]),
      );
    }

    // Fetch companies (cap)
    const { data: companies, error: cErr } = await supabase
      .from("b2b_companies")
      .select("id,name,category,website,phone,email,fit_reason,status,metadata")
      .in("id", companyIds.slice(0, limit));
    if (cErr) {
      return jsonResponse(req, 500, envelope(false, null, "Companies lookup failed", debug_id, warnings));
    }
    const rows = (companies ?? []) as CompanyRow[];

    let processed = 0;
    let updated = 0;
    let skipped = 0;
    let totalCost = 0;
    const results: EnrichOutcome[] = [];

    for (const c of rows) {
      processed++;
      try {
        const { outcome, enrichmentPatch, costEur, methodUsed } = await enrichOne(c, force);
        totalCost += costEur;
        if (!enrichmentPatch) {
          skipped++;
          results.push(outcome);
          continue;
        }

        if (isDryRun) {
          // Don't write
          results.push({ ...outcome, updated: false, warnings: [...outcome.warnings, "dry_run_no_write"] });
          continue;
        }

        // Build safe patch: never overwrite status/notes/notes_structured.
        const currentMeta = (c.metadata ?? {}) as Record<string, unknown>;
        const newMeta = { ...currentMeta, enrichment: enrichmentPatch };

        const patch: Record<string, unknown> = { metadata: newMeta };
        if (!c.phone && outcome.phone) patch.phone = outcome.phone;
        if (!c.email && outcome.email) patch.email = outcome.email;
        if (outcome.website && outcome.website !== c.website) {
          // only replace website if home actually resolved
          patch.website = outcome.website;
        }
        if (outcome.category_refined && outcome.category_refined !== c.category) {
          patch.category = outcome.category_refined;
        }
        const newFit = (() => {
          const cat = (outcome.category_refined ?? c.category ?? "").toLowerCase();
          if (!/trattoria|ristorante|pizzeria|agriturismo|mensa|self|tavola/.test(cat)) return null;
          const sp = outcome.commercial_signals.length
            ? ` (${outcome.commercial_signals.slice(0, 2).join(", ")})`
            : "";
          return `${cat.charAt(0).toUpperCase() + cat.slice(1)} con uso ricorrente di Coprimacchia TNT${sp}.`;
        })();
        if (newFit && newFit !== c.fit_reason) patch.fit_reason = newFit;

        const { error: uErr } = await supabase.from("b2b_companies").update(patch).eq("id", c.id);
        if (uErr) {
          skipped++;
          results.push({ ...outcome, updated: false, warnings: [...outcome.warnings, `db_update_failed:${uErr.message}`] });
          continue;
        }
        updated++;
        results.push(outcome);

        // Per-company ledger row (small, controlled)
        await supabase.from("b2b_usage_ledger").insert({
          provider: methodUsed === "website_enrichment" ? "direct_fetch" : "skipped",
          action: "enrich",
          units: 1,
          cost_eur: costEur,
          job_id: jobId,
          metadata: { company_id: c.id, sources: enrichmentPatch.source_urls, method: methodUsed },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "enrich_error";
        skipped++;
        results.push({
          company_id: c.id,
          company_name: c.name,
          updated: false,
          email: c.email,
          phone: c.phone,
          website: c.website,
          category_refined: c.category,
          commercial_signals: [],
          confidence: 0,
          warnings: [`unhandled:${msg.slice(0, 120)}`],
        });
      }
    }

    console.log(
      `[b2b-finder-enrich] done debug_id=${debug_id} job=${jobId ?? "-"} processed=${processed} updated=${updated} skipped=${skipped} cost=${totalCost.toFixed(4)}`,
    );

    return jsonResponse(
      req,
      200,
      envelope(
        true,
        {
          job_id: jobId,
          dry_run: isDryRun,
          processed,
          updated,
          skipped,
          estimated_cost_eur: Number(totalCost.toFixed(4)),
          results,
        },
        null,
        debug_id,
        warnings,
      ),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "internal error";
    console.error(`[b2b-finder-enrich] unhandled debug_id=${debug_id} err=${msg}`);
    return new Response(
      JSON.stringify({ ok: false, data: null, warnings: [], debug_id, error: "Internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
