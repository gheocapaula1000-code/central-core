// ═══════════════════════════════════════════════════════════════
// Viral Core — Edge Function (Central Core V3)
// Private content generation engine for Viral Lab.
// Accessed only via core-proxy. No direct PWA coupling.
// ═══════════════════════════════════════════════════════════════

import {
  makeDebugId,
  handleOptions,
  ok,
  fail,
  requireSecret,
  CORE_VERSION,
  CORE_CONTRACT,
  addIdentityHeaders,
  buildManifest,
  enforceOriginPolicy,
} from "../_shared/http.ts";

import type {
  GenerateBundleRequest,
  GenerateSingleRequest,
  PolicyCheckRequest,
  BuildMediaBriefRequest,
  Platform,
} from "./types.ts";

import { runPolicyCheck, buildNormalizedSuggestions } from "./policy.ts";
import { generateBundle, generateSingleContent, generateVideoScript, generateGoogleAdsPack, buildMediaBrief } from "./generator.ts";

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════
const FUNCTION_NAME = "viral-core";
const EXPECTED_BASE_PATH = "/functions/v1/viral-core";
const MAX_BODY_BYTES = 500_000;
const VALID_PLATFORMS = new Set<string>(["tiktok", "instagram", "facebook", "linkedin"]);
const VALID_FORMATS = new Set<string>(["post", "reel"]);

const ALL_ROUTES = [
  "GET /",
  "GET /health",
  "GET /__health",
  "GET /manifest",
  "GET /capabilities",
  "POST /generate-bundle",
  "POST /generate-single",
  "POST /policy-check",
  "POST /build-media-brief",
];

// ═══════════════════════════════════════════════════════════════
// IDENTITY HELPER
// ═══════════════════════════════════════════════════════════════
function withIdentity(res: Response, route: string): Response {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

// ═══════════════════════════════════════════════════════════════
// GET HANDLERS
// ═══════════════════════════════════════════════════════════════

function handleHealth(req: Request, debugId: string): Response {
  return withIdentity(
    ok(req, {
      status: "healthy",
      function: FUNCTION_NAME,
      version: CORE_VERSION,
      contract: CORE_CONTRACT,
      expectedBasePath: EXPECTED_BASE_PATH,
      time: new Date().toISOString(),
    }, [], debugId),
    "health",
  );
}

function handleManifest(req: Request, debugId: string): Response {
  const manifest = buildManifest({
    functionName: FUNCTION_NAME,
    serviceKind: "viral-content-engine",
    expectedBasePath: EXPECTED_BASE_PATH,
    routes: ALL_ROUTES,
    callingMode: "proxy",
  });
  return withIdentity(ok(req, manifest, [], debugId), "manifest");
}

function handleCapabilities(req: Request, debugId: string): Response {
  return withIdentity(
    ok(req, {
      status: "ok",
      function: FUNCTION_NAME,
      version: CORE_VERSION,
      modules: [
        {
          id: "generate-bundle",
          enabled: true,
          description: "Multi-platform content bundle (TikTok, Instagram, Facebook, LinkedIn)",
          requiresPwaChanges: false,
          hardDependencies: [],
          bestEffortDependencies: ["openai"],
        },
        {
          id: "generate-single",
          enabled: true,
          description: "Single-platform content generation",
          requiresPwaChanges: false,
          hardDependencies: [],
          bestEffortDependencies: ["openai"],
        },
        {
          id: "policy-check",
          enabled: true,
          description: "Deterministic anti-ban / anti-spam policy check",
          requiresPwaChanges: false,
          hardDependencies: [],
          bestEffortDependencies: [],
        },
        {
          id: "build-media-brief",
          enabled: true,
          description: "Media brief builder for downstream image generation",
          requiresPwaChanges: false,
          hardDependencies: [],
          bestEffortDependencies: [],
        },
      ],
      nonGoals: [
        "no social media publishing",
        "no social login or automation",
        "no scraping",
        "no browser automation",
        "no direct PWA coupling",
      ],
    }, [], debugId),
    "capabilities",
  );
}

// ═══════════════════════════════════════════════════════════════
// POST HANDLERS
// ═══════════════════════════════════════════════════════════════

async function handleGenerateBundle(req: Request, body: GenerateBundleRequest, debugId: string): Promise<Response> {
  if (!body.argomento || typeof body.argomento !== "string" || !body.argomento.trim()) {
    return withIdentity(fail(req, 400, "MISSING_ARGOMENTO", "argomento (string) is required", debugId), "generate-bundle");
  }

  const formato = VALID_FORMATS.has(body.formato ?? "") ? (body.formato as "post" | "reel") : "post";
  const warnings: string[] = [];

  // Generate bundle
  const bundle = await generateBundle(
    body.argomento.trim(),
    body.obiettivo,
    body.tono,
    formato,
    body.brandProfile,
    body.historyHints,
  );
  warnings.push(...bundle.warnings);

  // Optional: video script
  let videoScript15s: string | null = null;
  if (body.options?.includeVideoScript15s) {
    const vs = await generateVideoScript(body.argomento, body.tono, body.brandProfile);
    videoScript15s = vs.script;
    warnings.push(...vs.warnings);
  }

  // Optional: Google Ads pack
  let googleAdsPack: Record<string, unknown> | null = null;
  if (body.options?.includeGoogleAdsPack) {
    const ga = await generateGoogleAdsPack(body.argomento, body.obiettivo, body.brandProfile);
    googleAdsPack = ga.pack;
    warnings.push(...ga.warnings);
  }

  // Policy check (always included when requested, or by default)
  const policy = body.options?.includePolicyCheck !== false
    ? runPolicyCheck(bundle.contents, body.historyHints)
    : { riskLevel: "low" as const, publishModeRecommendation: "eligible_manual_publish" as const, riskFlags: [], notes: [] };

  const data = {
    contents: bundle.contents,
    mediaSuggestions: bundle.mediaSuggestions,
    videoScript15s,
    googleAdsPack,
    policy,
  };

  return withIdentity(ok(req, data, warnings, debugId), "generate-bundle");
}

async function handleGenerateSingle(req: Request, body: GenerateSingleRequest, debugId: string): Promise<Response> {
  if (!body.argomento || typeof body.argomento !== "string" || !body.argomento.trim()) {
    return withIdentity(fail(req, 400, "MISSING_ARGOMENTO", "argomento (string) is required", debugId), "generate-single");
  }
  if (!body.platform || !VALID_PLATFORMS.has(body.platform)) {
    return withIdentity(fail(req, 400, "INVALID_PLATFORM", `platform must be one of: ${[...VALID_PLATFORMS].join(", ")}`, debugId), "generate-single");
  }

  const formato = VALID_FORMATS.has(body.formato ?? "") ? (body.formato as "post" | "reel") : "post";

  const result = await generateSingleContent({
    platform: body.platform as Platform,
    argomento: body.argomento.trim(),
    obiettivo: body.obiettivo,
    tono: body.tono,
    formato,
    brandProfile: body.brandProfile,
    historyHints: body.historyHints,
  });

  // Quick policy on single content
  const policy = runPolicyCheck(
    { [body.platform]: result.content } as Partial<Record<Platform, string>>,
    body.historyHints,
  );

  const data = {
    content: result.content,
    mediaSuggestion: result.mediaSuggestion,
    policy: {
      riskLevel: policy.riskLevel,
      publishModeRecommendation: policy.publishModeRecommendation,
      riskFlags: policy.riskFlags,
    },
  };

  return withIdentity(ok(req, data, result.warnings, debugId), "generate-single");
}

function handlePolicyCheck(req: Request, body: PolicyCheckRequest, debugId: string): Response {
  if (!body.contents || typeof body.contents !== "object" || Object.keys(body.contents).length === 0) {
    return withIdentity(fail(req, 400, "MISSING_CONTENTS", "contents object with at least one platform is required", debugId), "policy-check");
  }

  // Validate platform keys
  const invalidPlatforms = Object.keys(body.contents).filter(k => !VALID_PLATFORMS.has(k));
  if (invalidPlatforms.length > 0) {
    return withIdentity(fail(req, 400, "INVALID_PLATFORM", `Invalid platforms: ${invalidPlatforms.join(", ")}`, debugId), "policy-check");
  }

  const policy = runPolicyCheck(body.contents, body.historyHints, body.scheduleHints);
  const normalizedSuggestions = policy.riskLevel !== "low"
    ? buildNormalizedSuggestions(body.contents)
    : {};

  const data = {
    riskLevel: policy.riskLevel,
    publishModeRecommendation: policy.publishModeRecommendation,
    riskFlags: policy.riskFlags,
    normalizedSuggestions,
    notes: policy.notes,
  };

  return withIdentity(ok(req, data, [], debugId), "policy-check");
}

function handleBuildMediaBrief(req: Request, body: BuildMediaBriefRequest, debugId: string): Response {
  if (!body.content || typeof body.content !== "string" || !body.content.trim()) {
    return withIdentity(fail(req, 400, "MISSING_CONTENT", "content (string) is required", debugId), "build-media-brief");
  }
  if (!body.platform || !VALID_PLATFORMS.has(body.platform)) {
    return withIdentity(fail(req, 400, "INVALID_PLATFORM", `platform must be one of: ${[...VALID_PLATFORMS].join(", ")}`, debugId), "build-media-brief");
  }

  const formato = VALID_FORMATS.has(body.formato ?? "") ? (body.formato as "post" | "reel") : "post";

  const brief = buildMediaBrief(
    body.platform as Platform,
    body.content,
    body.mediaSuggestion,
    formato,
    body.brandProfile,
  );

  // Quick policy on the content
  const policy = runPolicyCheck(
    { [body.platform]: body.content } as Partial<Record<Platform, string>>,
  );

  const data = {
    mediaBrief: brief,
    policy: {
      riskLevel: policy.riskLevel,
      notes: policy.notes,
    },
  };

  return withIdentity(ok(req, data, [], debugId), "build-media-brief");
}

// ═══════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  const debugId = makeDebugId();
  const pathname = new URL(req.url).pathname;
  console.log(`[viral-core] method=${req.method} pathname=${pathname} debug_id=${debugId}`);

  try {
    // Origin policy
    const originBlock = enforceOriginPolicy(req, debugId);
    if (originBlock) return withIdentity(originBlock, "origin-blocked");

    // ── GET routes (public, no auth) ──
    if (req.method === "GET") {
      if (pathname.endsWith("/manifest")) return handleManifest(req, debugId);
      if (pathname.endsWith("/capabilities")) return handleCapabilities(req, debugId);
      if (pathname.endsWith("/health") || pathname.endsWith("/__health") || pathname === "/" || pathname.endsWith(EXPECTED_BASE_PATH)) {
        return handleHealth(req, debugId);
      }
      return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `GET ${pathname} not found`, debugId), "error");
    }

    // ── POST routes (auth required) ──
    if (req.method !== "POST") {
      return withIdentity(fail(req, 405, "METHOD_NOT_ALLOWED", "Use GET or POST", debugId), "error");
    }

    const authErr = requireSecret(req, debugId);
    if (authErr) return withIdentity(authErr, "auth-rejected");

    // Parse body
    const rawBody = await req.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      return withIdentity(fail(req, 413, "PAYLOAD_TOO_LARGE", "Request body exceeds 500KB", debugId), "error");
    }

    let body: Record<string, unknown> = {};
    if (rawBody) {
      try { body = JSON.parse(rawBody); } catch {
        return withIdentity(fail(req, 400, "INVALID_JSON", "Body must be valid JSON", debugId), "error");
      }
    }

    // Route matching
    if (pathname.endsWith("/generate-bundle")) {
      return await handleGenerateBundle(req, body as unknown as GenerateBundleRequest, debugId);
    }
    if (pathname.endsWith("/generate-single")) {
      return await handleGenerateSingle(req, body as unknown as GenerateSingleRequest, debugId);
    }
    if (pathname.endsWith("/policy-check")) {
      return handlePolicyCheck(req, body as unknown as PolicyCheckRequest, debugId);
    }
    if (pathname.endsWith("/build-media-brief")) {
      return handleBuildMediaBrief(req, body as unknown as BuildMediaBriefRequest, debugId);
    }

    return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `POST ${pathname} not found`, debugId), "error");

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[viral-core] Error debug_id=${debugId}:`, errMsg);
    return withIdentity(fail(req, 500, "INTERNAL_ERROR", `An internal error occurred. Reference: ${debugId}`, debugId), "error");
  }
});
