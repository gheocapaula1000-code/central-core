// Civiko One-only authorization for authoritative snapshot endpoints.
//
// These endpoints run with verify_jwt=false because the PWA calls them through
// its trusted Core proxy.  The guard is therefore deliberately fail-closed:
// exact source app, per-app secret, server-side workspace lookup and an exact
// commercial-zone filter.  No client value can grant full-city access.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

export const CIVIKO_PADOVA_ZONE_SLUGS = [
  "centro-storico",
  "nord-arcella",
  "est-brenta",
  "nord-est",
  "sud-est-sant-osvaldo",
  "sud-voltabarozzo-guizza",
  "sud-ovest-mandria",
  "ovest-chiesanuova-brentelle",
] as const;

const OFFICIAL = new Set<string>(CIVIKO_PADOVA_ZONE_SLUGS);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_APP = "civiko-one";

export const CIVIKO_SNAPSHOT_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-source-app, x-internal-secret, x-workspace-id, x-tenant-id",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

export type SnapshotAccess = {
  ok: true;
  client: SupabaseClient;
  workspaceId: string;
  isAdmin: boolean;
  slugs: string[];
};

export type SnapshotAccessError = {
  ok: false;
  status: number;
  code: string;
};

function constantTimeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const len = Math.max(aa.length, bb.length);
  let mismatch = aa.length ^ bb.length;
  for (let i = 0; i < len; i++) mismatch |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return mismatch === 0;
}

function requestedSlug(req: Request): string | null {
  const raw = new URL(req.url).searchParams.get("commercial_zone_slug");
  if (raw == null || raw.trim() === "") return null;
  return raw.trim();
}

export async function authorizeCivikoSnapshot(
  req: Request,
): Promise<SnapshotAccess | SnapshotAccessError> {
  const sourceApp = (req.headers.get("x-source-app") ?? "").trim().toLowerCase();
  const expected = Deno.env.get("AI_CORE_SECRET_CIVIKO") ?? "";
  const supplied = req.headers.get("x-internal-secret") ?? "";
  if (!expected) return { ok: false, status: 500, code: "AUTH_NOT_CONFIGURED" };
  if (sourceApp !== SOURCE_APP || !supplied || !constantTimeEqual(supplied, expected)) {
    return { ok: false, status: 401, code: "UNAUTHORIZED" };
  }

  const workspaceId = (
    req.headers.get("x-workspace-id") ?? req.headers.get("x-tenant-id") ?? ""
  ).trim();
  if (!UUID_RE.test(workspaceId)) {
    return { ok: false, status: 401, code: "WORKSPACE_REQUIRED" };
  }

  const base = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!base || !serviceKey) return { ok: false, status: 500, code: "DB_NOT_CONFIGURED" };
  const client = createClient(base, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: adminResult, error: adminError } = await client.rpc(
    "civiko_is_admin_agency",
    { _agency_id: workspaceId },
  );
  if (adminError) return { ok: false, status: 502, code: "ADMIN_LOOKUP_FAILED" };
  const isAdmin = adminResult === true;

  let authorized: string[];
  if (isAdmin) {
    authorized = [...CIVIKO_PADOVA_ZONE_SLUGS];
  } else {
    const { data, error } = await client
      .from("civiko_commercial_zones")
      .select("slug,status,occupied_agency_id,trial_agency_id,trial_reserved_until")
      .or(
        `and(status.eq.occupata,occupied_agency_id.eq.${workspaceId}),` +
          `and(status.eq.in_trial,trial_agency_id.eq.${workspaceId})`,
      );
    if (error) return { ok: false, status: 502, code: "ZONE_LOOKUP_FAILED" };
    const now = Date.now();
    authorized = (data ?? []).flatMap((row: Record<string, unknown>) => {
      const slug = typeof row.slug === "string" ? row.slug : "";
      if (!OFFICIAL.has(slug)) return [];
      if (row.status === "occupata" && row.occupied_agency_id === workspaceId) return [slug];
      if (
        row.status === "in_trial" && row.trial_agency_id === workspaceId &&
        typeof row.trial_reserved_until === "string" &&
        Date.parse(row.trial_reserved_until) > now
      ) return [slug];
      return [];
    });
    authorized = [...new Set(authorized)];
    if (authorized.length === 0) {
      return { ok: false, status: 403, code: "NO_ZONE_ASSIGNED" };
    }
  }

  const requested = requestedSlug(req);
  if (requested != null) {
    // '%' and '_' never reach an ILIKE: they are rejected by the literal
    // allowlist before any query is built.
    if (!OFFICIAL.has(requested)) {
      return { ok: false, status: 400, code: "INVALID_COMMERCIAL_ZONE" };
    }
    if (!isAdmin && !authorized.includes(requested)) {
      return { ok: false, status: 403, code: "ZONE_NOT_ASSIGNED" };
    }
    return { ok: true, client, workspaceId, isAdmin, slugs: [requested] };
  }

  // Full-city is reserved to an owner/admin proven by the server-side RPC.
  if (!isAdmin && authorized.length !== 1) {
    return { ok: false, status: 403, code: "ZONE_SELECTION_REQUIRED" };
  }
  return {
    ok: true,
    client,
    workspaceId,
    isAdmin,
    slugs: isAdmin ? [...CIVIKO_PADOVA_ZONE_SLUGS] : [authorized[0]],
  };
}

export function snapshotAccessError(error: SnapshotAccessError): Response {
  return new Response(JSON.stringify({ ok: false, error: error.code }), {
    status: error.status,
    headers: CIVIKO_SNAPSHOT_CORS,
  });
}
