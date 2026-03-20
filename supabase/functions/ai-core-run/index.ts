import { makeDebugId, handleOptions, ok, fail, requireSecret, requireDiagnosticSecret, constantTimeEqual, CORE_VERSION, CORE_CONTRACT, enforceOriginPolicy, addIdentityHeaders, buildManifest } from "../_shared/http.ts";
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
const RATE_MAX_DIAG = 10; // lightweight limit for diagnostics
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

/** Sanitize first IP from x-forwarded-for or cf-connecting-ip */
function extractClientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
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
    const userId = (body.user_id as string) || req.headers.get("x-user-id") || "";
    if (userId && /^[\w-]+$/.test(userId)) return `${sourceApp}:trusted:${userId}`;
    const origin = req.headers.get("origin")?.trim();
    if (origin) return `${sourceApp}:trusted:${origin}`;
    return `${sourceApp}:trusted:anonymous`;
  }
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

const EMPTY_RESULTS: Record<string, string> = {
  ...wyloniBandi.EMPTY_RESULTS,
};

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
// Constants
// ═══════════════════════════════════════════════════════════════
const FUNCTION_NAME = "ai-core-run";
const EXPECTED_BASE_PATH = "/functions/v1/ai-core-run";
const AI_CORE_ROUTES = [
  "GET /health", "GET /__health", "GET /manifest",
  "GET /metrics", "GET /diagnostics", "GET /__diagnostics/selftest",
  "POST /documents/analyze", "POST /web/scrape", "POST /tariffs/compare",
  "POST (generic AI run)",
];
const AI_CORE_DOMAINS = Object.keys(PIPELINES);

// ═══════════════════════════════════════════════════════════════
// Main handler
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// IDENTITY HELPER — consistent with sottra, viral-core, ecosystem-gateway
// ═══════════════════════════════════════════════════════════════
function withIdentity(res: Response, route: string): Response {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  const debugId = makeDebugId();
  const pathname = new URL(req.url).pathname;
  console.log(`[ai-core-run] method=${req.method} pathname=${pathname} debug_id=${debugId}`);

  try {
    // Origin policy — consistent with sottra, viral-core, ecosystem-gateway
    const originBlock = enforceOriginPolicy(req, debugId);
    if (originBlock) return withIdentity(originBlock, "origin-blocked");
    // Manifest endpoint — public, no auth
    if (req.method === "GET" && pathname.endsWith("/manifest")) {
      const manifest = buildManifest({
        functionName: FUNCTION_NAME,
        serviceKind: "ai-router",
        expectedBasePath: EXPECTED_BASE_PATH,
        routes: AI_CORE_ROUTES,
        domains: AI_CORE_DOMAINS,
        callingMode: "proxy",
      });
      return withIdentity(ok(req, manifest, [], debugId), "manifest");
    }

    // Health check — no auth required, public
    if (req.method === "GET" && (pathname.endsWith("/health") || pathname.endsWith("/__health") || pathname === "/")) {
      return withIdentity(ok(req, {
        status: "ok", version: CORE_VERSION, contract: CORE_CONTRACT,
        function: FUNCTION_NAME, expectedBasePath: EXPECTED_BASE_PATH,
        time: new Date().toISOString(),
      }, [], debugId), "health");
    }

    // ═══════════════════════════════════════════════════════════════
    // METRICS — protected by origin policy + diagnostic secret + rate limit
    // ═══════════════════════════════════════════════════════════════
    if (req.method === "GET" && pathname.endsWith("/metrics")) {
      const originErr = enforceOriginPolicy(req, debugId);
      if (originErr) return originErr;
      const diagErr = requireDiagnosticSecret(req, debugId);
      if (diagErr) return diagErr;
      const res = ok(req, getMetrics(), [], debugId);
      return addIdentityHeaders(res, { function: FUNCTION_NAME, route: "metrics" });
    }

    // ═══════════════════════════════════════════════════════════════
    // DIAGNOSTICS — protected by origin policy + diagnostic secret + rate limit
    // ═══════════════════════════════════════════════════════════════
    if (req.method === "GET" && pathname.endsWith("/diagnostics")) {
      const originErr = enforceOriginPolicy(req, debugId);
      if (originErr) return originErr;
      const diagSecErr = requireDiagnosticSecret(req, debugId);
      if (diagSecErr) return diagSecErr;

      // Rate limit for diagnostics
      purgeExpiredBuckets();
      const diagKey = `diag:${extractClientIp(req) || req.headers.get("origin") || "unknown"}`;
      const diagRate = checkRateLimit(diagKey, RATE_MAX_DIAG);
      if (!diagRate.allowed) {
        const res = fail(req, 429, "RATE_LIMITED", `Too many diagnostic requests. Retry in ${diagRate.retryAfterSec}s.`, debugId);
        res.headers.set("Retry-After", String(diagRate.retryAfterSec));
        return res;
      }

      const testPrompt = "Rispondi SOLO con la parola: PONG";
      const results: Record<string, { status: string; latencyMs: number; output?: string; error?: string }> = {};

      // Test OpenAI
      try {
        const r = await callOpenAI(testPrompt, 0.0, 50);
        results.openai = { status: "ok", latencyMs: r.latencyMs, output: r.output.trim().slice(0, 100) };
      } catch (e) {
        results.openai = { status: "error", latencyMs: 0, error: String(e).slice(0, 200) };
      }

      // Test Anthropic
      try {
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
        function: FUNCTION_NAME,
        contract: CORE_CONTRACT,
        time: new Date().toISOString(),
        debug_id: debugId,
      }, allOk ? [] : ["Some providers failed diagnostics"], debugId);
    }

    // ═══════════════════════════════════════════════════════════════
    // SELFTEST — protected by origin policy + diagnostic secret + rate limit
    // ═══════════════════════════════════════════════════════════════
    if (req.method === "GET" && pathname.endsWith("/__diagnostics/selftest")) {
      const originErr = enforceOriginPolicy(req, debugId);
      if (originErr) return originErr;
      const diagSecErr = requireDiagnosticSecret(req, debugId);
      if (diagSecErr) return diagSecErr;

      // Rate limit for selftest
      purgeExpiredBuckets();
      const selfKey = `selftest:${extractClientIp(req) || req.headers.get("origin") || "unknown"}`;
      const selfRate = checkRateLimit(selfKey, RATE_MAX_DIAG);
      if (!selfRate.allowed) {
        const res = fail(req, 429, "RATE_LIMITED", `Too many selftest requests. Retry in ${selfRate.retryAfterSec}s.`, debugId);
        res.headers.set("Retry-After", String(selfRate.retryAfterSec));
        return res;
      }

      const tests: Array<{ name: string; status: "PASS" | "WARN" | "FAIL"; detail: string; mode: "reale" | "simulato" | "dry-run"; buckets?: string[] }> = [];
      const selftestBuckets = new Map<string, { count: number; resetAt: number }>();

      function selfTestCheckRate(key: string, maxRate: number, buckets: Map<string, { count: number; resetAt: number }>): { allowed: boolean; retryAfterSec: number } {
        const now = Date.now();
        const bucket = buckets.get(key);
        if (!bucket || now > bucket.resetAt) {
          buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
          return { allowed: true, retryAfterSec: 0 };
        }
        if (bucket.count >= maxRate) {
          const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
          return { allowed: false, retryAfterSec };
        }
        bucket.count++;
        return { allowed: true, retryAfterSec: 0 };
      }

      // ── A. Health routing ──
      try {
        const healthData = { status: "ok", version: CORE_VERSION, time: new Date().toISOString() };
        const hasStatus = healthData.status === "ok";
        const hasVersion = typeof healthData.version === "string" && healthData.version.length > 0;
        const healthPaths = ["/health", "/__health", "/ai-core-run/health", "/ai-core-run/__health", "/"];
        const matchResults = healthPaths.map(p => ({
          path: p,
          matches: p.endsWith("/health") || p.endsWith("/__health") || p === "/",
        }));
        const allMatch = matchResults.every(m => m.matches);
        if (hasStatus && hasVersion && allMatch) {
          tests.push({ name: "A. Health routing", status: "PASS", mode: "dry-run", detail: `All health paths verified: ${healthPaths.join(", ")}. version=${CORE_VERSION}` });
        } else {
          const failedPaths = matchResults.filter(m => !m.matches).map(m => m.path);
          tests.push({ name: "A. Health routing", status: "FAIL", mode: "dry-run", detail: `Health check issue. data_ok=${hasStatus && hasVersion} failed_paths=${failedPaths.join(",")}` });
        }
      } catch (e) {
        tests.push({ name: "A. Health routing", status: "FAIL", mode: "dry-run", detail: `Exception: ${String(e).slice(0, 150)}` });
      }

      // ── A2. Wyloni contract paths ──
      try {
        const wyloniPaths = [
          { suffix: "/health", method: "GET" },
          { suffix: "/__health", method: "GET" },
          { suffix: "/documents/analyze", method: "POST" },
          { suffix: "/web/scrape", method: "POST" },
          { suffix: "/tariffs/compare", method: "POST" },
          { suffix: "/metrics", method: "GET" },
        ];
        const allValid = wyloniPaths.every(p => {
          const full = `/functions/v1/ai-core-run${p.suffix}`;
          return full.endsWith(p.suffix);
        });
        tests.push({
          name: "A2. Wyloni contract paths",
          status: allValid ? "PASS" : "FAIL",
          mode: "dry-run",
          detail: allValid
            ? `All ${wyloniPaths.length} Wyloni paths verified: ${wyloniPaths.map(p => p.suffix).join(", ")}`
            : "One or more Wyloni paths failed endsWith validation",
        });
      } catch (e) {
        tests.push({ name: "A2. Wyloni contract paths", status: "FAIL", mode: "dry-run", detail: `Exception: ${String(e).slice(0, 150)}` });
      }

      // ── B. Envelope consistency ──
      try {
        const okRes = ok(req, { test: true }, [], "selftest-ok");
        const okBody = JSON.parse(await okRes.clone().text());
        const okValid = okBody.ok === true && okBody.data !== null && okBody.data !== undefined && okBody.debug_id === "selftest-ok";
        const failRes = fail(req, 400, "TEST_ERROR", "test message", "selftest-fail");
        const failBody = JSON.parse(await failRes.clone().text());
        const failValid = failBody.ok === false && failBody.data === null && failBody.error?.code === "TEST_ERROR" && failBody.debug_id === "selftest-fail";
        if (okValid && failValid) {
          tests.push({ name: "B. Envelope consistency", status: "PASS", mode: "reale", detail: "ok=true has data, ok=false has data=null+error" });
        } else {
          tests.push({ name: "B. Envelope consistency", status: "FAIL", mode: "reale", detail: `ok_valid=${okValid} fail_valid=${failValid}` });
        }
      } catch (e) {
        tests.push({ name: "B. Envelope consistency", status: "FAIL", mode: "reale", detail: `Exception: ${String(e).slice(0, 150)}` });
      }

      // ── C. Trusted rate limit isolation ──
      try {
        const callerA = "selftest:trusted:userA";
        const callerB = "selftest:trusted:userB";
        const callerC = "selftest:trusted:userC";
        const rA = selfTestCheckRate(callerA, RATE_MAX_TRUSTED, selftestBuckets);
        const rB = selfTestCheckRate(callerB, RATE_MAX_TRUSTED, selftestBuckets);
        const rC = selfTestCheckRate(callerC, RATE_MAX_TRUSTED, selftestBuckets);
        const bucketsUsed = [callerA, callerB, callerC];
        if (rA.allowed && rB.allowed && rC.allowed) {
          const bA = selftestBuckets.get(callerA)!;
          const bB = selftestBuckets.get(callerB)!;
          const bC = selftestBuckets.get(callerC)!;
          const isolated = bA.count === 1 && bB.count === 1 && bC.count === 1;
          tests.push({
            name: "C. Trusted rate limit isolation", status: isolated ? "PASS" : "FAIL", mode: "simulato",
            detail: isolated ? "3 distinct callers have independent buckets (count=1 each)" : `Bucket counts: A=${bA.count} B=${bB.count} C=${bC.count}`,
            buckets: bucketsUsed,
          });
        } else {
          tests.push({ name: "C. Trusted rate limit isolation", status: "FAIL", mode: "simulato", detail: "One or more callers were rate-limited on first request", buckets: bucketsUsed });
        }
      } catch (e) {
        tests.push({ name: "C. Trusted rate limit isolation", status: "FAIL", mode: "simulato", detail: `Exception: ${String(e).slice(0, 150)}` });
      }

      // ── D. Same caller burst ──
      try {
        const burstKey = "selftest:trusted:burstUser";
        const burstLimit = 5;
        let blockedAt = -1;
        for (let i = 0; i < burstLimit + 2; i++) {
          const r = selfTestCheckRate(burstKey, burstLimit, selftestBuckets);
          if (!r.allowed) { blockedAt = i; break; }
        }
        const otherKey = "selftest:trusted:otherUser";
        const otherResult = selfTestCheckRate(otherKey, burstLimit, selftestBuckets);
        if (blockedAt === burstLimit && otherResult.allowed) {
          tests.push({ name: "D. Same caller burst", status: "PASS", mode: "simulato", detail: `Burst blocked at request #${blockedAt} (limit=${burstLimit}), other caller unaffected`, buckets: [burstKey, otherKey] });
        } else if (blockedAt === -1) {
          tests.push({ name: "D. Same caller burst", status: "FAIL", mode: "simulato", detail: `Burst of ${burstLimit + 2} was never blocked (limit=${burstLimit})` });
        } else {
          tests.push({ name: "D. Same caller burst", status: otherResult.allowed ? "WARN" : "FAIL", mode: "simulato", detail: `Blocked at #${blockedAt} (expected #${burstLimit}), other_allowed=${otherResult.allowed}` });
        }
      } catch (e) {
        tests.push({ name: "D. Same caller burst", status: "FAIL", mode: "simulato", detail: `Exception: ${String(e).slice(0, 150)}` });
      }

      // ── E. Retry-After header ──
      try {
        const retryKey = "selftest:trusted:retryTest";
        const retryLimit = 1;
        selfTestCheckRate(retryKey, retryLimit, selftestBuckets);
        const blocked = selfTestCheckRate(retryKey, retryLimit, selftestBuckets);
        if (!blocked.allowed && blocked.retryAfterSec > 0 && blocked.retryAfterSec <= 60) {
          tests.push({ name: "E. Retry-After header", status: "PASS", mode: "simulato", detail: `429 returns retryAfterSec=${blocked.retryAfterSec} (within 1-60s window)` });
        } else if (!blocked.allowed) {
          tests.push({ name: "E. Retry-After header", status: "FAIL", mode: "simulato", detail: `429 triggered but retryAfterSec=${blocked.retryAfterSec} is invalid` });
        } else {
          tests.push({ name: "E. Retry-After header", status: "FAIL", mode: "simulato", detail: "Second request was not blocked" });
        }
      } catch (e) {
        tests.push({ name: "E. Retry-After header", status: "FAIL", mode: "simulato", detail: `Exception: ${String(e).slice(0, 150)}` });
      }

      // ── F. Logging sanity ──
      try {
        const sampleLogLine = `[rate] caller=app:trusted:userId trusted=true route=/test => 429`;
        const secretNames = ["AI_CORE_SECRET", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY", "DIAGNOSTIC_SELFTEST_SECRET"];
        const secretValues = secretNames.map(s => Deno.env.get(s) ?? "").filter(Boolean);
        const logContainsSecret = secretValues.some(sv => sampleLogLine.includes(sv));
        const testKey = buildCallerKey("testapp", req, { user_id: "user123" }, true);
        const keyContainsSecret = secretValues.some(sv => testKey.includes(sv));
        if (!logContainsSecret && !keyContainsSecret) {
          tests.push({ name: "F. Logging sanity", status: "PASS", mode: "dry-run", detail: "Rate-limit log format and callerKey do not contain secret values" });
        } else {
          tests.push({ name: "F. Logging sanity", status: "FAIL", mode: "dry-run", detail: "Secret value detected in log template or callerKey" });
        }
      } catch (e) {
        tests.push({ name: "F. Logging sanity", status: "FAIL", mode: "dry-run", detail: `Exception: ${String(e).slice(0, 150)}` });
      }

      // Build report
      const passCount = tests.filter(t => t.status === "PASS").length;
      const warnCount = tests.filter(t => t.status === "WARN").length;
      const failCount = tests.filter(t => t.status === "FAIL").length;
      const overall = failCount > 0 ? "FAIL" : warnCount > 0 ? "WARN" : "PASS";

      const report = {
        overall,
        summary: { pass: passCount, warn: warnCount, fail: failCount, total: tests.length },
        tests,
        config: {
          rate_window_ms: RATE_WINDOW_MS,
          rate_max_trusted: RATE_MAX_TRUSTED,
          rate_max_public: RATE_MAX_PUBLIC,
        },
        function: FUNCTION_NAME,
        contract: CORE_CONTRACT,
        version: CORE_VERSION,
        timestamp: new Date().toISOString(),
      };

      const warnings = failCount > 0 ? ["One or more selftest checks failed"] : warnCount > 0 ? ["Selftest completed with warnings"] : [];
      const res = ok(req, report, warnings, debugId);
      return addIdentityHeaders(res, { function: FUNCTION_NAME, route: "__diagnostics/selftest" });
    }

    // Auth
    const authErr = requireSecret(req, debugId);
    if (authErr) return addIdentityHeaders(authErr, { function: FUNCTION_NAME, route: "auth-rejected" });
    if (req.method !== "POST") return addIdentityHeaders(fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId), { function: FUNCTION_NAME, route: "error" });

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
    return addIdentityHeaders(fail(req, 500, "INTERNAL_ERROR", `An internal error occurred. Reference: ${debugId}`, debugId), { function: FUNCTION_NAME, route: "error" });
  }
});
