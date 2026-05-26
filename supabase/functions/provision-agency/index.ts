// provision-agency — Admin-only edge function to create an agency,
// owner user, membership and operating area (microzone). Service-role,
// idempotent, never overwrites another agency's microzone.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `agency-${Date.now()}`;
}

function ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function parseList(name: string): string[] {
  return (Deno.env.get(name) ?? "")
    .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
}

async function authorize(req: Request): Promise<{ ok: boolean; reason?: string }> {
  // Tier 1: shared admin secret via header
  const adminSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const provided =
    req.headers.get("x-admin-secret") ??
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (adminSecret && provided && ctEq(provided, adminSecret)) return { ok: true };

  // Tier 2: verified JWT belonging to admin allowlist
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (bearer.startsWith("eyJ")) {
    try {
      const url = Deno.env.get("SUPABASE_URL")!;
      const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
      const sb = createClient(url, anon);
      const { data: { user } } = await sb.auth.getUser(bearer);
      const email = (user?.email ?? "").toLowerCase();
      if (email) {
        const allow = new Set([
          ...parseList("CORE_ADMIN_BOOTSTRAP_EMAILS"),
          ...parseList("AI_CORE_ADMIN_EMAILS"),
        ]);
        if (allow.has(email)) return { ok: true };
      }
    } catch (_) { /* fallthrough */ }
  }
  return { ok: false, reason: "admin authorization required" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });

  const auth = await authorize(req);
  if (!auth.ok) return json(401, { ok: false, error: auth.reason });

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json(400, { ok: false, error: "invalid JSON" }); }

  const email = String(body.email ?? "").trim().toLowerCase();
  const agencyName = String(body.agency_name ?? "").trim();
  const role = String(body.role ?? "owner").trim();
  const plan = body.plan != null ? String(body.plan) : null;
  const microzones: string[] = Array.isArray(body.microzones)
    ? body.microzones.map((m) => String(m).trim()).filter(Boolean) : [];
  const slug = String(body.agency_slug ?? "").trim() || slugify(agencyName || email);

  if (!email || !email.includes("@")) return json(400, { ok: false, error: "valid email required" });
  if (!agencyName) return json(400, { ok: false, error: "agency_name required" });
  if (!["owner", "admin", "agent", "viewer"].includes(role)) {
    return json(400, { ok: false, error: "role must be owner|admin|agent|viewer" });
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const warnings: string[] = [];

  // a) find/create user
  let userId: string | null = null;
  try {
    // Paginate listUsers
    let page = 1;
    const perPage = 1000;
    while (!userId) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
      if (error) throw error;
      const found = data.users.find((u) => (u.email ?? "").toLowerCase() === email);
      if (found) { userId = found.id; break; }
      if (data.users.length < perPage) break;
      page += 1;
      if (page > 20) break;
    }
  } catch (e) {
    return json(500, { ok: false, error: `listUsers failed: ${(e as Error).message}` });
  }

  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email, email_confirm: false,
    });
    if (error || !data.user) {
      return json(500, { ok: false, error: `createUser failed: ${error?.message ?? "unknown"}` });
    }
    userId = data.user.id;
  } else {
    warnings.push("user already existed; reused");
  }

  // b) generate action link (invite if new, recovery otherwise)
  let actionLink: string | null = null;
  const linkType = warnings.some((w) => w.includes("user already existed")) ? "recovery" : "invite";
  try {
    const { data, error } = await admin.auth.admin.generateLink({
      type: linkType as "invite" | "recovery",
      email,
    });
    if (error) warnings.push(`generateLink(${linkType}) failed: ${error.message}`);
    // deno-lint-ignore no-explicit-any
    actionLink = (data as any)?.properties?.action_link ?? null;
  } catch (e) {
    warnings.push(`generateLink threw: ${(e as Error).message}`);
  }

  // c) find or create agency by slug
  let agencyId: string | null = null;
  let finalSlug = slug;
  {
    const { data: existing } = await admin.from("agencies")
      .select("id,slug").eq("slug", slug).maybeSingle();
    if (existing) {
      agencyId = existing.id;
      warnings.push(`agency slug already existed; reused id=${agencyId}`);
    } else {
      const insertRow: Record<string, unknown> = { name: agencyName, slug, billing_email: email };
      if (plan) insertRow.plan = plan;
      const { data: created, error } = await admin.from("agencies")
        .insert(insertRow).select("id,slug").single();
      if (error || !created) {
        return json(500, { ok: false, error: `agency insert failed: ${error?.message ?? "unknown"}` });
      }
      agencyId = created.id;
      finalSlug = created.slug ?? slug;
    }
  }

  // d) membership idempotent
  {
    const { data: existingMem } = await admin.from("agency_memberships")
      .select("id,role").eq("agency_id", agencyId).eq("user_id", userId).maybeSingle();
    if (!existingMem) {
      const { error } = await admin.from("agency_memberships")
        .insert({ agency_id: agencyId, user_id: userId, role, status: "active" });
      if (error) return json(500, { ok: false, error: `membership insert failed: ${error.message}` });
    } else {
      warnings.push(`membership already existed (role=${existingMem.role}); not modified`);
    }
  }

  // e) microzone exclusivity + assignment
  const assigned: string[] = [];
  const skipped: Array<{ microzone: string; reason: string; owner_agency_id?: string }> = [];

  // Load all rows once for exclusivity scan
  const { data: allAreas, error: areasErr } = await admin
    .from("agency_operating_areas")
    .select("id,agency_id,microzones,label,is_active");
  if (areasErr) return json(500, { ok: false, error: `operating_areas read failed: ${areasErr.message}` });

  for (const mz of microzones) {
    const mzLower = mz.toLowerCase();
    const conflict = (allAreas ?? []).find((row) => {
      const list: string[] = Array.isArray(row.microzones) ? row.microzones : [];
      return list.some((x) => String(x).toLowerCase() === mzLower) && row.agency_id !== agencyId;
    });
    if (conflict) {
      skipped.push({ microzone: mz, reason: "already assigned to another agency", owner_agency_id: conflict.agency_id ?? undefined });
      continue;
    }
    const owned = (allAreas ?? []).find((row) => {
      const list: string[] = Array.isArray(row.microzones) ? row.microzones : [];
      return row.agency_id === agencyId && list.some((x) => String(x).toLowerCase() === mzLower);
    });
    if (owned) {
      skipped.push({ microzone: mz, reason: "already assigned to this agency" });
      continue;
    }
    const { error } = await admin.from("agency_operating_areas").insert({
      agency_id: agencyId,
      user_id: userId,
      label: mz,
      microzones: [mz],
      is_active: true,
    });
    if (error) {
      skipped.push({ microzone: mz, reason: `insert failed: ${error.message}` });
      continue;
    }
    assigned.push(mz);
  }

  console.log(JSON.stringify({
    fn: "provision-agency", event: "provisioned",
    agency_id: agencyId, agency_slug: finalSlug, user_id: userId,
    role, microzones_assigned: assigned.length, microzones_skipped: skipped.length,
  }));

  return json(200, {
    ok: true,
    user_id: userId,
    agency_id: agencyId,
    agency_slug: finalSlug,
    action_link: actionLink,
    action_link_type: linkType,
    microzones_assigned: assigned,
    microzones_skipped: skipped,
    warnings,
  });
});
