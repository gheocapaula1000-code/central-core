import { makeDebugId, handleOptions, ok, fail, requireSecret, CORE_VERSION } from "../_shared/http.ts";
import { callOpenAI } from "./providers/openai.ts";
import { callAnthropic } from "./providers/anthropic.ts";
import { firecrawlExtract } from "./providers/firecrawl.ts";
import { recordCall, recordFallback, getMetrics } from "./metrics.ts";

import * as wyloniBandi from "./pipelines/wyloni_bandi.ts";
import * as keydraftRealestate from "./pipelines/keydraft_realestate.ts";
import * as praticaLegal from "./pipelines/pratica_legal.ts";
import * as wyloniBonus from "./pipelines/wyloni_bonus.ts";

// ═══════════════════════════════════════════════════════════════
// Rate limiter: caller-aware, tiered for trusted vs public
// ═══════════════════════════════════════════════════════════════
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_TRUSTED = 300;
const RATE_MAX_PUBLIC = 30;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

/** Sanitize first IP from x-forwarded-for or cf-connecting-ip */
function extractClientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    // Basic IP validation: must look like IPv4 or IPv6, no injection
    if (/^[\da-fA-F.:]+$/.test(first) && first.length <= 45) return first;
  }
  const cfIp = req.headers.get("cf-connecting-ip")?.trim();
  if (cfIp && /^[\da-fA-F.:]+$/.test(cfIp) && cfIp.length <= 45) return cfIp;
  return null;
}

/** Build a rate-limit bucket key based on trust level */
function buildCallerKey(
  sourceApp: string,
  req: Request,
  body: Record<string, unknown>,
  trusted: boolean,
): string {
  if (trusted) {
    // Trusted server-to-server: allow body.user_id / x-user-id as discriminator
    const userId = (body.user_id as string) || req.headers.get("x-user-id") || "";
    if (userId && /^[\w-]+$/.test(userId)) return `${sourceApp}:trusted:${userId}`;
    const origin = req.headers.get("origin")?.trim();
    if (origin) return `${sourceApp}:trusted:${origin}`;
    return `${sourceApp}:trusted:anonymous`;
  }
  // Public path: never trust body.user_id
  const ip = extractClientIp(req);
  if (ip) return `${sourceApp}:${ip}`;
  const origin = req.headers.get("origin")?.trim();
  if (origin) return `${sourceApp}:${origin}`;
  return `${sourceApp}:anonymous`;
}

function checkRateLimit(callerKey: string, maxRate: number): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const bucket = rateBuckets.get(callerKey);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(callerKey, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true, retryAfterSec: 0 };
  }
  if (bucket.count >= maxRate) {
    const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
    return { allowed: false, retryAfterSec };
  }
  bucket.count++;
  return { allowed: true, retryAfterSec: 0 };
}

// Lazy cleanup: purge expired buckets before each check
function purgeExpiredBuckets() {
  const now = Date.now();
  for (const [key, val] of rateBuckets) {
    if (now > val.resetAt) rateBuckets.delete(key);
  }
}

// ═══════════════════════════════════════════════════════════════
// Input sanitization
// ═══════════════════════════════════════════════════════════════
const SAFE_ID = /^[a-z0-9_]+$/;

// ═══════════════════════════════════════════════════════════════
// Pipeline config (from pipeline files)
// ═══════════════════════════════════════════════════════════════
const PIPELINES: Record<string, { maxTokens: number; temperature: number }> = {
  wyloni_bandi:        { maxTokens: wyloniBandi.MAX_TOKENS, temperature: wyloniBandi.TEMPERATURE },
  wyloni_bonus:        { maxTokens: wyloniBonus.MAX_TOKENS, temperature: wyloniBonus.TEMPERATURE },
  pratica_legal:       { maxTokens: praticaLegal.MAX_TOKENS, temperature: praticaLegal.TEMPERATURE },
  keydraft_realestate: { maxTokens: keydraftRealestate.MAX_TOKENS, temperature: keydraftRealestate.TEMPERATURE },
};
function getPipeline(domain: string) {
  return PIPELINES[domain] ?? PIPELINES["wyloni_bandi"];
}

const TASK_TOKEN_OVERRIDES: Record<string, number> = {
  feasibility_lab: 2000,
  alchemist: 1600,
  viral_content_bundle: 2500,
  ai_bandi: 2000,
  contratto_analisi: 2000,
  keydraft_engine: 2500,
};

// ═══════════════════════════════════════════════════════════════
// Web tasks & empty results (from pipeline files)
// ═══════════════════════════════════════════════════════════════
const WEB_TASKS = new Set([
  "search_grants", "deep_search", "find_contacts", "find_company_contacts", "ai_bandi",
]);

// Merge empty results from all pipeline files
const EMPTY_RESULTS: Record<string, string> = {
  ...wyloniBandi.EMPTY_RESULTS,
};

// Merge Perplexity system prompts from all pipeline files
const PERPLEXITY_SYSTEM: Record<string, string> = {
  ...wyloniBandi.PERPLEXITY_SYSTEMS,
};

// ═══════════════════════════════════════════════════════════════
// Perplexity with system prompts (web search tasks)
// ═══════════════════════════════════════════════════════════════
function withAbort(ms: number) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

async function callPerplexityWithSystem(prompt: string, task: string, domain: string, maxTokens: number): Promise<string | null> {
  const key = Deno.env.get("PERPLEXITY_API_KEY") ?? "";
  if (!key) { console.warn("[perplexity] PERPLEXITY_API_KEY not configured"); return null; }
  const system = PERPLEXITY_SYSTEM[task] ?? "Rispondi SOLO in JSON valido. MAI inventare dati.";
  const { signal, clear } = withAbort(30_000);
  const t = Date.now();
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        max_tokens: maxTokens,
        temperature: 0.0,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
        return_citations: true,
        search_recency_filter: "month",
      }),
      signal,
    });
    if (!res.ok) {
      const latencyMs = Date.now() - t;
      recordCall({ provider: "perplexity", task, domain, latencyMs, outputLen: 0, inputLen: prompt.length, maxTokens, success: false, error: `HTTP ${res.status}` });
      return null;
    }
    const data = await res.json();
    const output: string = data?.choices?.[0]?.message?.content ?? "";
    const latencyMs = Date.now() - t;
    const success = output.trim().length > 5;
    recordCall({ provider: "perplexity", task, domain, latencyMs, outputLen: output.length, inputLen: prompt.length, maxTokens, success });
    return success ? output : null;
  } catch (e) {
    const latencyMs = Date.now() - t;
    const error = e instanceof Error && e.name === "AbortError" ? "Timeout" : String(e).slice(0, 200);
    recordCall({ provider: "perplexity", task, domain, latencyMs, outputLen: 0, inputLen: prompt.length, maxTokens, success: false, error });
    return null;
  } finally { clear(); }
}

// ═══════════════════════════════════════════════════════════════
// AI orchestration (uses imported providers)
// ═══════════════════════════════════════════════════════════════
async function runAI(prompt: string, domain: string, task?: string): Promise<string> {
  const { maxTokens: baseTokens, temperature } = getPipeline(domain);
  const maxTokens = (task && TASK_TOKEN_OVERRIDES[task]) || baseTokens;
  const taskName = task || "generic";
  try {
    const result = await callOpenAI(prompt, temperature, maxTokens);
    recordCall({ provider: "openai", task: taskName, domain, latencyMs: result.latencyMs, outputLen: result.output.length, inputLen: prompt.length, maxTokens, success: true });
    return result.output;
  } catch (e1) {
    recordCall({ provider: "openai", task: taskName, domain, latencyMs: 0, outputLen: 0, inputLen: prompt.length, maxTokens, success: false, error: String(e1).slice(0, 200) });
    recordFallback();
    try {
      const result = await callAnthropic(prompt, temperature, maxTokens);
      recordCall({ provider: "anthropic", task: taskName, domain, latencyMs: result.latencyMs, outputLen: result.output.length, inputLen: prompt.length, maxTokens, success: true });
      return result.output;
    } catch (e2) {
      recordCall({ provider: "anthropic", task: taskName, domain, latencyMs: 0, outputLen: 0, inputLen: prompt.length, maxTokens, success: false, error: String(e2).slice(0, 200) });
      throw new Error(`All AI providers failed. OpenAI: ${String(e1).slice(0, 100)}. Anthropic: ${String(e2).slice(0, 100)}`);
    }
  }
}

async function runWebAI(prompt: string, domain: string, task: string): Promise<string> {
  const maxTokens = TASK_TOKEN_OVERRIDES[task] || getPipeline(domain).maxTokens;
  const output = await callPerplexityWithSystem(prompt, task, domain, maxTokens);
  if (output) return output;
  const empty = EMPTY_RESULTS[task] ?? `{"ok":false,"error":"Ricerca non disponibile"}`;
  console.warn(`[ai] Perplexity unavailable for task=${task} — returning empty`);
  return empty;
}

// ═══════════════════════════════════════════════════════════════
// Output parsing & filtering
// ═══════════════════════════════════════════════════════════════
function parseOutput(raw: string): unknown | null {
  if (!raw || raw.trim().length < 2) return null;
  const s = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(s); } catch (e) { console.debug("[parseOutput] direct parse failed:", String(e).slice(0, 80)); }
  const fb = s.indexOf("{"), lb = s.lastIndexOf("}");
  if (fb !== -1 && lb > fb) { try { return JSON.parse(s.slice(fb, lb + 1)); } catch (e) { console.debug("[parseOutput] braces parse failed:", String(e).slice(0, 80)); } }
  const fab = s.indexOf("["), lab = s.lastIndexOf("]");
  if (fab !== -1 && lab > fab) { try { return JSON.parse(s.slice(fab, lab + 1)); } catch (e) { console.debug("[parseOutput] brackets parse failed:", String(e).slice(0, 80)); } }
  return null;
}


// ═══════════════════════════════════════════════════════════════
// Main handler
// ═══════════════════════════════════════════════════════════════
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  const debugId = makeDebugId();
  const pathname = new URL(req.url).pathname;
  console.log(`[ai-core-run] method=${req.method} pathname=${pathname} debug_id=${debugId}`);

  try {
    // Health check — no auth required
    if (req.method === "GET" && (pathname.endsWith("/health") || pathname.endsWith("/__health") || pathname === "/")) {
      return ok(req, {
        status: "ok", version: CORE_VERSION, time: new Date().toISOString(),
      }, [], debugId);
    }

    // Metrics endpoint — public (no auth required)
    if (req.method === "GET" && pathname.endsWith("/metrics")) {
      return ok(req, getMetrics(), [], debugId);
    }

    // Diagnostics endpoint — public (no auth required)
    if (req.method === "GET" && pathname.endsWith("/diagnostics")) {

      const testPrompt = "Rispondi SOLO con la parola: PONG";
      const results: Record<string, { status: string; latencyMs: number; output?: string; error?: string }> = {};

      // Test OpenAI
      try {
        const t = Date.now();
        const r = await callOpenAI(testPrompt, 0.0, 50);
        results.openai = { status: "ok", latencyMs: r.latencyMs, output: r.output.trim().slice(0, 100) };
      } catch (e) {
        results.openai = { status: "error", latencyMs: 0, error: String(e).slice(0, 200) };
      }

      // Test Anthropic
      try {
        const t = Date.now();
        const r = await callAnthropic(testPrompt, 0.0, 50);
        results.anthropic = { status: "ok", latencyMs: r.latencyMs, output: r.output.trim().slice(0, 100) };
      } catch (e) {
        results.anthropic = { status: "error", latencyMs: 0, error: String(e).slice(0, 200) };
      }

      // Test Perplexity
      try {
        const t = Date.now();
        const out = await callPerplexityWithSystem("Rispondi SOLO: PONG", "diagnostics", "diagnostics", 50);
        if (out) {
          results.perplexity = { status: "ok", latencyMs: Date.now() - t, output: out.trim().slice(0, 100) };
        } else {
          results.perplexity = { status: "error", latencyMs: Date.now() - t, error: "No output or key not configured" };
        }
      } catch (e) {
        results.perplexity = { status: "error", latencyMs: 0, error: String(e).slice(0, 200) };
      }

      const allOk = Object.values(results).every((r) => r.status === "ok");
      return ok(req, {
        status: allOk ? "all_providers_ok" : "some_providers_failed",
        providers: results,
        time: new Date().toISOString(),
        debug_id: debugId,
      }, allOk ? [] : ["Some providers failed diagnostics"], debugId);
    }

    // Auth
    const authErr = requireSecret(req, debugId);
    if (authErr) return authErr;
    if (req.method !== "POST") return fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId);

    // ── Web Scrape (Firecrawl) ─────────────────────────────────
    if (pathname.endsWith("/web/scrape")) {
      const rawBody = await req.text();
      if (rawBody.length > 100_000) return fail(req, 413, "PAYLOAD_TOO_LARGE", "Request body exceeds 100KB", debugId);
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(rawBody); } catch {
        return fail(req, 400, "INVALID_JSON", "Body must be valid JSON", debugId);
      }
      const url = (body.url as string) ?? "";
      if (!url || !url.startsWith("http")) return fail(req, 400, "MISSING_URL", "Provide a valid url field", debugId);
      const format = (body.format as string) || "markdown";
      console.log(`[ai-core-run] web/scrape url=${url.slice(0, 100)} format=${format} debug_id=${debugId}`);
      const result = await firecrawlExtract(url);
      if (!result) {
        return ok(req, { success: false, content: null, error: "Scrape failed or returned empty" }, ["Firecrawl returned no content"], debugId);
      }
      return ok(req, {
        success: true,
        content: result.markdown,
        markdown: result.markdown,
        text: result.markdown,
        metadata: { title: result.title, sourceUrl: result.url, scrapedAt: new Date().toISOString(), context: (body.context as string) ?? null },
      }, [], debugId);
    }

    // Parse body first (needed for caller key construction)
    const rawBody = await req.text();
    if (rawBody.length > 100_000) {
      return fail(req, 413, "PAYLOAD_TOO_LARGE", "Request body exceeds 100KB limit", debugId);
    }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(rawBody); } catch {
      return fail(req, 400, "INVALID_JSON", "Body must be valid JSON", debugId);
    }

    // Rate limiting: caller-aware, trusted tier
    purgeExpiredBuckets();
    const sourceApp = req.headers.get("x-source-app") ?? "unknown";
    const trusted = true; // all POST traffic past requireSecret is trusted
    const callerKey = buildCallerKey(sourceApp, req, body, trusted);
    const rateResult = checkRateLimit(callerKey, RATE_MAX_TRUSTED);
    if (!rateResult.allowed) {
      console.warn(`[rate] caller=${callerKey} trusted=${trusted} route=${pathname} => 429`);
      const res = fail(req, 429, "RATE_LIMITED", `Too many requests. Retry in ${rateResult.retryAfterSec}s.`, debugId);
      res.headers.set("Retry-After", String(rateResult.retryAfterSec));
      return res;
    }

    // Parse body
    const rawBody = await req.text();
    if (rawBody.length > 100_000) {
      return fail(req, 413, "PAYLOAD_TOO_LARGE", "Request body exceeds 100KB limit", debugId);
    }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(rawBody); } catch {
      return fail(req, 400, "INVALID_JSON", "Body must be valid JSON", debugId);
    }

    // ── Tariffs compare ────────────────────────────────────────
    if (pathname.endsWith("/tariffs/compare")) {
      const prompt = (body.prompt as string) || (body.text as string) || "";
      if (!prompt) return fail(req, 400, "MISSING_PROMPT", "Provide prompt field", debugId);
      if (prompt.length > 15_000) return fail(req, 400, "PROMPT_TOO_LONG", "Prompt exceeds 15000 characters", debugId);
      console.log(`[ai-core-run] tariffs/compare debug_id=${debugId}`);
      const output = await runAI(prompt, "wyloni_bandi");
      const parsed = parseOutput(output) as Record<string, unknown> | null;
      return ok(req, { final_output: output, data: parsed, offers: parsed?.offers ?? [], debug_id: debugId }, [], debugId);
    }

    // ── Documents analyze ──────────────────────────────────────
    if (pathname.endsWith("/documents/analyze")) {
      const text = (body.text as string) ?? (body.pdf_text as string) ?? (body.prompt as string) ?? "";
      if (!text || text.trim().length < 20) {
        return ok(req, { status: "NOT_READABLE", extracted: {}, quality: { gate: "NOT_READABLE", score: 0, notes: ["No text"] } }, [], debugId);
      }
      const extractPrompt = `Estrai i dati dalla bolletta italiana e rispondi SOLO in JSON:\n{"periodo":{"from":"DD/MM/YYYY","to":"DD/MM/YYYY"},"fornitore":{"label":"nome fornitore"},"consumi":{"totale_kwh":null,"unit":"kWh"},"importi":{"totale_da_pagare_eur":null,"bonus_sociale":{"presente":false,"eur":null}}}\n\nBolletta:\n${text.slice(0, 8000)}`;
      let extracted: unknown = {};
      try { const out = await runAI(extractPrompt, "wyloni_bandi"); extracted = parseOutput(out) ?? {}; } catch (e) { console.warn("[documents/analyze] extraction failed:", String(e).slice(0, 150)); }
      return ok(req, { status: "READY", extracted, quality: { gate: "READY", score: 80, notes: ["estrazione automatica"] } }, [], debugId);
    }

    // ── Generic AI run ─────────────────────────────────────────
    const domain = (body.domain as string) || "wyloni_bandi";
    const task   = (body.task   as string) || "";
    const prompt = (body.prompt as string) || (body.text as string) || "";

    // Input sanitization
    if (domain && !SAFE_ID.test(domain)) return fail(req, 400, "INVALID_DOMAIN", "domain must match [a-z0-9_]", debugId);
    if (task && !SAFE_ID.test(task)) return fail(req, 400, "INVALID_TASK", "task must match [a-z0-9_]", debugId);

    // ── KeyDraft Engine: photo analysis + listing generation ──
    if (task === "keydraft_engine") {
      const input = body.input as Record<string, unknown> | undefined;
      if (!input) return fail(req, 400, "MISSING_INPUT", "Provide input object for keydraft_engine", debugId);

      const imageUrls = (input.imageUrls as string[]) ?? [];
      if (imageUrls.length === 0) return fail(req, 400, "NO_IMAGES", "Provide at least one imageUrl", debugId);

      const op = (input.operation as string) || "vendita";
      const price = input.price as number | null;
      const province = (input.province as string) || "";
      const comune = (input.comune as string) || "";
      const locality = (input.locality as string) || "";
      const enableReno = (input.enableRenovationEstimate as boolean) ?? false;

      const imageList = imageUrls.map((u, i) => `Foto ${i + 1}: ${u}`).join("\n");

      const enginePrompt = `Sei un esperto immobiliare italiano. Analizza le foto dell'immobile e genera un annuncio professionale.

DATI IMMOBILE:
- Operazione: ${op}
- Prezzo: ${price ? `€${price.toLocaleString("it-IT")}` : "Non specificato"}
- Posizione: ${comune}${province ? ` (${province})` : ""}${locality ? `, zona ${locality}` : ""}
${enableReno ? "- Includi stima lavori di ristrutturazione se necessari" : ""}

FOTO DA ANALIZZARE:
${imageList}

ISTRUZIONI:
1. Analizza ogni foto e identifica: stanze, finiture, stato conservazione, punti di forza
2. Genera un annuncio completo in italiano per portali immobiliari
3. Rispondi SOLO in JSON valido con questo schema:
{
  "title": "titolo annuncio max 80 caratteri",
  "description": "descrizione dettagliata 150-300 parole",
  "highlights": ["punto di forza 1", "punto di forza 2", ...],
  "rooms": { "identified": ["cucina", "bagno", ...], "count": numero },
  "condition": { "value": "buono|ottimo|da_ristrutturare|nuovo", "notes": "dettagli" },
  "features": { "flooring": "tipo pavimento", "fixtures": "stato infissi", "bathroom": { "hasShower": bool, "hasBathtub": bool }, "kitchen": "tipo cucina", "balcony": bool, "terrace": bool, "garage": bool, "garden": bool },
  "sqm_estimate": numero_stima,
  "renovation_estimate_eur": numero_o_null,
  "tags": ["tag1", "tag2", ...],
  "photo_analysis": [{ "photo_index": 1, "room": "tipo stanza", "notes": "osservazioni" }]
}`;

      console.log(`[ai-core-run] keydraft_engine photos=${imageUrls.length} comune=${comune} debug_id=${debugId}`);

      const output = await runAI(enginePrompt, "keydraft_realestate", "keydraft_engine");
      const parsed = parseOutput(output);

      return ok(req, {
        final_output: output,
        data: parsed,
        debug_id: debugId,
      }, [], debugId);
    }

    if (!prompt) return fail(req, 400, "MISSING_PROMPT", "Provide prompt field", debugId);
    if (prompt.length > 15_000) return fail(req, 400, "PROMPT_TOO_LONG", `Prompt exceeds 15000 characters`, debugId);

    console.log(`[ai-core-run] domain=${domain} task=${task} prompt_len=${prompt.length} source_app=${sourceApp} debug_id=${debugId}`);

    const output = WEB_TASKS.has(task)
      ? await runWebAI(prompt, domain, task)
      : await runAI(prompt, domain, task);

    const parsed = parseOutput(output);

    const raw = parsed as Record<string, unknown> | null;
    console.log(`[ai-core-run] output_len=${output.length}`);

    return ok(req, {
      final_output: output,
      data: parsed,
      offers:     raw?.offers     ?? [],
      properties: raw?.properties ?? [],
      results:    raw?.results    ?? [],
      debug_id: debugId,
    }, [], debugId);

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[ai-core-run] Error debug_id=${debugId}:`, errMsg);
    return fail(req, 500, "INTERNAL_ERROR", "An internal error occurred. Reference: " + debugId, debugId);
  }
});
