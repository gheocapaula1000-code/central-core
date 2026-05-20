// One-shot bootstrap: copies CENTRAL_CORE_JOB_SECRET (edge env)
// into Supabase Vault under name `central_core_job_secret` so that
// the pg_cron trigger `private.padova_daily_radar_trigger` can read it.
//
// Auth: bootstrap admin (verified JWT) only.
// Idempotent: if the vault entry already exists, returns existed=true
// without overwriting.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  handleOptions,
  ok,
  fail,
  checkBootstrapAdmin,
  makeDebugId,
  addIdentityHeaders,
} from "../_shared/http.ts";

const FUNCTION_NAME = "padova-vault-bootstrap";
const ROUTE = "/admin/vault/bootstrap-padova";

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  const debugId = makeDebugId();
  const identity = { function: FUNCTION_NAME, route: ROUTE };

  try {
    const { isAdmin, email } = await checkBootstrapAdmin(req);
    if (!isAdmin) {
      return addIdentityHeaders(
        fail(req, 403, "FORBIDDEN", "Bootstrap admin required", debugId),
        identity,
      );
    }
    if (req.method !== "POST") {
      return addIdentityHeaders(
        fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId),
        identity,
      );
    }

    const secretValue = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
    if (!secretValue) {
      return addIdentityHeaders(
        fail(req, 500, "ENV_MISSING", "CENTRAL_CORE_JOB_SECRET not configured", debugId),
        identity,
      );
    }

    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!url || !srk) {
      return addIdentityHeaders(
        fail(req, 500, "CONFIG_ERROR", "Supabase env missing", debugId),
        identity,
      );
    }

    const sb = createClient(url, srk, { auth: { persistSession: false } });

    // Check existence via RPC (we cannot SELECT vault.secrets directly here).
    // Use a helper SQL function created on-the-fly via raw rpc not allowed —
    // instead we call vault.create_secret and tolerate duplicate-name errors.
    const { data: createData, error: createError } = await sb.rpc(
      "vault_create_secret_if_missing",
      { p_name: "central_core_job_secret", p_value: secretValue },
    );

    if (createError) {
      console.error(`[${FUNCTION_NAME}] vault rpc error: ${createError.message}`);
      return addIdentityHeaders(
        fail(req, 500, "VAULT_ERROR", createError.message, debugId),
        identity,
      );
    }

    console.log(`[${FUNCTION_NAME}] bootstrap ok by=${email ?? "?"} result=${JSON.stringify(createData)}`);

    return addIdentityHeaders(
      ok(req, { name: "central_core_job_secret", ...((createData as object) ?? {}) }, [], debugId),
      identity,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${FUNCTION_NAME}] error: ${msg}`);
    return addIdentityHeaders(
      fail(req, 500, "INTERNAL_ERROR", "Internal error", debugId),
      identity,
    );
  }
});
