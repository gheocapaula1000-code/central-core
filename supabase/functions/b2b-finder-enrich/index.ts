// b2b-finder-enrich v0.4 — Async orchestrator (search + enrichment) for B2B leads.
//
// Routes (POST):
//   • action="start_enrichment_job"   → enqueue async job (returns enrichment_job_id)
//   • action="get_enrichment_progress"→ progress snapshot
//   • action="cancel_enrichment_job"  → request cancellation
//   • (no action) legacy sync mode      → kept for back-compat (preview/dry_run/smoke tests)
//
// Cascade per company (short-circuits at code-side confidence ≥ 0.85 OR budget):
//   1. Existing data (skip if fresh+high conf, unless force / missing_only)
//   2. Direct Fetch (homepage + contact + 1 extra)
//   3. Firecrawl (≤5 pages/domain, only if direct fetch insufficient or conf<0.75)
//   4. Apify (deep mode, only when website unknown AND actor configured via env)
//   5. Perplexity (only if site missing OR phone/email missing)
//   6. OpenAI (consolidation; confidence values from GPT IGNORED — code computes)
//
// Confidence is always computed in code (per-field + overall). GPT never sets it.
// Concurrency: 3. Daily + per-job budgets enforced.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders, handlePreflight, pickOrigin } from "../_shared/b2b/cors.ts";
import { authorizeB2BFinder } from "../_shared/b2b/auth.ts";

// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: any;

// ── Types ────────────────────────────────────────────────────────────────────

type Mode = "smart" | "deep" | "missing_only";
type Action =
  | "start_enrichment_job"
  | "get_enrichment_progress"
  | "cancel_enrichment_job";

interface CompanyRow {
  id: string;
  name: string | null;
  category: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  comune: string | null;
  fit_reason: string | null;
  status: string | null;
  metadata: Record<string, unknown> | null;
}

interface FieldConfidence {
  website: number;
  phone: number;
  email: number;
  address: number;
  category: number;
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
  data_completeness_score: number;
  next_best_action: string | null;
  ready_to_contact: boolean;
  fit_reason: string | null;
  source_urls: string[];
  cascade_stops: string[];
  conflicts: string[];
  warnings: string[];
  // v0.5 commercial enrichment
  priority_label: "Alta" | "Media" | "Bassa";
  status_suggestion: "Pronto Da Contattare" | "Da Migliorare" | "Escluso";
  buyer_fit_reason: string | null;
  exclusion_reason: string | null;
  business_summary: string | null;
  product_use_case: string | null;
  decision_maker_hint: string | null;
  contact_channel_recommendation: "Telefono" | "Email" | "Sito" | "Visita" | "Da Verificare";
  call_opener: string | null;
  whatsapp_or_email_message: string | null;
  missing_data: string[];
  verification_checks: string[];
  public_sources_used: string[];
  // v0.6 phone discovery
  phone_href: string | null;
  phone_pretty: string | null;
  phone_discovery: PhoneDiscovery;
  // v0.7 search_mode resellers
  search_mode: "clients" | "resellers";
  reseller_fit_score: number | null;
  reseller_fit_reason: string | null;
  resale_use_case: string | null;
  suggested_offer_angle: string | null;
  price_advantage_angle: string | null;
  buyer_type: "Cliente Finale" | "Rivenditore" | "Fornitore" | "Da Verificare";
  // v0.8 quality gate
  data_quality_score: number;
  phone_quality_score: number;
  geo_quality_score: number;
  duplicate_risk: "Basso" | "Medio" | "Alto";
  data_quality_notes: string[];
}


interface PhoneDiscovery {
  found: boolean;
  phone: string | null;          // pretty: "+39 049 1234567"
  phone_e164: string | null;     // "+390491234567"
  phone_href: string | null;     // "tel:+390491234567"
  source: "existing" | "osm" | "official_site" | "contact_page" | "schema_org" | "public_search" | "directory" | null;
  confidence: number;            // 0-100
  checked_sources: string[];
  candidates: string[];          // all unique E.164 candidates collected
  notes: string | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

const HARD_MAX = 500;
const ENRICH_TTL_DAYS = 30;
const FETCH_TIMEOUT_MS = 7000;
const MAX_FIRECRAWL_PAGES = 5;
const CONCURRENCY = 3;
const CONF_GOOD_ENOUGH = 0.85;
const CONF_NEEDS_FALLBACK = 0.75;
const DEFAULT_JOB_BUDGET_EUR = 0.5;

const COST = {
  directFetch: 0,
  firecrawlScrape: 0.002,
  apifyRun: 0.02,
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
      "X-Contract": "b2b-finder/v0.8",
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

function uniq<T>(a: T[]): T[] { return Array.from(new Set(a)); }

// ── Normalization ────────────────────────────────────────────────────────────

function normalizeItalianPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return null;
  let n = digits.startsWith("+") ? digits.slice(1) : digits;
  if (n.startsWith("0039")) n = n.slice(4);
  else if (n.startsWith("39") && n.length >= 11) { /* keep */ }
  else if (/^[03]/.test(n)) n = "39" + n;
  if (n.length < 10 || n.length > 13) return null;
  const bare = n.replace(/^39/, "");
  // Hard rejections (junk / fake patterns)
  if (/^(\d)\1+$/.test(bare)) return null;                 // tutti uguali
  if (bare.length < 8) return null;
  if (new Set(bare).size <= 2) return null;                // <=2 cifre uniche → falso
  if (/^0?1?23456789/.test(bare) || /^9876543210/.test(bare)) return null; // sequenziale
  if (/^0000/.test(bare) || /^1111/.test(bare)) return null;
  // Italian numbers: mobile must start with 3, landline with 0 (after the country code).
  if (!/^[03]/.test(bare)) return null;
  return "+" + n;
}

function prettyItalianPhone(e164: string): string {
  // Input expected like "+390491234567" or "+393331234567"
  if (!e164.startsWith("+39")) return e164;
  const rest = e164.slice(3);
  // Mobile: starts with 3, 10 digits => "+39 333 123 4567"
  if (/^3\d{8,9}$/.test(rest)) {
    return `+39 ${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6)}`;
  }
  // Landline: starts with 0
  if (rest.startsWith("0")) {
    // Common area codes: 2 (Milano), 6 (Roma) → 2 digits; others mostly 3 digits.
    const twoDigit = /^0[26]/.test(rest);
    const acLen = twoDigit ? 2 : 3;
    const ac = rest.slice(0, acLen);
    const num = rest.slice(acLen);
    return `+39 ${ac} ${num}`;
  }
  return `+39 ${rest}`;
}

function phoneHref(e164: string): string {
  return "tel:" + e164.replace(/[^\d+]/g, "");
}

const BAD_EMAIL_RE = /(noreply|no-reply|donotreply|wordpress|sentry|example\.|@2x|\.png$|\.jpg$|\.webp$|\.svg$|@sentry|wixpress|@cdn)/i;
function validateEmail(e: string): string | null {
  const lo = e.trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(lo)) return null;
  if (BAD_EMAIL_RE.test(lo)) return null;
  return lo;
}

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


// Generic phone regex tuned for IT numbers (mobile starting with 3, landline starting with 0).
const PHONE_GENERIC_RE = /(?:\+?39[\s.\/-]?)?(?:0\d{1,3}|3\d{2})[\s.\/-]?\d{2,4}[\s.\/-]?\d{3,4}/g;

// Wide net of attributes and labels used in IT pages to publish phones.
const PHONE_ATTR_PATTERNS: RegExp[] = [
  /(?:tel|telephone|telefono|cellulare|mobile|recapito|chiamaci|prenota(?:zione|zioni)?|phone|contact[:_-]?phone)\s*[:=]\s*["']?\+?[\d\s.\/()-]{7,25}/gi,
  /data-(?:tel|telephone|phone)\s*=\s*["']\+?[\d\s.\/()-]{7,25}["']/gi,
  /itemprop=["']telephone["'][^>]*>([^<]+)</gi,
  /content=["'](\+?[\d\s.\/()-]{7,25})["'][^>]*itemprop=["']telephone["']/gi,
];

function extractPhonesFromJsonLd(html: string): string[] {
  const out = new Set<string>();
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of blocks) {
    const body = block.replace(/^[\s\S]*?>/, "").replace(/<\/script>$/i, "");
    try {
      // Some sites put multiple JSON objects (one per line) — try direct first, then walk recursively.
      const parsed = JSON.parse(body);
      const stack: unknown[] = [parsed];
      while (stack.length) {
        const cur = stack.pop();
        if (!cur) continue;
        if (Array.isArray(cur)) { for (const v of cur) stack.push(v); continue; }
        if (typeof cur === "object") {
          for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
            if (/^telephone$/i.test(k) && typeof v === "string") {
              const n = normalizeItalianPhone(v); if (n) out.add(n);
            } else if (typeof v === "object" && v !== null) {
              stack.push(v);
            }
          }
        }
      }
    } catch {
      // Fallback: regex-extract any "telephone": "..."
      const m = body.match(/"telephone"\s*:\s*"([^"]+)"/gi) ?? [];
      for (const hit of m) {
        const v = hit.match(/"telephone"\s*:\s*"([^"]+)"/i)?.[1];
        if (v) { const n = normalizeItalianPhone(v); if (n) out.add(n); }
      }
    }
  }
  return Array.from(out);
}

function extractEmails(text: string, html: string): string[] {
  const out = new Set<string>();
  for (const m of html.match(/mailto:([^"'\s>]+)/gi) ?? []) {
    const v = validateEmail(m.replace(/^mailto:/i, "").split("?")[0]); if (v) out.add(v);
  }
  for (const e of text.match(EMAIL_RE) ?? []) {
    const v = validateEmail(e); if (v) out.add(v);
  }
  return Array.from(out).slice(0, 8);
}

function extractPhones(text: string, html: string): { phones: string[]; sources: Set<string> } {
  const out = new Set<string>();
  const srcSet = new Set<string>();

  // 1) tel: hrefs (highest signal)
  for (const m of html.match(/tel:([^"'\s>]+)/gi) ?? []) {
    const n = normalizeItalianPhone(m.replace(/^tel:/i, "")); if (n) { out.add(n); srcSet.add("tel_href"); }
  }
  // 2) schema.org JSON-LD telephone
  for (const n of extractPhonesFromJsonLd(html)) { out.add(n); srcSet.add("schema_org"); }
  // 3) labelled attributes / microdata
  for (const re of PHONE_ATTR_PATTERNS) {
    const matches = html.match(re) ?? [];
    for (const hit of matches) {
      const numPart = hit.replace(/^[^+\d]*/, "").match(/\+?[\d\s.\/()-]{7,25}/);
      if (numPart) { const n = normalizeItalianPhone(numPart[0]); if (n) { out.add(n); srcSet.add("html_attr"); } }
    }
  }
  // 4) Generic free-text phones (lowest signal, but catches footer plain text)
  for (const p of (text + " " + stripHtml(html)).match(PHONE_GENERIC_RE) ?? []) {
    const n = normalizeItalianPhone(p); if (n) { out.add(n); srcSet.add("text"); }
  }
  return { phones: Array.from(out).slice(0, 8), sources: srcSet };
}

// Backwards-compat thin wrapper used by older callers.
function extractPhonesList(text: string, html: string): string[] {
  return extractPhones(text, html).phones;
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

// Returns up to N likely contact / phone-bearing pages on the same site.
function findContactCandidatePages(html: string, baseUrl: string, max = 4): string[] {
  const LABEL_RE = /contat|contact|prenota|chiamaci|recapit|dove\s*siamo|location|info\b|orari|chi[-\s]siamo|trovaci|raggiungerci/i;
  const HREF_RE = /contat|contact|prenota|reservation|chiamaci|recapit|dove-siamo|location|orari|info|trovaci/i;
  const out = new Set<string>();
  const re = /href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)</gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1];
    const label = m[2].replace(/<[^>]+>/g, " ").trim().toLowerCase();
    if (LABEL_RE.test(label) || HREF_RE.test(href)) {
      try {
        const abs = new URL(href, baseUrl).toString().split("#")[0];
        // same host only
        if (new URL(abs).host === new URL(baseUrl).host) out.add(abs);
      } catch { /* ignore */ }
    }
    if (out.size >= max * 2) break;
  }
  return Array.from(out).slice(0, max);
}

// Kept for legacy callers (returns the first contact-like URL or null).
function findContactPage(html: string, baseUrl: string): string | null {
  const list = findContactCandidatePages(html, baseUrl, 1);
  return list[0] ?? null;
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
    firecrawl: !!Deno.env.get("FIRECRAWL_API_KEY")
      && (Deno.env.get("B2B_FINDER_FIRECRAWL_ENABLED") ?? "true") !== "false",
    apify: !!Deno.env.get("APIFY_API_TOKEN") && !!Deno.env.get("B2B_FINDER_APIFY_ACTOR_ID"),
    perplexity: !!Deno.env.get("PERPLEXITY_API_KEY"),
    openai: !!Deno.env.get("OPENAI_API_KEY"),
  };
}

// ── Firecrawl (≤5 pages/domain) ──────────────────────────────────────────────

async function firecrawlScrape(url: string): Promise<{ markdown: string; html: string } | null> {
  if (isOpen("firecrawl")) return null;
  const key = Deno.env.get("FIRECRAWL_API_KEY"); if (!key) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
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

// ── Apify (only if actor configured via env) ────────────────────────────────

interface ApifyOutcome {
  ok: boolean;
  website: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  dataset_id: string | null;
  run_id: string | null;
  duration_ms: number;
  cost_eur: number;
  error?: string;
}

async function apifyDiscover(name: string, locality: string | null): Promise<ApifyOutcome> {
  const t0 = Date.now();
  const token = Deno.env.get("APIFY_API_TOKEN");
  const actor = Deno.env.get("B2B_FINDER_APIFY_ACTOR_ID");
  if (!token || !actor) {
    return { ok: false, website: null, phone: null, email: null, address: null,
      dataset_id: null, run_id: null, duration_ms: 0, cost_eur: 0, error: "apify_not_configured" };
  }
  if (isOpen("apify")) {
    return { ok: false, website: null, phone: null, email: null, address: null,
      dataset_id: null, run_id: null, duration_ms: 0, cost_eur: 0, error: "apify_breaker_open" };
  }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 45000);
    const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${token}&timeout=40`;
    const r = await fetch(url, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: locality ? `${name} ${locality}` : name, maxItems: 1 }),
    });
    clearTimeout(t);
    if (!r.ok) {
      recordFail("apify");
      return { ok: false, website: null, phone: null, email: null, address: null,
        dataset_id: null, run_id: null, duration_ms: Date.now() - t0, cost_eur: 0,
        error: `apify_http_${r.status}` };
    }
    const runId = r.headers.get("X-Apify-Run-Id");
    const datasetId = r.headers.get("X-Apify-Dataset-Id");
    const items = await r.json().catch(() => []);
    recordOk("apify");
    const first = Array.isArray(items) && items.length ? items[0] : {};
    const website = isValidHttpUrl(first.website) ? first.website : null;
    const phone = first.phone ? normalizeItalianPhone(String(first.phone)) : null;
    const email = first.email ? validateEmail(String(first.email)) : null;
    const address = first.address ? String(first.address).slice(0, 200) : null;
    return {
      ok: true, website, phone, email, address,
      dataset_id: datasetId, run_id: runId,
      duration_ms: Date.now() - t0, cost_eur: COST.apifyRun,
    };
  } catch (e) {
    recordFail("apify");
    const msg = e instanceof Error ? e.message : "apify_error";
    return { ok: false, website: null, phone: null, email: null, address: null,
      dataset_id: null, run_id: null, duration_ms: Date.now() - t0, cost_eur: 0, error: msg.slice(0, 80) };
  }
}

// ── Perplexity ───────────────────────────────────────────────────────────────

async function perplexityFindContacts(name: string, hintLocality: string | null, hintAddress: string | null = null): Promise<{ website: string | null; phone: string | null; email: string | null; sources: string[] } | null> {
  if (isOpen("perplexity")) return null;
  const key = Deno.env.get("PERPLEXITY_API_KEY"); if (!key) return null;
  try {
    const addrPart = hintAddress ? ` ${hintAddress}` : "";
    const cityPart = hintLocality ? ` ${hintLocality}` : "";
    // Phone-first query (priorità assoluta al telefono pubblicato).
    const phoneQuery = `numero di telefono ${name}${addrPart}${cityPart}`.trim();
    const prompt = `Priorità assoluta: trova il NUMERO DI TELEFONO pubblicato per l'attività.
Query di ricerca da eseguire: "${phoneQuery}"

Per l'attività "${name}"${hintLocality ? ` a ${hintLocality}` : ""}${hintAddress ? ` (${hintAddress})` : ""} cerca SOLO da fonti ufficiali:
1) TELEFONO pubblicato (campo obbligatorio se esiste — è la priorità)
2) sito ufficiale (URL)
3) email pubblicata

Restituisci JSON: {"phone":..., "website":..., "email":...}. Se non trovi una fonte ufficiale per un campo, metti null. Non inventare.`;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    const r = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST", signal: ctl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          { role: "system", content: "Sei un assistente di ricerca specializzato nel reperimento di numeri di telefono aziendali pubblici. Rispondi solo con JSON valido. Il telefono è il campo prioritario." },
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

// ── OpenAI consolidator (we ignore its confidence numbers) ───────────────────

interface OpenAIConsolidated {
  official_website: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  refined_category: string | null;
  estimated_business_size: string | null;
  buyer_fit_score: number;
  fit_reason: string | null;
  next_best_action: string | null;
  // v0.5 commercial
  buyer_fit_reason: string | null;
  exclusion_reason: string | null;
  business_summary: string | null;
  product_use_case: string | null;
  decision_maker_hint: string | null;
  call_opener: string | null;
  whatsapp_or_email_message: string | null;
  verification_checks: string[] | null;
  // v0.7 resellers
  reseller_fit_score?: number | null;
  reseller_fit_reason?: string | null;
  resale_use_case?: string | null;
  suggested_offer_angle?: string | null;
  price_advantage_angle?: string | null;
  buyer_type?: "Cliente Finale" | "Rivenditore" | "Fornitore" | "Da Verificare" | null;
}


async function openaiConsolidate(
  payload: Record<string, unknown>,
  searchMode: "clients" | "resellers" = "clients",
  productPhrase: string = "Coprimacchia TNT Colorati 100x100 cm (tovagliette monouso in tessuto non tessuto per coperti ristorazione, sagre, eventi, mense, agriturismi).",


): Promise<OpenAIConsolidated | null> {
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
        fit_reason: { type: ["string", "null"] },
        next_best_action: { type: ["string", "null"] },
        buyer_fit_reason: { type: ["string", "null"] },
        exclusion_reason: { type: ["string", "null"] },
        business_summary: { type: ["string", "null"] },
        product_use_case: { type: ["string", "null"] },
        decision_maker_hint: { type: ["string", "null"] },
        call_opener: { type: ["string", "null"] },
        whatsapp_or_email_message: { type: ["string", "null"] },
        verification_checks: { type: ["array", "null"], items: { type: "string" } },
        // v0.7 resellers
        reseller_fit_score: { type: ["number", "null"] },
        reseller_fit_reason: { type: ["string", "null"] },
        resale_use_case: { type: ["string", "null"] },
        suggested_offer_angle: { type: ["string", "null"] },
        price_advantage_angle: { type: ["string", "null"] },
        buyer_type: { type: ["string", "null"], enum: ["Cliente Finale", "Rivenditore", "Fornitore", "Da Verificare", null] },
      },
      required: [
        "official_website","phone","email","address","refined_category","estimated_business_size",
        "buyer_fit_score","fit_reason","next_best_action",
        "buyer_fit_reason","exclusion_reason","business_summary","product_use_case",
        "decision_maker_hint","call_opener","whatsapp_or_email_message","verification_checks",
        "reseller_fit_score","reseller_fit_reason","resale_use_case",
        "suggested_offer_angle","price_advantage_angle","buyer_type",
      ],
    };


    const baseRules =
      "Sei un consolidatore dati B2B per agenti commerciali italiani. " +
      "REGOLE TASSATIVE: " +
      "1) Non inventare MAI telefoni, email, siti, indirizzi o dati non presenti nelle fonti fornite: se non certo, metti null. " +
      "2) Tutti i testi in italiano, tono professionale, mai spam, mai aggressivo, mai usare le parole 'AI', 'IA', 'Intelligenza Artificiale'. " +
      "3) Niente promesse assolute: vietato dire 'prezzo più basso del mercato' o simili senza prove. Usa formule prudenti: 'prezzo competitivo', 'margine interessante', 'prodotto adatto al catalogo'. " +
      `4) Il prodotto è ${productPhrase} `;

    const clientsRules =
      "MODALITÀ: cerco CLIENTI FINALI (chi USA il prodotto). " +
      "5) buyer_fit_score 0-100: alto solo se l'attività usa davvero coperti monouso o ha alto turnover di tavoli (trattorie con pranzi di lavoro, mense, self service, agriturismi, pizzerie con coperti, sagre/eventi). Basso per bar/cafe puri senza ristorazione, gastronomie da asporto puro, panetterie, istituzionali con appalti chiusi. " +
      "6) buyer_fit_reason: 1-2 frasi concrete sul perché può USARE il prodotto. Vietate frasi generiche. " +
      "7) product_use_case: come potrebbero USARE il prodotto (es. 'Apparecchiatura veloce con busta portaposate + tovagliolo airlaid già pronta'). " +
      "8) buyer_type: in questa modalità è quasi sempre 'Cliente Finale'. " +
      "9) reseller_fit_score, reseller_fit_reason, resale_use_case, suggested_offer_angle, price_advantage_angle: METTI NULL. " +
      "10) decision_maker_hint: chi decide l'acquisto (es. 'Titolare', 'Responsabile sala'). " +
      "11) call_opener: max 180 caratteri, mai pressing. " +
      "12) whatsapp_or_email_message: max 350 caratteri, professionale, non spam. " +
      "13) verification_checks: 2-4 verifiche pratiche pre-contatto (es. 'Confermare numero coperti medi'). " +
      "14) next_best_action: azione breve (es. 'Chiamata al titolare in mattinata'). Per escluse: 'Non contattare' o simili. " +
      "15) Se mensa istituzionale o appalto pubblico: escludi con exclusion_reason chiaro e buyer_fit_score molto basso.";

    const resellersRules =
      "MODALITÀ: cerco RIVENDITORI (chi RIVENDE il prodotto al proprio catalogo). " +
      "5) reseller_fit_score 0-100: alto solo se l'attività ha un canale di vendita plausibile per articoli monouso da ristorazione/eventi/casalinghi: ingrossi horeca, cash and carry, forniture alberghiere/ristorazione, grossisti, distributori, negozi casalinghi, negozi articoli per ristorazione/bar/pizzerie, party store, packaging alimentare, articoli monouso, detergenza professionale, e-commerce locali coerenti, negozi biancheria tavola coerenti. " +
      "   Basso o nullo per: ristoranti puri, bar puri, pizzerie pure, gelaterie, locali che USANO ma NON rivendono, panetterie/pasticcerie senza canale vendita di tovagliato, attività senza canale vendita plausibile. " +
      "6) reseller_fit_reason: 1-2 frasi concrete sul perché può RIVENDERE il prodotto. Vietate frasi generiche. " +
      "7) resale_use_case: come può inserire il prodotto a catalogo o nel proprio assortimento. " +
      "8) suggested_offer_angle: angolo commerciale per la proposta (es. 'Listino rivenditore con sconto scaglionato per quantità'). " +
      "9) price_advantage_angle: prudente: 'Prezzo competitivo rispetto ai fornitori abituali, da verificare con un listino di confronto'. Mai 'più basso del mercato'. " +
      "10) buyer_type: 'Rivenditore' per negozi/catene che rivendono al pubblico; 'Fornitore' per ingrossi/distributori/cash and carry; 'Cliente Finale' per ristoranti/bar/pizzerie puri (in tal caso ESCLUDI con exclusion_reason e reseller_fit_score molto basso); 'Da Verificare' quando non è chiaro. " +
      "11) buyer_fit_score: USA lo STESSO valore di reseller_fit_score. " +
      "12) buyer_fit_reason: usa lo stesso contenuto di reseller_fit_reason. " +
      "13) product_use_case: se buyer_type è 'Cliente Finale' descrivi l'uso; altrimenti METTI NULL. " +
      "14) decision_maker_hint: chi decide (es. 'Titolare', 'Responsabile acquisti'). " +
      "15) call_opener: max 180 caratteri, FORNITURA/COLLABORAZIONE COMMERCIALE. " +
      "16) whatsapp_or_email_message: max 350 caratteri, proposta di collaborazione/invio listino. " +
      "17) verification_checks: 2-4 punti. " +
      "18) next_best_action: breve. Per escluse: 'Non contattare come rivenditore'. " +
      "19) exclusion_reason: SE è ristorante/bar/pizzeria puro o non ha canale rivendita → ESCLUDI.";

    const modeRules = searchMode === "resellers" ? resellersRules : clientsRules;
    const systemContent = baseRules + modeRules;


    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", signal: ctl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: JSON.stringify({ ...payload, search_mode: searchMode }) },
        ],
        response_format: { type: "json_schema", json_schema: { name: "b2b_consolidation", strict: true, schema } },
        temperature: 0.1,
      }),
    });
    clearTimeout(t);
    if (!r.ok) { recordFail("openai"); return null; }
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

// ── Code-side confidence (GPT is NOT allowed to assign confidence) ───────────

interface FieldEvidence {
  fromSite: boolean;       // present on official site (direct fetch or firecrawl of own domain)
  fromSearch: boolean;     // present in perplexity/search
  fromApify: boolean;      // present in apify discovery
  matchesAcrossSources: boolean; // same value observed in ≥2 independent sources
}

function scoreField(ev: FieldEvidence, hasAnyValue: boolean): number {
  if (!hasAnyValue) return 0;
  // 0.95: site + second independent source
  if (ev.fromSite && (ev.fromSearch || ev.fromApify || ev.matchesAcrossSources)) return 0.95;
  // 0.85: official site only
  if (ev.fromSite) return 0.85;
  // 0.70: two independent public sources (search + apify, or matches across two non-site)
  if ((ev.fromSearch && ev.fromApify) || ev.matchesAcrossSources) return 0.70;
  // 0.50: single directory/source
  if (ev.fromSearch || ev.fromApify) return 0.50;
  return 0;
}

// ── Cascade per company ──────────────────────────────────────────────────────

interface CascadeContext {
  mode: Mode;
  remainingBudget: () => number;
  spend: (eur: number) => void;
  avail: ReturnType<typeof availableProviders>;
  apifyMeta: Array<Record<string, unknown>>;
}

async function cascadeEnrich(c: CompanyRow, ctx: CascadeContext): Promise<{ result: EnrichmentResult; providers: string[]; cost: number }> {
  const providers: string[] = [];
  const sourceUrls: string[] = [];
  const warnings: string[] = [];
  const stops: string[] = [];
  const conflicts: string[] = [];
  let cost = 0;

  // v0.7/v0.8 — determine search mode from company metadata (default clients)
  const cMeta = (c.metadata ?? {}) as Record<string, unknown>;
  const rawMode = String((cMeta.search_mode ?? "") as string).toLowerCase();
  const searchMode: "clients" | "resellers" =
    rawMode === "resellers" || rawMode === "cerco_rivenditori" || rawMode === "rivenditori" ? "resellers" : "clients";

  const productNameMeta = typeof cMeta.product_name === "string" && cMeta.product_name ? cMeta.product_name as string : null;
  const productKeyMeta = typeof cMeta.product_key === "string" && cMeta.product_key ? cMeta.product_key as string : null;



  let website = isValidHttpUrl(c.website) ? c.website : null;
  const inputDomain = website ? rootDomain(website) : null;
  let contactPage: string | null = null;
  let allHtml = "";
  let allText = "";
  let pagesFromSite = 0;
  let firecrawlPagesUsed = 0;

  // Evidence tracking per field
  const ev = {
    website: { fromSite: false, fromSearch: false, fromApify: false, matchesAcrossSources: false } as FieldEvidence,
    phone:   { fromSite: false, fromSearch: false, fromApify: false, matchesAcrossSources: false } as FieldEvidence,
    email:   { fromSite: false, fromSearch: false, fromApify: false, matchesAcrossSources: false } as FieldEvidence,
    address: { fromSite: false, fromSearch: false, fromApify: false, matchesAcrossSources: false } as FieldEvidence,
    category:{ fromSite: false, fromSearch: false, fromApify: false, matchesAcrossSources: false } as FieldEvidence,
  };

  let phonesFromSite: string[] = [];
  let emailsFromSite: string[] = [];
  const phoneCheckedSources = new Set<string>();
  const phoneSourceMap = new Map<string, Set<string>>(); // phone E.164 → set of sources

  function addPhones(phones: string[], srcLabel: string) {
    if (!phones.length) return;
    phoneCheckedSources.add(srcLabel);
    for (const p of phones) {
      const s = phoneSourceMap.get(p) ?? new Set<string>();
      s.add(srcLabel);
      phoneSourceMap.set(p, s);
    }
  }

  // Seed with existing data already on the company (often from OSM/Overpass)
  if (c.phone) {
    const seed = normalizeItalianPhone(c.phone);
    if (seed) addPhones([seed], "existing");
  }
  // Existing OSM tags may be in metadata.osm_tags from the search step
  const osmTags = (c.metadata?.["osm_tags"] as Record<string, unknown> | undefined) ?? null;
  if (osmTags) {
    for (const k of ["phone", "contact:phone", "contact:mobile", "mobile"]) {
      const v = osmTags[k];
      if (typeof v === "string") {
        const n = normalizeItalianPhone(v);
        if (n) addPhones([n], "osm");
      }
    }
  }
  phoneCheckedSources.add("existing");

  // ── Step 2: Direct Fetch (homepage + up to 3 contact-candidate pages + 1 menu/about) ─
  let contactPagesFound: string[] = [];
  if (website) {
    providers.push("direct_fetch");
    phoneCheckedSources.add("official_site");
    const home = await fetchPage(website);
    if (home.ok) {
      pagesFromSite++;
      allHtml += home.html;
      website = home.finalUrl;
      ev.website.fromSite = true;
      sourceUrls.push(home.finalUrl);

      // Extract phones from homepage now, tagging source
      const homeExtract = extractPhones(stripHtml(home.html), home.html);
      addPhones(homeExtract.phones, "official_site");

      // Multiple candidate contact pages
      contactPagesFound = findContactCandidatePages(home.html, home.finalUrl, 3);
      contactPage = contactPagesFound[0] ?? null;
      for (const cpUrl of contactPagesFound) {
        if (cpUrl === home.finalUrl) continue;
        if (pagesFromSite >= 5) break;
        const cp = await fetchPage(cpUrl);
        if (cp.ok) {
          allHtml += "\n" + cp.html;
          sourceUrls.push(cp.finalUrl);
          pagesFromSite++;
          const cpExtract = extractPhones(stripHtml(cp.html), cp.html);
          addPhones(cpExtract.phones, "contact_page");
          if (cpExtract.sources.has("schema_org")) phoneCheckedSources.add("schema_org");
        } else {
          warnings.push(`contact_status_${cp.status}`);
        }
      }

      // One additional menu/about/info-style page to improve commercial signals + phone in footer
      const extra = (home.html.match(/href=["']([^"']*(?:menu|servizi|chi-siamo|about|footer|info)[^"']*)["']/i) ?? [])[1];
      if (extra && pagesFromSite < 5) {
        try {
          const exUrl = new URL(extra, home.finalUrl).toString();
          if (exUrl !== home.finalUrl && !contactPagesFound.includes(exUrl)) {
            const ex = await fetchPage(exUrl);
            if (ex.ok) {
              allHtml += "\n" + ex.html; sourceUrls.push(ex.finalUrl); pagesFromSite++;
              const exExtract = extractPhones(stripHtml(ex.html), ex.html);
              addPhones(exExtract.phones, "official_site");
            }
          }
        } catch { /* ignore */ }
      }
    } else {
      warnings.push(`home_status_${home.status}`);
    }
  }

  allText = stripHtml(allHtml);
  // Global re-extraction (covers anything missed by per-page passes)
  const allExtract = extractPhones(allText, allHtml);
  if (allExtract.sources.has("schema_org")) phoneCheckedSources.add("schema_org");
  addPhones(allExtract.phones, "official_site");
  phonesFromSite = Array.from(phoneSourceMap.keys()).filter((p) => {
    const s = phoneSourceMap.get(p)!;
    return s.has("official_site") || s.has("contact_page") || s.has("schema_org");
  });
  emailsFromSite = extractEmails(allText, allHtml);
  let socials = extractSocials(allHtml);
  let category = refineCategory(allText, c.category);
  let signals = detectSignals(allText);
  if (phonesFromSite.length) ev.phone.fromSite = true;
  if (emailsFromSite.length) ev.email.fromSite = true;
  if (category && category !== c.category) ev.category.fromSite = true;

  // Interim confidence (only structural)
  function interimConf(): number {
    let s = 0;
    if (ev.website.fromSite) s += 0.4;
    if (ev.phone.fromSite) s += 0.2;
    if (ev.email.fromSite) s += 0.15;
    if (contactPage) s += 0.05;
    if (signals.length) s += Math.min(0.1, signals.length * 0.03);
    return Math.min(1, s);
  }
  let conf = interimConf();
  if (conf >= CONF_GOOD_ENOUGH) stops.push("direct_fetch_sufficient");

  // ── Step 3: Firecrawl fallback ──────────────────────────────────────────────
  // Trigger when: confidence weak OR (website known but no phone discovered yet)
  const phoneStillMissing = phoneSourceMap.size === 0;
  const triggerFirecrawl = (conf < CONF_NEEDS_FALLBACK || phoneStillMissing) && !!website
    && ctx.avail.firecrawl && ctx.remainingBudget() >= COST.firecrawlScrape
    && firecrawlPagesUsed < MAX_FIRECRAWL_PAGES;
  if (triggerFirecrawl) {
    providers.push("firecrawl");
    const fc = await firecrawlScrape(website!);
    cost += COST.firecrawlScrape; ctx.spend(COST.firecrawlScrape); firecrawlPagesUsed++;
    if (fc) {
      const fcText = stripHtml(fc.html || "") + "\n" + (fc.markdown || "");
      allText += "\n" + fcText;
      allHtml += "\n" + (fc.html || "");
      sourceUrls.push(website + "#firecrawl");
      const fcExtract = extractPhones(fcText, fc.html || "");
      addPhones(fcExtract.phones, "official_site");
      if (fcExtract.sources.has("schema_org")) phoneCheckedSources.add("schema_org");
      const fcEmails = extractEmails(fcText, fc.html || "");
      if (fcExtract.phones.length) { ev.phone.fromSite = true; phonesFromSite = uniq([...phonesFromSite, ...fcExtract.phones]); }
      if (fcEmails.length) { ev.email.fromSite = true; emailsFromSite = uniq([...emailsFromSite, ...fcEmails]); }
      socials = uniq([...socials, ...extractSocials(fc.html || "")]).slice(0, 8);
      category = refineCategory(fcText, category);
      signals = uniq([...signals, ...detectSignals(fcText)]);
      conf = interimConf();
      if (conf >= CONF_GOOD_ENOUGH) stops.push("firecrawl_sufficient");
    } else {
      warnings.push("firecrawl_unavailable_or_failed");
    }
  } else if (conf < CONF_NEEDS_FALLBACK && !ctx.avail.firecrawl) {
    warnings.push("firecrawl_skipped_disabled");
  }


  // ── Step 4: Apify (deep mode, website missing / insufficient data) ─────────
  let apifyOut: ApifyOutcome | null = null;
  const needsDiscovery = !website && (ctx.mode === "deep");
  if (needsDiscovery && ctx.avail.apify && ctx.remainingBudget() >= COST.apifyRun && c.name) {
    providers.push("apify");
    phoneCheckedSources.add("directory");
    const locality = c.comune ?? (c.address ?? "").split(",").pop()?.trim() ?? null;
    apifyOut = await apifyDiscover(c.name, locality);
    if (apifyOut.ok) {
      cost += apifyOut.cost_eur; ctx.spend(apifyOut.cost_eur);
      ctx.apifyMeta.push({
        company_id: c.id, run_id: apifyOut.run_id, dataset_id: apifyOut.dataset_id,
        duration_ms: apifyOut.duration_ms, cost_eur: apifyOut.cost_eur,
      });
      if (!website && apifyOut.website) { website = apifyOut.website; ev.website.fromApify = true; }
      if (apifyOut.phone) { ev.phone.fromApify = true; addPhones([apifyOut.phone], "directory"); }
      if (apifyOut.email) ev.email.fromApify = true;
      if (apifyOut.address) ev.address.fromApify = true;
    } else {
      warnings.push(`apify_${apifyOut.error ?? "failed"}`);
    }
  } else if (needsDiscovery && !ctx.avail.apify) {
    warnings.push("apify_skipped_actor_not_configured");
  }

  // ── Step 5: Perplexity (when site missing, OR phone still missing/weak, OR email missing) ─
  let pxPhone: string | null = null;
  let pxEmail: string | null = null;
  let pxWebsite: string | null = null;
  const phoneWeak = phoneSourceMap.size === 0;
  const needsSearch = (!website) || phoneWeak || (!emailsFromSite.length && !c.email);
  if (needsSearch && ctx.avail.perplexity && ctx.remainingBudget() >= COST.perplexitySearch && c.name) {
    providers.push("perplexity");
    phoneCheckedSources.add("public_search");
    const locality = c.comune ?? (c.address ?? "").split(",").pop()?.trim() ?? null;
    const px = await perplexityFindContacts(c.name, locality, c.address ?? null);
    cost += COST.perplexitySearch; ctx.spend(COST.perplexitySearch);
    if (px) {
      if (!website && px.website) { website = px.website; pxWebsite = px.website; ev.website.fromSearch = true; }
      if (px.phone) {
        pxPhone = px.phone; ev.phone.fromSearch = true;
        addPhones([px.phone], "public_search");
      }
      if (px.email) { pxEmail = px.email; ev.email.fromSearch = true; }
      sourceUrls.push(...px.sources);
    } else {
      warnings.push("perplexity_no_result");
    }
  }


  // Cross-source match detection
  if (pxPhone && phonesFromSite.includes(pxPhone)) ev.phone.matchesAcrossSources = true;
  if (pxEmail && emailsFromSite.includes(pxEmail)) ev.email.matchesAcrossSources = true;
  if (pxPhone && apifyOut?.phone === pxPhone) ev.phone.matchesAcrossSources = true;
  if (pxEmail && apifyOut?.email === pxEmail) ev.email.matchesAcrossSources = true;

  // Conflict detection
  if (pxPhone && phonesFromSite.length && !phonesFromSite.includes(pxPhone)) conflicts.push("phone_search_vs_site");
  if (pxEmail && emailsFromSite.length && !emailsFromSite.includes(pxEmail)) conflicts.push("email_search_vs_site");
  if (pxWebsite && inputDomain && rootDomain(pxWebsite) && rootDomain(pxWebsite) !== inputDomain) {
    conflicts.push("website_domain_mismatch");
  }

  // ── Step 6: OpenAI consolidator (no confidence) ────────────────────────────
  let consolidated: OpenAIConsolidated | null = null;
  if (ctx.avail.openai && ctx.remainingBudget() >= COST.openaiCall) {
    providers.push("openai");
    const payload = {
      input: { name: c.name, category: c.category, website, phone: c.phone, email: c.email, address: c.address },
      extracted: {
        website, contact_page: contactPage,
        emails_found: emailsFromSite, phones_found: phonesFromSite, socials,
        category_refined: category, commercial_signals: signals,
        text_excerpt: allText.slice(0, 2500), source_urls: sourceUrls,
      },
      apify: apifyOut?.ok ? { website: apifyOut.website, phone: apifyOut.phone, email: apifyOut.email, address: apifyOut.address } : null,
      perplexity: pxPhone || pxEmail || pxWebsite ? { website: pxWebsite, phone: pxPhone, email: pxEmail } : null,
      product: productNameMeta
        ? (searchMode === "resellers"
            ? `${productNameMeta} — cerco RIVENDITORI (ingrossi horeca, cash and carry, negozi casalinghi, party store, packaging alimentare) che possano aggiungere il prodotto al loro catalogo`
            : `${productNameMeta} — cerco CLIENTI FINALI Horeca`)
        : (searchMode === "resellers"
            ? "Coprimacchia TNT 100x100 cm — cerco RIVENDITORI/FORNITORI (ingrossi horeca, cash and carry, negozi casalinghi, party store, packaging alimentare)"
            : "Coprimacchia TNT (tovagliette monouso TNT per ristorazione)"),

      product_key: productKeyMeta,
      search_mode: searchMode,
    };
    const productPhraseForOpenAI = productNameMeta
      ? `${productNameMeta} (prodotto Horeca per ristorazione/eventi).`
      : "Coprimacchia TNT Colorati 100x100 cm (tovagliette monouso in tessuto non tessuto per coperti ristorazione, sagre, eventi, mense, agriturismi).";
    consolidated = await openaiConsolidate(payload, searchMode, productPhraseForOpenAI);
    cost += COST.openaiCall; ctx.spend(COST.openaiCall);
    if (!consolidated) warnings.push("openai_consolidation_failed");
  }

  // ── Phone Discovery summary ─────────────────────────────────────────────────
  // Pick best phone candidate: prefer site/contact/schema → existing/osm → directory → public_search
  function pickPhoneCandidate(): { phone: string | null; src: PhoneDiscovery["source"]; confidence: number } {
    const SOURCE_RANK: Array<[string, PhoneDiscovery["source"], number]> = [
      ["contact_page", "contact_page", 92],
      ["schema_org", "schema_org", 95],
      ["official_site", "official_site", 90],
      ["existing", "existing", 70],
      ["osm", "osm", 75],
      ["directory", "directory", 65],
      ["public_search", "public_search", 55],
    ];
    let best: { phone: string | null; src: PhoneDiscovery["source"]; confidence: number } = { phone: null, src: null, confidence: 0 };
    for (const [tag, srcLabel, baseConf] of SOURCE_RANK) {
      for (const [ph, srcSet] of phoneSourceMap.entries()) {
        if (srcSet.has(tag)) {
          // Cross-source corroboration boost
          let conf = baseConf;
          if (srcSet.size >= 2) conf = Math.min(99, conf + 5);
          if (conf > best.confidence) best = { phone: ph, src: srcLabel, confidence: conf };
        }
      }
      if (best.phone) return best; // first source class hit wins
    }
    return best;
  }
  const phonePick = pickPhoneCandidate();
  const phoneDiscovery: PhoneDiscovery = {
    found: !!phonePick.phone,
    phone: phonePick.phone ? prettyItalianPhone(phonePick.phone) : null,
    phone_e164: phonePick.phone,
    phone_href: phonePick.phone ? phoneHref(phonePick.phone) : null,
    source: phonePick.src,
    confidence: phonePick.confidence,
    checked_sources: Array.from(phoneCheckedSources),
    candidates: Array.from(phoneSourceMap.keys()).slice(0, 8),
    notes: phonePick.phone
      ? `Numero raccolto da ${phonePick.src ?? "fonte pubblica"}; corroborato da ${(phoneSourceMap.get(phonePick.phone)?.size ?? 1)} fonte/i.`
      : "Nessun numero pubblico verificabile trovato nelle fonti consultate.",
  };

  // Final values: prefer site, then phoneDiscovery (preferred over apify/perplexity raw), then existing
  const finalWebsite = (ev.website.fromSite ? website : null) ?? consolidated?.official_website ?? website ?? apifyOut?.website ?? pxWebsite ?? null;
  const finalPhone = phoneDiscovery.phone_e164 ?? c.phone ?? consolidated?.phone ?? null;
  const finalEmail = emailsFromSite[0] ?? apifyOut?.email ?? pxEmail ?? c.email ?? consolidated?.email ?? null;
  const finalAddress = apifyOut?.address ?? consolidated?.address ?? c.address ?? null;
  const finalCategory = category ?? consolidated?.refined_category ?? c.category ?? null;

  // Field confidence (code-side only)
  const fieldConfidence: FieldConfidence = {
    website: scoreField(ev.website, !!finalWebsite),
    phone:   scoreField(ev.phone, !!finalPhone),
    email:   scoreField(ev.email, !!finalEmail),
    address: scoreField(ev.address, !!finalAddress),
    category:scoreField(ev.category, !!finalCategory),
  };
  // Lift phone field confidence if phone_discovery is strong
  if (phoneDiscovery.found && phoneDiscovery.confidence >= 85) {
    fieldConfidence.phone = Math.max(fieldConfidence.phone, 0.9);
  } else if (phoneDiscovery.found && phoneDiscovery.confidence >= 65) {
    fieldConfidence.phone = Math.max(fieldConfidence.phone, 0.7);
  }
  // Address fallback: if only from input + no source evidence → 0.50 (treated as single directory)
  if (finalAddress && fieldConfidence.address === 0) fieldConfidence.address = 0.50;
  if (finalCategory && fieldConfidence.category === 0 && c.category) fieldConfidence.category = 0.50;

  const overallConf = Number(
    ((fieldConfidence.website + fieldConfidence.phone + fieldConfidence.email + fieldConfidence.address + fieldConfidence.category) / 5).toFixed(2)
  );

  // Quality scores
  const present = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== "";
  const completenessParts = [present(finalWebsite), present(finalPhone), present(finalEmail), present(finalAddress), present(finalCategory)];
  const data_completeness_score = Math.round((completenessParts.filter(Boolean).length / completenessParts.length) * 100);

  // Contactability: phone is the dominant signal (esp. high-confidence phone)
  let contactability_score = 0;
  if (finalPhone) {
    const conf = phoneDiscovery.found ? phoneDiscovery.confidence : 60;
    contactability_score += conf >= 85 ? 65 : conf >= 65 ? 55 : 40;
  }
  if (finalEmail) contactability_score += 25;
  if (finalWebsite) contactability_score += 10;
  contactability_score = Math.min(100, contactability_score);


  let buyer_fit_score = consolidated?.buyer_fit_score ?? 0;
  if (buyer_fit_score <= 1 && buyer_fit_score > 0) buyer_fit_score = Math.round(buyer_fit_score * 100);
  buyer_fit_score = Math.max(0, Math.min(100, Math.round(buyer_fit_score)));

  const severeConflict = conflicts.includes("website_domain_mismatch");

  // v0.5: stricter but more inclusive readiness — spec: fit>=60, contact>=50, no severe conflict, no strong exclusion signal
  // v0.7 — derive buyer_type & exclusion for resellers mode
  type BuyerType = "Cliente Finale" | "Rivenditore" | "Fornitore" | "Da Verificare";
  const buyer_type: BuyerType =
    (consolidated?.buyer_type as BuyerType | null | undefined) ?? "Da Verificare";

  let extraExclusion: string | null = null;
  if (searchMode === "resellers" && buyer_type === "Cliente Finale") {
    extraExclusion = "Attività utilizzatrice (non rivenditore): non in target per ricerca rivenditori";
  }

  const exclusion_reason = (consolidated?.exclusion_reason && consolidated.exclusion_reason.trim())
    ? consolidated!.exclusion_reason!.trim()
    : extraExclusion;
  const hasStrongExclusion = !!exclusion_reason || buyer_fit_score < 30;

  // ── v0.8 Quality scores ─────────────────────────────────────────────────────
  // phone_quality_score: derived from phone_discovery confidence + cross-source corroboration.
  let phone_quality_score = 0;
  if (phoneDiscovery.found) {
    phone_quality_score = phoneDiscovery.confidence;
    // Penalize phones found only via public_search (no site corroboration)
    if (phoneDiscovery.source === "public_search" && !ev.phone.fromSite) {
      phone_quality_score = Math.min(phone_quality_score, 55);
    }
    // Penalize phones whose only corroboration is the existing OSM seed
    if (phoneDiscovery.source === "existing" && !ev.phone.fromSite && !ev.phone.fromSearch) {
      phone_quality_score = Math.min(phone_quality_score, 65);
    }
  }
  // geo_quality_score: comes from search-layer decoration in company metadata, fallback heuristic.
  const cMetaGeo = ((c.metadata ?? {}) as Record<string, unknown>);
  const inScopeMeta = cMetaGeo["in_scope"];
  const geoReason = String(cMetaGeo["geo_match_reason"] ?? "");
  let geo_quality_score = 70;
  if (inScopeMeta === true && geoReason === "city_and_bbox_match") geo_quality_score = 100;
  else if (inScopeMeta === true && geoReason === "city_match_no_coords") geo_quality_score = 80;
  else if (inScopeMeta === true) geo_quality_score = 75;
  else if (inScopeMeta === false) geo_quality_score = 30;

  // duplicate_risk: low by default; bumped by search layer pre-save (metadata.duplicate_risk).
  const dupHint = String(cMetaGeo["duplicate_risk"] ?? "").toLowerCase();
  let duplicate_risk: "Basso" | "Medio" | "Alto" =
    dupHint === "alto" ? "Alto" : dupHint === "medio" ? "Medio" : "Basso";

  // data_quality_score: weighted blend of completeness, phone, geo, fit.
  const data_quality_score = Math.round(
    data_completeness_score * 0.30 +
    phone_quality_score      * 0.30 +
    geo_quality_score        * 0.20 +
    Math.min(100, buyer_fit_score) * 0.20
  );

  const data_quality_notes: string[] = [];
  if (!phoneDiscovery.found) data_quality_notes.push("Telefono non trovato nelle fonti pubbliche consultate.");
  if (phoneDiscovery.found && phone_quality_score < 60) data_quality_notes.push("Telefono presente ma con bassa corroborazione.");
  if (geo_quality_score < 60) data_quality_notes.push("Comune del risultato non confermato rispetto alla ricerca.");
  if (duplicate_risk !== "Basso") data_quality_notes.push(`Possibile duplicato cross-comune (${duplicate_risk}).`);
  if (severeConflict) data_quality_notes.push("Conflitto dominio sito web rilevato.");

  // Ready-to-contact: phone richiesto, fit/contact sufficienti, comune corretto, niente duplicato alto, niente conflitto.
  const ready_to_contact =
    buyer_fit_score >= 60 &&
    contactability_score >= 50 &&
    !severeConflict &&
    !hasStrongExclusion &&
    phoneDiscovery.found &&
    phoneDiscovery.confidence >= 60 &&
    geo_quality_score >= 60 &&
    duplicate_risk !== "Alto";

  // Status suggestion
  let status_suggestion: "Pronto Da Contattare" | "Da Migliorare" | "Escluso";
  if (hasStrongExclusion || severeConflict) status_suggestion = "Escluso";
  else if (ready_to_contact && data_completeness_score >= 60) status_suggestion = "Pronto Da Contattare";
  else if (buyer_fit_score >= 50) status_suggestion = "Da Migliorare";
  else status_suggestion = "Escluso";


  // Priority label (commercial)
  let priority_label: "Alta" | "Media" | "Bassa";
  if (status_suggestion === "Pronto Da Contattare" && buyer_fit_score >= 75) priority_label = "Alta";
  else if (status_suggestion === "Pronto Da Contattare" || (buyer_fit_score >= 60 && contactability_score >= 40)) priority_label = "Media";
  else priority_label = "Bassa";

  // Contact channel recommendation
  let contact_channel_recommendation: "Telefono" | "Email" | "Sito" | "Visita" | "Da Verificare";
  if (status_suggestion === "Escluso") contact_channel_recommendation = "Da Verificare";
  else if (finalPhone) contact_channel_recommendation = "Telefono";
  else if (finalEmail) contact_channel_recommendation = "Email";
  else if (finalWebsite) contact_channel_recommendation = "Sito";
  else if (finalAddress) contact_channel_recommendation = "Visita";
  else contact_channel_recommendation = "Da Verificare";

  // Missing data (concrete and actionable, in italian)
  const missing_data: string[] = [];
  if (!finalPhone) missing_data.push("Telefono");
  if (!finalEmail) missing_data.push("Email");
  if (!finalWebsite) missing_data.push("Sito web");
  if (!finalAddress) missing_data.push("Indirizzo");
  if (!consolidated?.decision_maker_hint) missing_data.push("Nome referente");
  if (!consolidated?.business_summary) missing_data.push("Descrizione attività");

  // Verification checks: prefer GPT's list, ensure 2-4 items
  let verification_checks: string[] = Array.isArray(consolidated?.verification_checks)
    ? consolidated!.verification_checks!.filter((s) => typeof s === "string" && s.trim()).slice(0, 4)
    : [];
  if (verification_checks.length < 2) {
    const fallback = [
      "Confermare numero coperti medi al giorno",
      "Verificare se usano già tovagliato monouso",
      "Verificare orari di apertura e turni pranzo",
      "Confermare nome del titolare o responsabile acquisti",
    ];
    for (const f of fallback) {
      if (verification_checks.length >= 3) break;
      if (!verification_checks.includes(f)) verification_checks.push(f);
    }
  }

  // next_best_action: never aggressive for excluded
  let next_best_action = consolidated?.next_best_action ?? null;
  if (status_suggestion === "Escluso") {
    next_best_action = "Non contattare: bassa coerenza con il prodotto";
  } else if (!finalPhone) {
    next_best_action = "Trovare o verificare il telefono prima del contatto";
  } else if (!next_best_action) {
    if (ready_to_contact) next_best_action = "Chiamata commerciale al titolare";
    else if (buyer_fit_score < 60) next_best_action = "Qualificare il fit prima del contatto";
    else next_best_action = "Verificare dati mancanti prima del contatto";
  }

  // Suppress commercial copy for excluded leads
  const excluded = status_suggestion === "Escluso";
  const call_opener = excluded ? null : (consolidated?.call_opener ?? null);
  const whatsapp_or_email_message = excluded ? null : (consolidated?.whatsapp_or_email_message ?? null);

  // Public sources (deduped, http only)
  const public_sources_used = uniq(sourceUrls.filter((u) => /^https?:\/\//i.test(u))).slice(0, 8);

  // Confidence percentage for UI (0-100)
  const confidencePct = Math.round(overallConf * 100);

  const result: EnrichmentResult = {
    enriched_at: new Date().toISOString(),
    providers_used: uniq(providers),
    total_cost_eur: Number(cost.toFixed(5)),
    confidence: confidencePct,
    field_confidence: fieldConfidence,
    official_website: finalWebsite,
    contact_page: contactPage,
    phone: finalPhone,
    email: finalEmail,
    address: finalAddress,
    social_links: socials,
    refined_category: finalCategory,
    commercial_signals: signals,
    estimated_business_size: consolidated?.estimated_business_size ?? null,
    buyer_fit_score,
    contactability_score,
    data_completeness_score,
    next_best_action,
    ready_to_contact,
    fit_reason: consolidated?.fit_reason ?? c.fit_reason ?? null,
    source_urls: uniq(sourceUrls),
    cascade_stops: stops,
    conflicts,
    warnings,
    // v0.5 commercial
    priority_label,
    status_suggestion,
    buyer_fit_reason: consolidated?.buyer_fit_reason ?? null,
    exclusion_reason,
    business_summary: consolidated?.business_summary ?? null,
    product_use_case: consolidated?.product_use_case ?? null,
    decision_maker_hint: consolidated?.decision_maker_hint ?? null,
    contact_channel_recommendation,
    call_opener,
    whatsapp_or_email_message,
    missing_data,
    verification_checks,
    public_sources_used,
    // v0.6 phone discovery
    phone_href: phoneDiscovery.phone_href,
    phone_pretty: phoneDiscovery.phone,
    phone_discovery: phoneDiscovery,
    // v0.7 search_mode resellers
    search_mode: searchMode,
    reseller_fit_score: consolidated?.reseller_fit_score ?? (searchMode === "resellers" ? buyer_fit_score : null),
    reseller_fit_reason: consolidated?.reseller_fit_reason ?? (searchMode === "resellers" ? (consolidated?.buyer_fit_reason ?? null) : null),
    resale_use_case: consolidated?.resale_use_case ?? null,
    suggested_offer_angle: consolidated?.suggested_offer_angle ?? null,
    price_advantage_angle: consolidated?.price_advantage_angle ?? (searchMode === "resellers" ? "Prezzo competitivo, da confermare con listino di confronto" : null),
    buyer_type,
    // v0.8 quality gate
    data_quality_score,
    phone_quality_score,
    geo_quality_score,
    duplicate_risk,
    data_quality_notes,
  };

  return { result, providers: uniq(providers), cost };
}

// ── Concurrency limiter ──────────────────────────────────────────────────────

async function runWithConcurrency<T, R>(items: T[], n: number, worker: (it: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function next() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => next()));
  return results;
}

// ── Persistence ──────────────────────────────────────────────────────────────

async function persistEnrichment(supabase: SupabaseClient, c: CompanyRow, e: EnrichmentResult, mode: Mode, jobId: string | null, totalCost: number, apifyMeta: Record<string, unknown> | null): Promise<{ updated: boolean; err?: string }> {
  const currentMeta = (c.metadata ?? {}) as Record<string, unknown>;
  const newMeta = { ...currentMeta, enrichment: e };

  const patch: Record<string, unknown> = { metadata: newMeta };
  // Never overwrite: status, notes, manual fields. Only fill missing core fields.
  if (!c.phone && e.phone && (e.field_confidence.phone ?? 0) >= 0.7) patch.phone = e.phone;
  if (!c.email && e.email && (e.field_confidence.email ?? 0) >= 0.7) patch.email = e.email;
  if (!c.website && e.official_website && (e.field_confidence.website ?? 0) >= 0.7) patch.website = e.official_website;
  if (!c.address && e.address && (e.field_confidence.address ?? 0) >= 0.7) patch.address = e.address;
  if (e.refined_category && e.refined_category !== c.category && (e.field_confidence.category ?? 0) >= 0.8) {
    patch.category = e.refined_category;
  }
  if (e.fit_reason && !c.fit_reason) patch.fit_reason = e.fit_reason;

  const { error } = await supabase.from("b2b_companies").update(patch).eq("id", c.id);
  if (error) return { updated: false, err: error.message };

  await supabase.from("b2b_usage_ledger").insert({
    provider: "other",
    action: "enrich",
    units: 1,
    cost_eur: Number(totalCost.toFixed(5)),
    job_id: jobId,
    metadata: {
      company_id: c.id, providers_used: e.providers_used,
      confidence: e.confidence, field_confidence: e.field_confidence,
      sources: e.source_urls,
      apify: apifyMeta,
      ready_to_contact: e.ready_to_contact,
    },
  });
  return { updated: true };
}

// ── Async job runner ─────────────────────────────────────────────────────────

async function runEnrichmentJob(enrichmentJobId: string, supabase: SupabaseClient) {
  try {
    const { data: jobRow, error: jErr } = await supabase
      .from("b2b_enrichment_jobs").select("*").eq("id", enrichmentJobId).single();
    if (jErr || !jobRow) {
      console.error(`[b2b-enrich-job ${enrichmentJobId}] missing row`, jErr?.message);
      return;
    }
    if (jobRow.status === "cancelled" || jobRow.cancel_requested) {
      await supabase.from("b2b_enrichment_jobs").update({
        status: "cancelled", completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq("id", enrichmentJobId);
      return;
    }

    await supabase.from("b2b_enrichment_jobs").update({
      status: "running", started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", enrichmentJobId);

    const mode: Mode = jobRow.mode;
    const budgetEur: number = Number(jobRow.budget_eur) || DEFAULT_JOB_BUDGET_EUR;
    const companyIds: string[] = Array.isArray(jobRow.company_ids) ? jobRow.company_ids : [];
    const jobId: string | null = jobRow.job_id;
    const warnings: string[] = [];
    const apifyMeta: Array<Record<string, unknown>> = [];
    const avail = availableProviders();

    // Fetch companies in chunks of 200
    const chunks: string[][] = [];
    for (let i = 0; i < companyIds.length; i += 200) chunks.push(companyIds.slice(i, i + 200));
    const rows: CompanyRow[] = [];
    for (const ch of chunks) {
      const { data } = await supabase.from("b2b_companies")
        .select("id,name,category,website,phone,email,address,fit_reason,status,metadata,comune")
        .in("id", ch);
      if (data) rows.push(...(data as CompanyRow[]));
    }

    let totalSpent = 0;
    let processed = 0, updated = 0, skipped = 0, failed = 0, ready = 0;
    const providersAgg: Record<string, number> = {};

    const ctx: CascadeContext = {
      mode,
      remainingBudget: () => Math.max(0, budgetEur - totalSpent),
      spend: (eur) => { totalSpent += eur; },
      avail, apifyMeta,
    };

    let cancelChecked = Date.now();
    let lastFlush = Date.now();
    let cancelled = false;

    await runWithConcurrency(rows, CONCURRENCY, async (c) => {
      // Periodic cancel + flush check
      if (Date.now() - cancelChecked > 4000) {
        cancelChecked = Date.now();
        const { data: ck } = await supabase.from("b2b_enrichment_jobs")
          .select("cancel_requested").eq("id", enrichmentJobId).single();
        if (ck?.cancel_requested) cancelled = true;
      }
      if (cancelled) { skipped++; return; }
      if (totalSpent >= budgetEur) {
        skipped++;
        warnings.push(`budget_reached_skipped:${c.id}`);
        return;
      }

      try {
        const existing = (c.metadata?.["enrichment"] as Record<string, unknown> | undefined) ?? null;
        if (mode !== "missing_only" && existing?.["enriched_at"]) {
          const ageDays = (Date.now() - new Date(String(existing.enriched_at)).getTime()) / 86400000;
          const oldConf = Number(existing.confidence ?? 0);
          // v0.4 upgrade: never skip records that pre-date the ready_to_contact schema.
          const hasV04Schema = existing["ready_to_contact"] !== undefined;
          if (hasV04Schema && ageDays < ENRICH_TTL_DAYS && oldConf >= CONF_GOOD_ENOUGH) {
            skipped++; processed++;
            return;
          }
        }
        if (mode === "missing_only" && c.phone && c.email && c.website && c.address) {
          skipped++; processed++;
          return;
        }

        const { result, providers, cost } = await cascadeEnrich(c, ctx);
        providers.forEach((p) => providersAgg[p] = (providersAgg[p] ?? 0) + 1);
        const aMeta = apifyMeta.find((m) => m.company_id === c.id) ?? null;
        const persist = await persistEnrichment(supabase, c, result, mode, jobId, cost, aMeta);
        processed++;
        if (persist.updated) updated++;
        else failed++;
        if (result.ready_to_contact) ready++;
      } catch (e) {
        failed++; processed++;
        warnings.push(`unhandled:${c.id}:${(e instanceof Error ? e.message : "err").slice(0, 80)}`);
      }

      // Flush progress every 2s
      if (Date.now() - lastFlush > 2000) {
        lastFlush = Date.now();
        await supabase.from("b2b_enrichment_jobs").update({
          processed, updated_count: updated, skipped, failed, ready_to_contact: ready,
          cost_eur: Number(totalSpent.toFixed(5)),
          providers_used: providersAgg, warnings: warnings.slice(-50),
          updated_at: new Date().toISOString(),
        }).eq("id", enrichmentJobId);
      }
    });

    const finalStatus = cancelled ? "cancelled" : "completed";
    await supabase.from("b2b_enrichment_jobs").update({
      status: finalStatus,
      processed, updated_count: updated, skipped, failed, ready_to_contact: ready,
      cost_eur: Number(totalSpent.toFixed(5)),
      providers_used: providersAgg, warnings: warnings.slice(-50),
      completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", enrichmentJobId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "runner_error";
    console.error(`[b2b-enrich-job ${enrichmentJobId}] failed`, msg);
    await supabase.from("b2b_enrichment_jobs").update({
      status: "failed", error: msg.slice(0, 500),
      completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", enrichmentJobId);
  }
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
      return jsonResponse(req, 401, envelope(false, null, "Unauthorized", debug_id));
    }

    let body: Record<string, unknown>;
    try {
      const ct = req.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        return jsonResponse(req, 400, envelope(false, null, "Content-Type must be application/json", debug_id));
      }
      body = await req.json();
    } catch {
      return jsonResponse(req, 400, envelope(false, null, "Invalid JSON body", debug_id));
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return jsonResponse(req, 500, envelope(false, null, "Server misconfigured", debug_id));
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const action = (body.action as Action | undefined) ?? null;
    const avail = availableProviders();

    // ─── GET PROGRESS ────────────────────────────────────────────────────────
    if (action === "get_enrichment_progress") {
      const id = body.enrichment_job_id as string | undefined;
      if (!id) return jsonResponse(req, 400, envelope(false, null, "enrichment_job_id required", debug_id));
      const { data, error } = await supabase.from("b2b_enrichment_jobs").select("*").eq("id", id).maybeSingle();
      if (error || !data) return jsonResponse(req, 404, envelope(false, null, "Job not found", debug_id));
      const total = data.total ?? 0;
      const processed = data.processed ?? 0;
      const percent = total > 0 ? Math.round((processed / total) * 100) : 0;
      let estimated: string | null = null;
      if (data.status === "running" && data.started_at && processed > 0 && processed < total) {
        const elapsed = Date.now() - new Date(data.started_at).getTime();
        const perItem = elapsed / processed;
        estimated = new Date(Date.now() + perItem * (total - processed)).toISOString();
      }
      return jsonResponse(req, 200, envelope(true, {
        enrichment_job_id: data.id,
        job_id: data.job_id,
        mode: data.mode,
        status: data.status,
        total,
        processed,
        updated: data.updated_count ?? 0,
        skipped: data.skipped ?? 0,
        failed: data.failed ?? 0,
        ready_to_contact: data.ready_to_contact ?? 0,
        remaining: Math.max(0, total - processed),
        percent,
        cost_eur: Number(data.cost_eur ?? 0),
        budget_eur: Number(data.budget_eur ?? 0),
        providers_used: data.providers_used ?? {},
        started_at: data.started_at,
        completed_at: data.completed_at,
        estimated_completion_at: estimated,
        warnings: data.warnings ?? [],
        error: data.error,
      }, null, debug_id));
    }

    // ─── CANCEL ──────────────────────────────────────────────────────────────
    if (action === "cancel_enrichment_job") {
      const id = body.enrichment_job_id as string | undefined;
      if (!id) return jsonResponse(req, 400, envelope(false, null, "enrichment_job_id required", debug_id));
      const { data, error } = await supabase.from("b2b_enrichment_jobs")
        .update({ cancel_requested: true, updated_at: new Date().toISOString() })
        .eq("id", id).select("id,status").maybeSingle();
      if (error || !data) return jsonResponse(req, 404, envelope(false, null, "Job not found", debug_id));
      return jsonResponse(req, 200, envelope(true, { enrichment_job_id: data.id, cancel_requested: true, current_status: data.status }, null, debug_id));
    }

    // ─── START ───────────────────────────────────────────────────────────────
    if (action === "start_enrichment_job") {
      const jobIdInput = body.job_id as string | undefined;
      const companyIdsInput = Array.isArray(body.company_ids) ? (body.company_ids as string[]) : null;
      const mode: Mode = (["smart","deep","missing_only"] as const).includes(body.mode as Mode)
        ? (body.mode as Mode) : "smart";
      const requestedLimit = Math.max(1, Math.floor(Number(body.limit ?? 50)));
      const limit = Math.min(requestedLimit, HARD_MAX);
      const warnings: string[] = [];
      if (limit < requestedLimit) warnings.push(`limit_clamped:${requestedLimit}_to_${limit}`);

      if (!jobIdInput && !companyIdsInput?.length) {
        return jsonResponse(req, 400, envelope(false, null, "job_id or company_ids required", debug_id));
      }

      let jobId: string | null = null;
      if (jobIdInput) {
        const { data: j } = await supabase.from("b2b_search_jobs").select("id").eq("id", jobIdInput).maybeSingle();
        if (!j) return jsonResponse(req, 404, envelope(false, null, "Job not found", debug_id));
        jobId = j.id;
      }

      let companyIds: string[] = [];
      if (companyIdsInput?.length) {
        companyIds = uniq(companyIdsInput.filter((s) => typeof s === "string")).slice(0, limit);
      } else if (jobId) {
        const { data: src } = await supabase.from("b2b_company_sources")
          .select("company_id").eq("job_id", jobId).limit(HARD_MAX);
        companyIds = uniq((src ?? []).map((r: { company_id: string }) => r.company_id)).slice(0, limit);
      }
      if (!companyIds.length) {
        return jsonResponse(req, 404, envelope(false, null, "No companies to enrich", debug_id, warnings));
      }

      // Daily budget
      const dailyCap = parseFloat(Deno.env.get("B2B_FINDER_DAILY_BUDGET_EUR") ?? "2") || 2;
      const today = new Date().toISOString().slice(0, 10);
      const { data: ledgerToday } = await supabase.from("b2b_usage_ledger").select("cost_eur").eq("day", today);
      const spentToday = (ledgerToday ?? []).reduce((a: number, r: { cost_eur: number | string }) => a + Number(r.cost_eur ?? 0), 0);
      const dailyRemaining = Math.max(0, dailyCap - spentToday);
      if (dailyRemaining <= 0) {
        return jsonResponse(req, 429, envelope(false, null, "Daily budget exceeded", debug_id,
          [...warnings, `budget_spent_today=${spentToday.toFixed(4)} cap=${dailyCap}`]));
      }
      const requestedBudget = typeof body.max_cost_eur === "number" ? Math.max(0, body.max_cost_eur) : DEFAULT_JOB_BUDGET_EUR;
      const budgetEur = Math.min(requestedBudget, dailyRemaining);

      const { data: ins, error: insErr } = await supabase.from("b2b_enrichment_jobs").insert({
        job_id: jobId, mode, status: "queued",
        total: companyIds.length, limit_n: limit,
        budget_eur: budgetEur,
        company_ids: companyIds,
      }).select("id").single();
      if (insErr || !ins) {
        return jsonResponse(req, 500, envelope(false, null, "Failed to enqueue job", debug_id, [insErr?.message ?? "ins_err", ...warnings]));
      }

      // Background runner
      const enrichmentJobId = ins.id as string;
      const runPromise = runEnrichmentJob(enrichmentJobId, supabase);
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
        EdgeRuntime.waitUntil(runPromise);
      } else {
        runPromise.catch((e) => console.error("background runner error", e));
      }

      return jsonResponse(req, 202, envelope(true, {
        enrichment_job_id: enrichmentJobId,
        status: "queued",
        total: companyIds.length,
        mode, budget_eur: budgetEur,
        daily_remaining_eur: Number(dailyRemaining.toFixed(4)),
        providers_available: avail,
        poll_endpoint: "POST /b2b-finder-enrich { action: 'get_enrichment_progress', enrichment_job_id }",
      }, null, debug_id, warnings));
    }

    // ─── LEGACY (no action): minimal sync echo with providers_available ──────
    return jsonResponse(req, 400, envelope(false, null, "Use action: start_enrichment_job | get_enrichment_progress | cancel_enrichment_job", debug_id, [
      `providers_available:${Object.entries(avail).filter(([_,v])=>v).map(([k])=>k).join(",")}`,
    ]));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "internal error";
    console.error(`[b2b-finder-enrich] unhandled debug_id=${debug_id} err=${msg}`);
    return new Response(
      JSON.stringify({ ok: false, data: null, warnings: [], debug_id, error: "Internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
