// b2b-finder-enrich — Cascade orchestrator (search + enrichment) for saved B2B leads.
//
// Pipeline per company (smart cascade, short-circuits at confidence >= 0.85):
//   1. Existing data check (skip if fresh + high confidence, unless force/missing_only)
//   2. Direct Fetch (homepage + contact page, max 3 pages, short timeout)
//   3. Firecrawl (only if direct fetch insufficient; limited to official domain, ≤5 pages)
//   4. Apify (only in `deep` mode and when website unknown / pages dynamic)
//   5. Perplexity Search (only if site missing or phone/email missing or contradictions)
//   6. OpenAI Structured Outputs (consolidate, dedupe, fit_reason, confidence, NBA)
//
// Modes: preview | smart (default) | deep | missing_only
// Concurrency: up to 3 companies in parallel.
// Never overwrites status, notes, metadata.notes_structured, or manual fields.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders, handlePreflight, pickOrigin } from "../_shared/b2b/cors.ts";
import { authorizeB2BFinder } from "../_shared/b2b/auth.ts";

// ── Types ────────────────────────────────────────────────────────────────────

type Mode = "preview" | "smart" | "deep" | "missing_only";

interface EnrichInput {
  job_id?: string;
  company_ids?: string[];
  limit?: number;
  force?: boolean;
  dry_run?: boolean;
  mode?: Mode;
  max_cost_eur?: number;
}

interface CompanyRow {
  id: string;
  name: string | null;
  category: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  fit_reason: string | null;
  status: string | null;
  metadata: Record<string, unknown> | null;
}

interface FieldConfidence {
  website?: number;
  phone?: number;
  email?: number;
  address?: number;
  category?: number;
}

interface EnrichmentResult {
  enriched_at: string;
  providers_used: string[];
  total_cost_eur: number;
  confidence: number;
  field_confidence: FieldConfidence;
  official_website: string | null;
  contact_page: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  social_links: string[];
  refined_category: string | null;
  commercial_signals: string[];
  estimated_business_size: string | null;
  buyer_fit_score: number | null;
  contactability_score: number | null;
  next_best_action: string | null;
  fit_reason: string | null;
  source_urls: string[];
  cascade_stops: string[];
  warnings: string[];
}

interface CompanyOutcome {
  company_id: string;
  company_name: string | null;
  updated: boolean;
  skipped_reason?: string;
  before: { website: string | null; phone: string | null; email: string | null; address: string | null };
  after: { website: string | null; phone: string | null; email: string | null; address: string | null };
  confidence: number;
  providers_used: string[];
  cost_eur: number;
  duration_ms: number;
  warnings: string[];
  preserved_status: boolean;
  preserved_notes: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

const HARD_MAX = 20;
const DEFAULT_LIMIT = 10;
const ENRICH_TTL_DAYS = 30;
const FETCH_TIMEOUT_MS = 7000;
const MAX_DIRECT_PAGES = 3;
const MAX_FIRECRAWL_PAGES = 5;
const CONCURRENCY = 3;
const CONF_GOOD_ENOUGH = 0.85;
const CONF_NEEDS_FALLBACK = 0.75;
const DEFAULT_JOB_BUDGET_EUR = 0.5;

const COST = {
  directFetch: 0,
  firecrawlScrape: 0.002,
  apifyRun: 0.01,
  perplexitySearch: 0.005,
  openaiCall: 0.001,
};

// ── Generic helpers ──────────────────────────────────────────────────────────

function newDebugId(): string {
  return "b2be_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function envelope(ok: boolean, data: unknown, error: string | null, debug_id: string, warnings: string[] = []) {
  return { ok, data, warnings, debug_id, error };
}

function jsonResponse(req: Request, status: number, body: ReturnType<typeof envelope>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json",
      "X-Function": "b2b-finder-enrich",
      "X-Contract": "b2b-finder/v0.3",
    },
  });
}

function isValidHttpUrl(u: string | null | undefined): u is string {
  if (!u) return false;
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch { return false; }
}

function rootDomain(u: string): string | null {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; }
}

// ── Normalization ────────────────────────────────────────────────────────────

function normalizeItalianPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return null;
  let n = digits.startsWith("+") ? digits.slice(1) : digits;
  if (n.startsWith("0039")) n = n.slice(4);
  else if (n.startsWith("39") && n.length >= 11) { /* keep */ }
  else if (/^[03]/.test(n)) n = "39" + n;
  if (n.length < 10 || n.length > 13) return null;
  return "+" + n;
}

const BAD_EMAIL_RE = /(noreply|no-reply|donotreply|wordpress|sentry|example\.|@2x|\.png$|\.jpg$|\.webp$|\.svg$|@sentry|wixpress|@cdn)/i;

function validateEmail(e: string): string | null {
  const lo = e.trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(lo)) return null;
  if (BAD_EMAIL_RE.test(lo)) return null;
  return lo;
}

function uniq<T>(a: T[]): T[] { return Array.from(new Set(a)); }

// ── Text extraction ──────────────────────────────────────────────────────────

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?39[\s.-]?)?(?:0\d{1,3}|3\d{2})[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g;
const SOCIAL_HOSTS = ["facebook.com","instagram.com","linkedin.com","tiktok.com","x.com","twitter.com","youtube.com"];

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

function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#x?\d+;/gi, " ")
    .replace(/\s+/g, " ").trim();
}

function extractEmails(text: string, html: string): string[] {
  const out = new Set<string>();
  for (const m of html.match(/mailto:([^"'\s>]+)/gi) ?? []) {
    const v = validateEmail(m.replace(/^mailto:/i, "").split("?")[0]);
    if (v) out.add(v);
  }
  for (const e of text.match(EMAIL_RE) ?? []) {
    const v = validateEmail(e); if (v) out.add(v);
  }
  return Array.from(out).slice(0, 8);
}

function extractPhones(text: string, html: string): string[] {
  const out = new Set<string>();
  for (const m of html.match(/tel:([^"'\s>]+)/gi) ?? []) {
    const n = normalizeItalianPhone(m.replace(/^tel:/i, "")); if (n) out.add(n);
  }
  for (const p of text.match(PHONE_RE) ?? []) {
    const n = normalizeItalianPhone(p); if (n) out.add(n);
  }
  return Array.from(out).slice(0, 5);
}

function extractSocials(html: string): string[] {
  const out = new Set<string>();
  for (const raw of html.match(/href=["']([^"']+)["']/gi) ?? []) {
    const m = raw.match(/href=["']([^"']+)["']/i); if (!m) continue;
    const url = m[1];
    for (const host of SOCIAL_HOSTS) {
      if (url.toLowerCase().includes(host)) { out.add(url.split("#")[0].split("?")[0]); break; }
    }
  }
  return Array.from(out).slice(0, 8);
}

function refineCategory(text: string, current: string | null): string | null {
  for (const r of CATEGORY_RULES) if (r.kw.test(text)) return r.cat;
  return current ?? null;
}

function detectSignals(text: string): string[] {
  const out = new Set<string>();
  for (const r of COMMERCIAL_SIGNAL_RULES) if (r.kw.test(text)) out.add(r.label);
  return Array.from(out);
}

function findContactPage(html: string, baseUrl: string): string | null {
  const re = /href=["']([^"']+)["'][^>]*>([^<]{0,80})</gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1]; const label = m[2].toLowerCase();
    if (/contat|contact/i.test(href) || /contat|contact/i.test(label)) {
      try { return new URL(href, baseUrl).toString(); } catch { return null; }
    }
  }
  return null;
}

// ── HTTP fetch with timeout + URL cache ──────────────────────────────────────

const urlCache = new Map<string, { ok: boolean; status: number; html: string; finalUrl: string }>();

async function fetchPage(url: string): Promise<{ ok: boolean; status: number; html: string; finalUrl: string }> {
  if (urlCache.has(url)) return urlCache.get(url)!;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET", redirect: "follow", signal: ctl.signal,
      headers: {
        "User-Agent": "CivikoBot/1.0 (+contact)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "it-IT,it;q=0.9",
      },
    });
    const html = await res.text();
    const result = { ok: res.ok, status: res.status, html, finalUrl: res.url };
    if (res.ok) urlCache.set(url, result);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "fetch_error";
    return { ok: false, status: 0, html: "", finalUrl: url + " [" + msg.slice(0, 60) + "]" };
  } finally { clearTimeout(t); }
}

// ── Circuit breaker per provider ─────────────────────────────────────────────

const breaker: Record<string, { fails: number; openUntil: number }> = {};
function isOpen(p: string): boolean {
  const b = breaker[p]; if (!b) return false;
  if (Date.now() < b.openUntil) return true;
  if (b.openUntil && Date.now() >= b.openUntil) { breaker[p] = { fails: 0, openUntil: 0 }; }
  return false;
}
function recordFail(p: string) {
  const b = breaker[p] ?? { fails: 0, openUntil: 0 };
  b.fails++;
  if (b.fails >= 3) b.openUntil = Date.now() + 60_000;
  breaker[p] = b;
}
function recordOk(p: string) { breaker[p] = { fails: 0, openUntil: 0 }; }

// ── Provider availability ────────────────────────────────────────────────────

function availableProviders() {
  return {
    direct_fetch: true,
    firecrawl: !!Deno.env.get("FIRECRAWL_API_KEY") && (Deno.env.get("B2B_FINDER_FIRECRAWL_ENABLED") ?? "true") !== "false",
    apify: !!Deno.env.get("APIFY_API_TOKEN"),
    perplexity: !!Deno.env.get("PERPLEXITY_API_KEY"),
    openai: !!Deno.env.get("OPENAI_API_KEY"),
  };
}

// ── Firecrawl ────────────────────────────────────────────────────────────────

async function firecrawlScrape(url: string): Promise<{ markdown: string; html: string } | null> {
  if (isOpen("firecrawl")) return null;
  const key = Deno.env.get("FIRECRAWL_API_KEY"); if (!key) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST", signal: ctl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown", "html"], onlyMainContent: true }),
    });
    clearTimeout(t);
    if (!r.ok) { recordFail("firecrawl"); return null; }
    const j = await r.json();
    recordOk("firecrawl");
    return { markdown: j.data?.markdown ?? j.markdown ?? "", html: j.data?.html ?? j.html ?? "" };
  } catch { recordFail("firecrawl"); return null; }
}

// ── Perplexity ───────────────────────────────────────────────────────────────

async function perplexityFindContacts(name: string, hintLocality: string | null): Promise<{ website: string | null; phone: string | null; email: string | null; sources: string[] } | null> {
  if (isOpen("perplexity")) return null;
  const key = Deno.env.get("PERPLEXITY_API_KEY"); if (!key) return null;
  try {
    const prompt = `Trova SOLO da fonti ufficiali per l'attività "${name}"${hintLocality ? ` a ${hintLocality}` : ""}:
- sito ufficiale (URL)
- telefono pubblicato
- email pubblicata
Restituisci JSON: {"website":..., "phone":..., "email":...}. Se non trovi una fonte ufficiale, metti null. Non inventare.`;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    const r = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST", signal: ctl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          { role: "system", content: "Sei un assistente di ricerca. Rispondi solo con JSON valido." },
          { role: "user", content: prompt },
        ],
        max_tokens: 400,
      }),
    });
    clearTimeout(t);
    if (!r.ok) { recordFail("perplexity"); return null; }
    const j = await r.json();
    recordOk("perplexity");
    const content = j.choices?.[0]?.message?.content ?? "";
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    return {
      website: isValidHttpUrl(parsed.website) ? parsed.website : null,
      phone: parsed.phone ? normalizeItalianPhone(String(parsed.phone)) : null,
      email: parsed.email ? validateEmail(String(parsed.email)) : null,
      sources: Array.isArray(j.citations) ? j.citations.slice(0, 5) : [],
    };
  } catch { recordFail("perplexity"); return null; }
}

// ── OpenAI consolidator ──────────────────────────────────────────────────────

interface OpenAIConsolidated {
  official_website: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  refined_category: string | null;
  estimated_business_size: string | null;
  buyer_fit_score: number;
  contactability_score: number;
  fit_reason: string | null;
  next_best_action: string | null;
  field_confidence: FieldConfidence;
}

async function openaiConsolidate(payload: Record<string, unknown>): Promise<OpenAIConsolidated | null> {
  if (isOpen("openai")) return null;
  const key = Deno.env.get("OPENAI_API_KEY"); if (!key) return null;
  try {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        official_website: { type: ["string", "null"] },
        phone: { type: ["string", "null"] },
        email: { type: ["string", "null"] },
        address: { type: ["string", "null"] },
        refined_category: { type: ["string", "null"] },
        estimated_business_size: { type: ["string", "null"], enum: ["micro", "small", "medium", "large", null] },
        buyer_fit_score: { type: "number" },
        contactability_score: { type: "number" },
        fit_reason: { type: ["string", "null"] },
        next_best_action: { type: ["string", "null"] },
        field_confidence: {
          type: "object", additionalProperties: false,
          properties: {
            website: { type: "number" }, phone: { type: "number" },
            email: { type: "number" }, address: { type: "number" }, category: { type: "number" },
          },
          required: ["website", "phone", "email", "address", "category"],
        },
      },
      required: ["official_website","phone","email","address","refined_category","estimated_business_size","buyer_fit_score","contactability_score","fit_reason","next_best_action","field_confidence"],
    };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", signal: ctl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Sei un consolidatore dati B2B. Non inventare nulla. Se un dato non è verificato dalle fonti fornite, metti null. Per il prodotto 'Coprimacchia TNT' (tovagliette monouso TNT per ristorazione), valuta buyer_fit_score 0-1." },
          { role: "user", content: JSON.stringify(payload) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "b2b_consolidation", strict: true, schema },
        },
        temperature: 0.1,
      }),
    });
    clearTimeout(t);
    if (!r.ok) {
      recordFail("openai");
      return null;
    }
    const j = await r.json();
    recordOk("openai");
    const content = j.choices?.[0]?.message?.content ?? "";
    const parsed: OpenAIConsolidated = JSON.parse(content);
    if (parsed.phone) parsed.phone = normalizeItalianPhone(parsed.phone) ?? parsed.phone;
    if (parsed.email) parsed.email = validateEmail(parsed.email) ?? null;
    if (parsed.official_website && !isValidHttpUrl(parsed.official_website)) parsed.official_website = null;
    return parsed;
  } catch { recordFail("openai"); return null; }
}

// ── Cascade per company ──────────────────────────────────────────────────────

interface CascadeContext {
  mode: Mode;
  remainingBudget: () => number;
  spend: (eur: number) => void;
  avail: ReturnType<typeof availableProviders>;
}

async function cascadeEnrich(c: CompanyRow, ctx: CascadeContext): Promise<{ result: EnrichmentResult; providers: string[]; cost: number; stops: string[] }> {
  const providers: string[] = [];
  const sourceUrls: string[] = [];
  const warnings: string[] = [];
  const stops: string[] = [];
  let cost = 0;

  let website = isValidHttpUrl(c.website) ? c.website : null;
  let contactPage: string | null = null;
  let allHtml = "";
  let allText = "";

  // ─── Step 2: Direct Fetch ──────────────────────────────────────────────────
  if (website) {
    providers.push("direct_fetch");
    const home = await fetchPage(website);
    cost += COST.directFetch;
    if (home.ok) {
      allHtml += home.html;
      website = home.finalUrl;
      sourceUrls.push(home.finalUrl);
      contactPage = findContactPage(home.html, home.finalUrl);
      if (contactPage && contactPage !== home.finalUrl) {
        const cp = await fetchPage(contactPage);
        cost += COST.directFetch;
        if (cp.ok) { allHtml += "\n" + cp.html; sourceUrls.push(cp.finalUrl); }
        else warnings.push(`contact_status_${cp.status}`);
      }
      // Optional: a 3rd page if there's an obvious "menu" / "servizi" link
      const extra = (home.html.match(/href=["']([^"']*(?:menu|servizi|chi-siamo|about)[^"']*)["']/i) ?? [])[1];
      if (extra) {
        try {
          const exUrl = new URL(extra, home.finalUrl).toString();
          if (exUrl !== home.finalUrl && exUrl !== contactPage) {
            const ex = await fetchPage(exUrl); cost += COST.directFetch;
            if (ex.ok) { allHtml += "\n" + ex.html; sourceUrls.push(ex.finalUrl); }
          }
        } catch { /* ignore */ }
      }
    } else {
      warnings.push(`home_status_${home.status}`);
    }
  }

  allText = stripHtml(allHtml);

  // Build interim extraction
  let emails = extractEmails(allText, allHtml);
  let phones = extractPhones(allText, allHtml);
  let socials = extractSocials(allHtml);
  let category = refineCategory(allText, c.category);
  let signals = detectSignals(allText);

  function interimConfidence(): number {
    let conf = 0;
    if (allHtml) conf += 0.3;
    if (contactPage) conf += 0.1;
    if (emails.length) conf += 0.2;
    if (phones.length) conf += 0.15;
    if (signals.length) conf += Math.min(0.2, signals.length * 0.05);
    if (website) conf += 0.05;
    return Math.min(1, conf);
  }
  let conf = interimConfidence();

  if (conf >= CONF_GOOD_ENOUGH) stops.push("direct_fetch_sufficient");

  // ─── Step 3: Firecrawl fallback ────────────────────────────────────────────
  if (conf < CONF_NEEDS_FALLBACK && website && ctx.avail.firecrawl && ctx.remainingBudget() >= COST.firecrawlScrape) {
    providers.push("firecrawl");
    const fc = await firecrawlScrape(website);
    cost += COST.firecrawlScrape; ctx.spend(COST.firecrawlScrape);
    if (fc) {
      const fcText = stripHtml(fc.html || "") + "\n" + (fc.markdown || "");
      allText += "\n" + fcText;
      allHtml += "\n" + (fc.html || "");
      sourceUrls.push(website + "#firecrawl");
      emails = uniq([...emails, ...extractEmails(fcText, fc.html || "")]).slice(0, 8);
      phones = uniq([...phones, ...extractPhones(fcText, fc.html || "")]).slice(0, 5);
      socials = uniq([...socials, ...extractSocials(fc.html || "")]).slice(0, 8);
      category = refineCategory(fcText, category);
      signals = uniq([...signals, ...detectSignals(fcText)]);
      conf = interimConfidence();
      if (conf >= CONF_GOOD_ENOUGH) stops.push("firecrawl_sufficient");
    } else {
      warnings.push("firecrawl_unavailable_or_failed");
    }
  } else if (conf < CONF_NEEDS_FALLBACK && !ctx.avail.firecrawl) {
    warnings.push("firecrawl_skipped_disabled");
  }

  // ─── Step 4: Apify (deep mode only, when website missing/dynamic) ──────────
  if (ctx.mode === "deep" && !website && ctx.avail.apify) {
    warnings.push("apify_actor_not_configured_skipped");
    // Note: Apify token available but no specific actor wired yet.
    // Avoid spending without a verified actor mapping for this domain.
  }

  // ─── Step 5: Perplexity (only if site missing OR phone/email missing) ──────
  const needsSearch = (!website) || (!phones.length && !c.phone) || (!emails.length && !c.email);
  if (needsSearch && ctx.avail.perplexity && ctx.remainingBudget() >= COST.perplexitySearch && c.name) {
    providers.push("perplexity");
    const locality = (c.address ?? "").split(",").pop()?.trim() ?? null;
    const px = await perplexityFindContacts(c.name, locality);
    cost += COST.perplexitySearch; ctx.spend(COST.perplexitySearch);
    if (px) {
      if (!website && px.website) { website = px.website; sourceUrls.push(...px.sources); }
      if (px.phone) phones = uniq([px.phone, ...phones]).slice(0, 5);
      if (px.email) emails = uniq([px.email, ...emails]).slice(0, 8);
      sourceUrls.push(...px.sources);
      conf = interimConfidence();
    } else {
      warnings.push("perplexity_no_result");
    }
  }

  // ─── Step 6: OpenAI consolidator ───────────────────────────────────────────
  let consolidated: OpenAIConsolidated | null = null;
  if (ctx.avail.openai && ctx.remainingBudget() >= COST.openaiCall) {
    providers.push("openai");
    const payload = {
      input: {
        name: c.name, category: c.category, website, phone: c.phone, email: c.email,
        address: c.address,
      },
      extracted: {
        website, contact_page: contactPage,
        emails_found: emails, phones_found: phones, socials,
        category_refined: category, commercial_signals: signals,
        text_excerpt: allText.slice(0, 2500),
        source_urls: sourceUrls,
      },
      product: "Coprimacchia TNT (tovagliette monouso TNT per ristorazione)",
    };
    consolidated = await openaiConsolidate(payload);
    cost += COST.openaiCall; ctx.spend(COST.openaiCall);
    if (!consolidated) warnings.push("openai_consolidation_failed");
  }

  // Final assembly: openai wins for contested fields; otherwise extracted values
  const finalWebsite = consolidated?.official_website ?? website;
  const finalPhone = consolidated?.phone ?? phones[0] ?? c.phone ?? null;
  const finalEmail = consolidated?.email ?? emails[0] ?? c.email ?? null;
  const finalAddress = consolidated?.address ?? c.address ?? null;
  const finalCategory = consolidated?.refined_category ?? category;
  const fieldConf: FieldConfidence = consolidated?.field_confidence ?? {
    website: finalWebsite ? 0.7 : 0,
    phone: finalPhone ? (phones.length ? 0.8 : 0.5) : 0,
    email: finalEmail ? (emails.length ? 0.8 : 0.5) : 0,
    address: finalAddress ? 0.5 : 0,
    category: finalCategory ? 0.6 : 0,
  };
  const overallConf = Math.min(1, Math.max(conf, consolidated
    ? (Object.values(fieldConf).reduce((a, b) => a + (b ?? 0), 0) / 5)
    : conf));

  const result: EnrichmentResult = {
    enriched_at: new Date().toISOString(),
    providers_used: uniq(providers),
    total_cost_eur: Number(cost.toFixed(5)),
    confidence: Number(overallConf.toFixed(2)),
    field_confidence: fieldConf,
    official_website: finalWebsite,
    contact_page: contactPage,
    phone: finalPhone,
    email: finalEmail,
    address: finalAddress,
    social_links: socials,
    refined_category: finalCategory,
    commercial_signals: signals,
    estimated_business_size: consolidated?.estimated_business_size ?? null,
    buyer_fit_score: consolidated?.buyer_fit_score ?? null,
    contactability_score: consolidated?.contactability_score ?? (finalPhone && finalEmail ? 0.9 : finalPhone || finalEmail ? 0.6 : 0.2),
    next_best_action: consolidated?.next_best_action ?? null,
    fit_reason: consolidated?.fit_reason ?? null,
    source_urls: uniq(sourceUrls),
    cascade_stops: stops,
    warnings,
  };

  return { result, providers: uniq(providers), cost, stops };
}

// ── Concurrency limiter ──────────────────────────────────────────────────────

async function runWithConcurrency<T, R>(items: T[], n: number, worker: (it: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function next() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => next()));
  return results;
}

// ── Persistence ──────────────────────────────────────────────────────────────

async function persistEnrichment(supabase: SupabaseClient, c: CompanyRow, e: EnrichmentResult, mode: Mode, jobId: string | null, totalCost: number): Promise<{ updated: boolean; preserved_status: boolean; preserved_notes: boolean; err?: string }> {
  const currentMeta = (c.metadata ?? {}) as Record<string, unknown>;
  const newMeta = { ...currentMeta, enrichment: e };
  // Preserve metadata.notes_structured untouched (carried by spread).

  const patch: Record<string, unknown> = { metadata: newMeta };

  if (mode === "missing_only") {
    if (!c.phone && e.phone) patch.phone = e.phone;
    if (!c.email && e.email) patch.email = e.email;
    if (!c.website && e.official_website) patch.website = e.official_website;
    if (!c.address && e.address) patch.address = e.address;
    if (!c.category && e.refined_category) patch.category = e.refined_category;
    if (!c.fit_reason && e.fit_reason) patch.fit_reason = e.fit_reason;
  } else {
    // smart/deep: only fill missing core fields; never overwrite manual values
    if (!c.phone && e.phone) patch.phone = e.phone;
    if (!c.email && e.email) patch.email = e.email;
    if (!c.website && e.official_website) patch.website = e.official_website;
    if (!c.address && e.address) patch.address = e.address;
    if (e.refined_category && e.refined_category !== c.category && (e.field_confidence.category ?? 0) >= 0.8) {
      patch.category = e.refined_category;
    }
    if (e.fit_reason && !c.fit_reason) patch.fit_reason = e.fit_reason;
  }

  const { error } = await supabase.from("b2b_companies").update(patch).eq("id", c.id);
  if (error) return { updated: false, preserved_status: true, preserved_notes: true, err: error.message };

  // Ledger row (use 'other' to satisfy check constraint; actual provider in metadata)
  await supabase.from("b2b_usage_ledger").insert({
    provider: "other",
    action: "enrich",
    units: 1,
    cost_eur: Number(totalCost.toFixed(5)),
    job_id: jobId,
    metadata: {
      company_id: c.id, providers_used: e.providers_used,
      confidence: e.confidence, sources: e.source_urls,
    },
  });

  return { updated: true, preserved_status: true, preserved_notes: true };
}

// ── Handler ──────────────────────────────────────────────────────────────────

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
    const isDryRun = input.dry_run === true;
    const mode: Mode = (["preview", "smart", "deep", "missing_only"] as const).includes(input.mode as Mode)
      ? (input.mode as Mode) : "smart";
    const force = input.force === true;
    const requested = Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT));
    const limit = Math.min(requested, HARD_MAX);
    if (limit < requested) warnings.push(`limit_clamped:${requested}_to_${limit}`);

    const hasJob = typeof input.job_id === "string" && input.job_id.length > 0;
    const hasIds = Array.isArray(input.company_ids) && input.company_ids.length > 0;
    if (!hasJob && !hasIds) {
      return jsonResponse(req, 400, envelope(false, null, "job_id or company_ids required", debug_id));
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return jsonResponse(req, 500, envelope(false, null, "Server misconfigured", debug_id, warnings));
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const avail = availableProviders();
    const missingProviders = Object.entries(avail).filter(([_, v]) => !v).map(([k]) => k);
    if (missingProviders.length) warnings.push(`providers_unavailable:${missingProviders.join(",")}`);

    // Resolve job
    let jobId: string | null = null;
    if (hasJob) {
      const { data: job, error: jErr } = await supabase.from("b2b_search_jobs").select("id").eq("id", input.job_id!).maybeSingle();
      if (jErr) return jsonResponse(req, 500, envelope(false, null, "Job lookup failed", debug_id, warnings));
      if (!job) return jsonResponse(req, 404, envelope(false, null, "Job not found", debug_id, warnings));
      jobId = job.id as string;
    }

    let companyIds: string[] = [];
    if (hasIds) {
      companyIds = (input.company_ids ?? []).filter((s) => typeof s === "string");
    } else if (jobId) {
      const { data: srcRows, error: sErr } = await supabase
        .from("b2b_company_sources").select("company_id").eq("job_id", jobId).limit(500);
      if (sErr) return jsonResponse(req, 500, envelope(false, null, "Sources lookup failed", debug_id, warnings));
      companyIds = uniq((srcRows ?? []).map((r: { company_id: string }) => r.company_id));
    }
    if (companyIds.length === 0) {
      return jsonResponse(req, 404, envelope(false, null, "No companies to enrich", debug_id, warnings));
    }

    // Daily budget
    const dailyCap = parseFloat(Deno.env.get("B2B_FINDER_DAILY_BUDGET_EUR") ?? "2") || 2;
    const today = new Date().toISOString().slice(0, 10);
    const { data: ledgerToday } = await supabase
      .from("b2b_usage_ledger").select("cost_eur").eq("day", today);
    const spentToday = (ledgerToday ?? []).reduce((a: number, r: { cost_eur: number | string }) => a + Number(r.cost_eur ?? 0), 0);
    const dailyRemaining = Math.max(0, dailyCap - spentToday);
    if (dailyRemaining <= 0 && !isDryRun && mode !== "preview") {
      return jsonResponse(req, 429, envelope(false, null, "Daily budget exceeded", debug_id,
        [...warnings, `budget_spent_today=${spentToday.toFixed(4)} cap=${dailyCap}`]));
    }

    // Job budget
    const jobBudget = Math.min(
      typeof input.max_cost_eur === "number" ? Math.max(0, input.max_cost_eur) : DEFAULT_JOB_BUDGET_EUR,
      dailyRemaining || DEFAULT_JOB_BUDGET_EUR,
    );

    // Fetch companies
    const { data: companies, error: cErr } = await supabase
      .from("b2b_companies")
      .select("id,name,category,website,phone,email,address,fit_reason,status,metadata")
      .in("id", companyIds.slice(0, limit));
    if (cErr) return jsonResponse(req, 500, envelope(false, null, "Companies lookup failed", debug_id, warnings));
    const rows = (companies ?? []) as CompanyRow[];

    // ── PREVIEW mode ─────────────────────────────────────────────────────────
    if (mode === "preview") {
      let estCost = 0;
      const preview = rows.map((c) => {
        const has = (c.metadata?.["enrichment"] as Record<string, unknown> | undefined)?.["enriched_at"];
        const fresh = has && (Date.now() - new Date(String(has)).getTime()) / 86400000 < ENRICH_TTL_DAYS;
        if (fresh && !force) return { company_id: c.id, name: c.name, plan: "skip_fresh", est_cost_eur: 0 };
        const steps: string[] = ["direct_fetch"];
        let cost = COST.directFetch * 2;
        if (!c.website || !c.phone || !c.email) {
          if (avail.firecrawl) { steps.push("firecrawl"); cost += COST.firecrawlScrape; }
          if ((!c.website || !c.phone) && avail.perplexity) { steps.push("perplexity"); cost += COST.perplexitySearch; }
        }
        if (avail.openai) { steps.push("openai"); cost += COST.openaiCall; }
        estCost += cost;
        return { company_id: c.id, name: c.name, plan: steps, est_cost_eur: Number(cost.toFixed(5)) };
      });
      return jsonResponse(req, 200, envelope(true, {
        mode, job_id: jobId, candidates: rows.length,
        providers_available: avail, estimated_total_cost_eur: Number(estCost.toFixed(5)),
        daily_remaining_eur: Number(dailyRemaining.toFixed(4)),
        plan: preview,
      }, null, debug_id, warnings));
    }

    // ── Execute cascade ──────────────────────────────────────────────────────
    let totalSpent = 0;
    const ctx: CascadeContext = {
      mode,
      remainingBudget: () => Math.max(0, jobBudget - totalSpent),
      spend: (eur) => { totalSpent += eur; },
      avail,
    };

    const t0 = Date.now();
    const outcomes = await runWithConcurrency<CompanyRow, CompanyOutcome>(rows, CONCURRENCY, async (c) => {
      const start = Date.now();
      const beforeSnap = { website: c.website, phone: c.phone, email: c.email, address: c.address };
      try {
        // Step 1: existing data check
        const existing = (c.metadata?.["enrichment"] as Record<string, unknown> | undefined) ?? null;
        if (!force && mode !== "missing_only" && existing?.["enriched_at"]) {
          const ageDays = (Date.now() - new Date(String(existing.enriched_at)).getTime()) / 86400000;
          const oldConf = Number(existing.confidence ?? 0);
          if (ageDays < ENRICH_TTL_DAYS && oldConf >= CONF_GOOD_ENOUGH) {
            return {
              company_id: c.id, company_name: c.name, updated: false,
              skipped_reason: `fresh_${Math.round(ageDays)}d_conf_${oldConf}`,
              before: beforeSnap, after: beforeSnap,
              confidence: oldConf, providers_used: [], cost_eur: 0,
              duration_ms: Date.now() - start, warnings: [],
              preserved_status: true, preserved_notes: true,
            };
          }
        }
        if (mode === "missing_only" && c.phone && c.email && c.website && c.address) {
          return {
            company_id: c.id, company_name: c.name, updated: false,
            skipped_reason: "nothing_missing",
            before: beforeSnap, after: beforeSnap,
            confidence: 1, providers_used: [], cost_eur: 0,
            duration_ms: Date.now() - start, warnings: [],
            preserved_status: true, preserved_notes: true,
          };
        }

        const { result, providers, cost } = await cascadeEnrich(c, ctx);

        if (isDryRun) {
          return {
            company_id: c.id, company_name: c.name, updated: false,
            skipped_reason: "dry_run",
            before: beforeSnap,
            after: { website: result.official_website, phone: result.phone, email: result.email, address: result.address },
            confidence: result.confidence, providers_used: providers, cost_eur: cost,
            duration_ms: Date.now() - start,
            warnings: ["dry_run_no_write", ...result.warnings],
            preserved_status: true, preserved_notes: true,
          };
        }

        const persist = await persistEnrichment(supabase, c, result, mode, jobId, cost);
        return {
          company_id: c.id, company_name: c.name,
          updated: persist.updated,
          skipped_reason: persist.err ? `db_failed:${persist.err}` : undefined,
          before: beforeSnap,
          after: {
            website: persist.updated && !c.website ? result.official_website : c.website,
            phone: persist.updated && !c.phone ? result.phone : c.phone,
            email: persist.updated && !c.email ? result.email : c.email,
            address: persist.updated && !c.address ? result.address : c.address,
          },
          confidence: result.confidence,
          providers_used: providers,
          cost_eur: cost,
          duration_ms: Date.now() - start,
          warnings: result.warnings,
          preserved_status: true,
          preserved_notes: true,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "error";
        return {
          company_id: c.id, company_name: c.name, updated: false,
          skipped_reason: `unhandled:${msg.slice(0, 120)}`,
          before: beforeSnap, after: beforeSnap,
          confidence: 0, providers_used: [], cost_eur: 0,
          duration_ms: Date.now() - start, warnings: [`unhandled:${msg.slice(0, 120)}`],
          preserved_status: true, preserved_notes: true,
        };
      }
    });

    const totalDuration = Date.now() - t0;
    const updated = outcomes.filter((o) => o.updated).length;
    const skipped = outcomes.filter((o) => !o.updated).length;

    console.log(`[b2b-finder-enrich] done debug_id=${debug_id} mode=${mode} job=${jobId ?? "-"} updated=${updated} skipped=${skipped} cost=${totalSpent.toFixed(4)} dur=${totalDuration}ms`);

    return jsonResponse(req, 200, envelope(true, {
      mode, job_id: jobId, dry_run: isDryRun,
      processed: outcomes.length, updated, skipped,
      total_cost_eur: Number(totalSpent.toFixed(5)),
      duration_ms: totalDuration,
      providers_available: avail,
      job_budget_eur: jobBudget,
      daily_remaining_eur: Number(dailyRemaining.toFixed(4)),
      results: outcomes,
    }, null, debug_id, warnings));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "internal error";
    console.error(`[b2b-finder-enrich] unhandled debug_id=${debug_id} err=${msg}`);
    return new Response(
      JSON.stringify({ ok: false, data: null, warnings: [], debug_id, error: "Internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
