// civiko-source-registry — admin / job-secret imports.
// Documented path POST /import/sue-permits was missing; this implements it.
// Never invents SUE rows. compliance_verified must be true on each imported row.

import { createClient } from "npm:@supabase/supabase-js@2";
import { isJobSecretAuthorized, jobAuthFailure } from "../_shared/jobAuth.ts";
import { parseCsv } from "../_shared/csvImport.ts";
import { assertAggregateOnly } from "../_shared/compliance.ts";
import { mapCsvToPermit } from "../_shared/padovaUrbanLayers.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-job-secret, x-internal-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function pathOf(req: Request): string {
  const u = new URL(req.url);
  return u.pathname.replace(/^\/civiko-source-registry/, "") || "/";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const svc = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const jobOk = isJobSecretAuthorized(req.headers, jobSecret);
  if (!jobOk) {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      const auth = jobAuthFailure(Boolean(jobSecret));
      return json(auth.status, { ok: false, error: auth.error });
    }
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
    );
    const { data: userData } = await userClient.auth.getUser();
    if (!userData?.user) return json(401, { ok: false, error: "unauthorized" });
    const { data: isAdmin } = await svc.rpc("has_role", {
      _user_id: userData.user.id,
      _role: "admin",
    });
    if (!isAdmin) return json(403, { ok: false, error: "forbidden" });
  }

  const path = pathOf(req);

  if (req.method === "GET" && (path === "/" || path === "/sources")) {
    const { data, error } = await svc
      .from("civiko_source_registry")
      .select("source_code,name,automation_status,scheduler_job_name,ingestion_endpoint,implementation_status,last_success_at,last_error,record_count")
      .order("source_code");
    if (error) return json(502, { ok: false, error: "query_error" });
    return json(200, { ok: true, sources: data ?? [] });
  }

  if (req.method === "POST" && (path === "/import/sue-permits" || path === "/import/sue-padova")) {
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return json(400, { ok: false, error: "invalid_json" });
    }
    const sourceUrl = typeof body.source_url === "string" && body.source_url.startsWith("https://")
      ? body.source_url
      : "manual://sue-permits";
    const fetchedAt = new Date().toISOString();
    const rawRows = Array.isArray(body.rows)
      ? (body.rows as Record<string, unknown>[])
      : parseCsv(typeof body.csv === "string" ? body.csv : "");
    if (rawRows.length === 0) {
      return json(200, { ok: true, records_processed: 0, empty: true, rejected: 0 });
    }

    const permits = [];
    let rejected = 0;
    for (const raw of rawRows) {
      const row: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw ?? {})) {
        if (v != null && typeof v !== "object") row[k.toLowerCase()] = String(v);
      }
      const verified = String(row.compliance_verified ?? "").toLowerCase() === "true";
      if (!verified) {
        rejected++;
        continue;
      }
      try {
        assertAggregateOnly(row, "F18");
      } catch {
        rejected++;
        continue;
      }
      const mapped = mapCsvToPermit(row, sourceUrl, "admin-import-sue-permits", fetchedAt, true);
      if (!mapped) {
        rejected++;
        continue;
      }
      permits.push({
        area_name: mapped.area_name,
        address_public: mapped.address_public,
        practice_type: mapped.practice_type,
        practice_date: mapped.practice_date,
        status: mapped.status,
        source_url: mapped.source_url,
        source_name: mapped.source_name,
        external_id: mapped.external_id,
        commercial_zone_slug: mapped.commercial_zone_slug,
        fetched_at: mapped.fetched_at,
        imported_at: mapped.fetched_at,
        compliance_verified: true,
        raw_ref: mapped.raw_ref,
      });
    }

    if (permits.length === 0) {
      return json(200, { ok: true, records_processed: 0, empty: true, rejected });
    }

    const { error } = await svc.from("sue_padova_permits").upsert(permits, {
      onConflict: "source_url,external_id",
    });
    if (error) return json(502, { ok: false, error: "upsert_failed", records_processed: 0 });
    return json(200, { ok: true, records_processed: permits.length, empty: false, rejected });
  }

  return json(404, { ok: false, error: "not_found" });
});
