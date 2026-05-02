// v3.4.0
// health check endpoint — Central Core V3
// Public — no auth required. Minimal response, no version leak.
// Optional ?check_apis=true performs passive liveness checks of critical API keys.

import { handleOptions, ok, CORE_CONTRACT, addIdentityHeaders, buildManifest } from "../_shared/http.ts";

const FUNCTION_NAME = "health";
const EXPECTED_BASE_PATH = "/functions/v1/health";

// ─── API key liveness probes ──────────────────────────────────
async function checkOpenAI(): Promise<boolean> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return false;
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { "Authorization": `Bearer ${key}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function checkPerplexity(): Promise<boolean> {
  const key = Deno.env.get("PERPLEXITY_API_KEY");
  if (!key) return false;
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
    });
    // 400 = key valid, request malformed → still proves auth
    return res.ok || res.status === 400;
  } catch {
    return false;
  }
}

async function checkFirecrawl(): Promise<boolean> {
  const key = Deno.env.get("FIRECRAWL_API_KEY");
  if (!key) return false;
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    // 429 = rate limited but key is valid
    return res.ok || res.status === 400 || res.status === 429;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  const url = new URL(req.url);
  const pathname = url.pathname;

  // Manifest endpoint
  if (req.method === "GET" && pathname.endsWith("/manifest")) {
    const manifest = buildManifest({
      functionName: FUNCTION_NAME,
      serviceKind: "global-health-probe",
      expectedBasePath: EXPECTED_BASE_PATH,
      routes: ["GET /", "GET /manifest", "GET /?check_apis=true"],
      callingMode: "direct",
    });
    const res = ok(req, manifest);
    return addIdentityHeaders(res, { function: FUNCTION_NAME, route: "manifest" });
  }

  const checkApis = url.searchParams.get("check_apis") === "true";
  let apiStatus: Record<string, "ok" | "error"> | undefined;

  if (checkApis) {
    const [openai, perplexity, firecrawl] = await Promise.all([
      checkOpenAI(),
      checkPerplexity(),
      checkFirecrawl(),
    ]);
    apiStatus = {
      openai: openai ? "ok" : "error",
      perplexity: perplexity ? "ok" : "error",
      firecrawl: firecrawl ? "ok" : "error",
      // Mapbox / Google Maps non hanno un ping economico: controlliamo solo presenza
      mapbox: Deno.env.get("MAPBOX_API_KEY") ? "ok" : "error",
      google_maps: Deno.env.get("GOOGLE_MAPS_API_KEY") ? "ok" : "error",
    };
  }

  const res = ok(req, {
    status: "healthy",
    contract: CORE_CONTRACT,
    function: FUNCTION_NAME,
    ...(apiStatus ? { api_status: apiStatus } : {}),
  });
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route: "health" });
});
