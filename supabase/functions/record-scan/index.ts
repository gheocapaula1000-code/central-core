// record-scan — self-contained (no _shared imports beyond billing helpers below)
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const APP_ID = "civiko_one";
const TRIAL_SCAN_LIMIT = 3;
const FALLBACK_PAID_LIMIT = 30;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Inline owner check (avoid missing _shared/ownerUtils.ts)
function getOwnerEmails(): string[] {
  const raw = Deno.env.get("CORE_ADMIN_BOOTSTRAP_EMAILS") ?? "";
  return raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function isBillingActive(): boolean {
  return !!Deno.env.get("STRIPE_SECRET_KEY");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      headers: { ...CORS, "Content-Type": "application/json" },
      status,
    });

  const serviceClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Non autorizzato" }, 401);

    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) return json({ error: "Token vuoto" }, 401);

    const { data: userData, error: userError } = await serviceClient.auth.getUser(token);
    if (userError || !userData.user) return json({ error: "Sessione non valida" }, 401);
    const user = userData.user;

    // Bypass owner (by email)
    const ownerEmails = getOwnerEmails();
    if (user.email && ownerEmails.includes(user.email.toLowerCase())) {
      return json({ recorded: false, bypassed: true, scans_used: 0, scans_limit: 999, plan_key: "owner" });
    }

    // Bypass admin
    const { data: roleData } = await serviceClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (roleData) {
      return json({ recorded: false, bypassed: true, scans_used: 0, scans_limit: 999, plan_key: "admin" });
    }

    // Body
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch {
      return json({ error: "Payload non valido" }, 400);
    }
    const scan_id = body.scan_id;
    if (!scan_id || typeof scan_id !== "string") {
      return json({ error: "scan_id richiesto" }, 400);
    }

    // Risolvi agency_id
    let agencyId: string = user.id;
    const { data: membership } = await serviceClient
      .from("agency_memberships")
      .select("agency_id")
      .eq("user_id", user.id)
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (membership?.agency_id) agencyId = membership.agency_id as string;

    // Subscription
    const { data: sub } = await serviceClient
      .from("billing_subscriptions")
      .select("status, plan_key, current_period_end, trial_end")
      .eq("agency_id", agencyId)
      .eq("app_id", APP_ID)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const hasActiveSub = !!sub && (sub.status === "active" || sub.status === "trialing");

    if (sub && !hasActiveSub) {
      return json({
        error: "Abbonamento non attivo",
        limit_reached: true,
        plan_key: sub.plan_key ?? null,
        status: sub.status,
        billing_active: isBillingActive(),
      }, 403);
    }

    // Limite da entitlements
    let scansLimit: number = TRIAL_SCAN_LIMIT;
    let planKey: string | null = null;

    if (hasActiveSub && sub?.plan_key) {
      planKey = sub.plan_key;
      const { data: ent } = await serviceClient
        .from("billing_entitlements")
        .select("monthly_scans")
        .eq("plan_key", planKey)
        .eq("app_id", APP_ID)
        .maybeSingle();

      if (ent && ent.monthly_scans === null) {
        scansLimit = Number.POSITIVE_INFINITY;
      } else if (ent && typeof ent.monthly_scans === "number") {
        scansLimit = ent.monthly_scans;
      } else {
        scansLimit = FALLBACK_PAID_LIMIT;
      }
    }

    const periodStart = (() => {
      if (hasActiveSub && sub?.current_period_end) {
        const end = new Date(sub.current_period_end);
        const start = new Date(end);
        start.setMonth(start.getMonth() - 1);
        return start;
      }
      const now = new Date();
      return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    })();

    const { count: usedCountRaw, error: countErr } = await serviceClient
      .from("sottra_scans")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .gte("created_at", periodStart.toISOString());

    if (countErr) {
      console.error("record-scan count error:", countErr);
      return json({ error: "Errore nel conteggio scansioni" }, 500);
    }
    const scansUsed = usedCountRaw ?? 0;

    // Idempotenza
    let alreadyRecorded = false;
    try {
      const { data: existing } = await serviceClient
        .from("scan_events")
        .select("id")
        .eq("scan_id", scan_id)
        .maybeSingle();
      alreadyRecorded = !!existing;
    } catch (e) {
      console.warn("record-scan idempotency lookup failed:", e);
    }

    if (!alreadyRecorded && scansUsed >= scansLimit) {
      return json({
        error: "Limite scansioni raggiunto",
        limit_reached: true,
        scans_used: scansUsed,
        scans_limit: Number.isFinite(scansLimit) ? scansLimit : null,
        plan_key: planKey,
        period_start: periodStart.toISOString(),
      }, 403);
    }

    if (!alreadyRecorded) {
      const { error: insertErr } = await serviceClient
        .from("scan_events")
        .insert({ user_id: user.id, scan_id });
      if (insertErr && insertErr.code !== "23505") {
        console.error("scan_events insert error:", insertErr);
      }
    }

    const newScansUsed = alreadyRecorded ? scansUsed : scansUsed + 1;
    return json({
      recorded: !alreadyRecorded,
      replayed: alreadyRecorded,
      scans_used: newScansUsed,
      scans_limit: Number.isFinite(scansLimit) ? scansLimit : null,
      plan_key: planKey,
      agency_id: agencyId,
      period_start: periodStart.toISOString(),
    });
  } catch (error) {
    console.error("record-scan unhandled:", error);
    return json({ error: "Errore temporaneo" }, 500);
  }
});
