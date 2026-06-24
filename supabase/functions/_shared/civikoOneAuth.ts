// Civiko One Rebuild — auth helper for PWA → Core edge functions.
// The PWA calls these endpoints with the end-user Supabase JWT.
// We verify the JWT and check agency membership server-side.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export const civikoOneCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-source-app",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

export interface CivikoOneAuthOk {
  ok: true;
  userId: string;
  agencyId: string;
  serviceClient: SupabaseClient;
  userClient: SupabaseClient;
}

export interface CivikoOneAuthErr {
  ok: false;
  status: number;
  code: string;
  message: string;
}

/**
 * Verify caller JWT + ensure they are an active member of `agencyId`.
 * Returns a service-role client for trusted writes and a user-scoped client.
 */
export async function authorizeCivikoOne(
  req: Request,
  agencyId: string | undefined | null,
): Promise<CivikoOneAuthOk | CivikoOneAuthErr> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!supabaseUrl || !anonKey || !serviceKey) {
    return { ok: false, status: 500, code: "CONFIG_MISSING", message: "Supabase env not configured" };
  }
  if (!agencyId || typeof agencyId !== "string") {
    return { ok: false, status: 400, code: "AGENCY_ID_REQUIRED", message: "agency_id missing" };
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: 401, code: "AUTH_REQUIRED", message: "Missing bearer token" };
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return { ok: false, status: 401, code: "INVALID_TOKEN", message: "JWT invalid or expired" };
  }
  const userId = userData.user.id;

  const serviceClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Verify active membership server-side (defense in depth beyond RLS).
  const { data: mem, error: memErr } = await serviceClient
    .from("agency_memberships")
    .select("role,status")
    .eq("agency_id", agencyId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (memErr) {
    return { ok: false, status: 500, code: "MEMBERSHIP_LOOKUP_FAILED", message: memErr.message };
  }
  if (!mem) {
    return { ok: false, status: 403, code: "NOT_AGENCY_MEMBER", message: "User is not an active member of this agency" };
  }

  return { ok: true, userId, agencyId, serviceClient, userClient };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...civikoOneCors, "Content-Type": "application/json" },
  });
}

export function errorResponse(code: string, message: string, status = 400, debug_id?: string): Response {
  return jsonResponse({ ok: false, error: { code, message }, debug_id }, status);
}
