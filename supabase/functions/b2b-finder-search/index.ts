// b2b-finder-search — Step 3 (dry-run, Overpass-only, no DB writes, no AI).
// Isolated module. Does not import from civiko-* / core-* / shared globals.

import { corsHeaders, handlePreflight, pickOrigin } from "../_shared/b2b/cors.ts";
import { authorizeB2BFinder } from "../_shared/b2b/auth.ts";
import { PADOVA_BBOX, queryOverpass } from "../_shared/b2b/overpass.ts";
import { scoreAndNormalize } from "../_shared/b2b/normalize.ts";

interface SearchInput {
  mode?: string;
  product?: string;
  target_description?: string;
  sector?: string;
  area_text?: string;
  region?: string;
  province?: string;
  city?: string;
  limit?: number;
  search_depth?: "quick" | "deep";
  dry_run?: boolean;
}

function newDebugId(): string {
  return "b2bf_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
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

function jsonResponse(
  req: Request,
  status: number,
  body: ReturnType<typeof envelope>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json",
      "X-Function": "b2b-finder-search",
      "X-Contract": "b2b-finder/v0.1",
    },
  });
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const debug_id = newDebugId();

  // origin gate (separate from CORS preflight: covers non-browser callers too,
  // but only if they sent an Origin header). Server-to-server callers without
  // an Origin header are allowed to pass and rely on auth.
  if (req.headers.get("origin") && !pickOrigin(req)) {
    return jsonResponse(
      req,
      403,
      envelope(false, null, "Forbidden origin", debug_id),
    );
  }

  if (req.method !== "POST") {
    return jsonResponse(
      req,
      405,
      envelope(false, null, "Method not allowed", debug_id),
    );
  }

  // auth
  const auth = authorizeB2BFinder(req);
  if (!auth.ok) {
    console.warn(`[b2b-finder-search] auth rejected debug_id=${debug_id} reason=${auth.reason}`);
    return jsonResponse(
      req,
      401,
      envelope(false, null, "Unauthorized", debug_id),
    );
  }

  // parse body
  let input: SearchInput;
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      return jsonResponse(
        req,
        400,
        envelope(false, null, "Content-Type must be application/json", debug_id),
      );
    }
    input = await req.json();
  } catch {
    return jsonResponse(
      req,
      400,
      envelope(false, null, "Invalid JSON body", debug_id),
    );
  }

  // validation
  const warnings: string[] = [];
  const mode = input.mode ?? "buyers";
  if (mode !== "buyers" && mode !== "suppliers") {
    return jsonResponse(
      req,
      400,
      envelope(false, null, "mode must be 'buyers' or 'suppliers'", debug_id),
    );
  }
  if (mode !== "buyers") {
    return jsonResponse(
      req,
      400,
      envelope(false, null, "v1 supports only mode='buyers'", debug_id),
    );
  }

  if (input.dry_run !== true) {
    return jsonResponse(
      req,
      400,
      envelope(false, null, "Step 3 requires dry_run=true", debug_id),
    );
  }

  const province = (input.province ?? "PD").toUpperCase();
  if (province !== "PD") {
    return jsonResponse(
      req,
      400,
      envelope(false, null, "v1 supports only province='PD'", debug_id),
    );
  }
  const city = input.city ?? "Padova";
  if (city.toLowerCase() !== "padova") {
    return jsonResponse(
      req,
      400,
      envelope(false, null, "v1 supports only city='Padova'", debug_id),
    );
  }
  const region = input.region ?? "Veneto";

  const maxResults = Math.max(
    1,
    parseInt(Deno.env.get("B2B_FINDER_MAX_RESULTS_PER_JOB") ?? "100", 10) || 100,
  );
  const requested = Math.max(1, Math.floor(input.limit ?? 50));
  const applied = Math.min(requested, maxResults);
  if (applied < requested) {
    warnings.push(`limit clamped from ${requested} to ${applied}`);
  }

  if (input.search_depth && input.search_depth !== "quick") {
    warnings.push(`search_depth forced to 'quick' in dry-run`);
  }

  console.log(
    `[b2b-finder-search] start debug_id=${debug_id} city=${city} province=${province} requested=${requested} applied=${applied}`,
  );

  // Overpass
  let pois;
  try {
    pois = await queryOverpass(PADOVA_BBOX, 25000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "overpass error";
    console.error(`[b2b-finder-search] overpass failed debug_id=${debug_id} err=${msg}`);
    return jsonResponse(
      req,
      502,
      envelope(false, null, `Overpass unavailable: ${msg}`, debug_id, warnings),
    );
  }

  const normalized = pois
    .map((p) => scoreAndNormalize(p, { city, province, region }))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.score - a.score);

  const total = normalized.length;
  const results = normalized.slice(0, applied);

  console.log(
    `[b2b-finder-search] ok debug_id=${debug_id} total=${total} sample=${results.length}`,
  );

  return jsonResponse(
    req,
    200,
    envelope(
      true,
      {
        dry_run: true,
        provider: "overpass",
        city,
        province,
        requested_limit: requested,
        applied_limit: applied,
        total_found: total,
        sample_count: results.length,
        results,
      },
      null,
      debug_id,
      warnings,
    ),
  );
});
