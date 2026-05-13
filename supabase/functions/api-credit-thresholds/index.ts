// api-credit-thresholds — admin-only persistent credit thresholds
// GET: list thresholds (defaults applied when missing)
// POST: upsert threshold for a provider
// Never returns or stores keys/tokens.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const KNOWN_PROVIDERS = [
  "firecrawl", "apify", "perplexity", "lovable",
  "openai", "anthropic", "google_maps", "mapbox", "stripe",
];

const DEFAULTS = {
  warning_threshold_eur: 25,
  critical_threshold_eur: 10,
  block_threshold_eur: 5,
  recommended_topup_eur: 50,
};

const AUTOMATION_NOTE =
  "Le ricariche automatiche dipendono dalle policy dei singoli provider. Il sistema monitora, avvisa e guida l’azione, ma non effettua pagamenti automatici senza conferma.";

function ownerEmails(): string[] {
  const raw = Deno.env.get("CORE_ADMIN_BOOTSTRAP_EMAILS") ?? "";
  return raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), {
    status: s,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: { code: "UNAUTHORIZED", message: "Auth richiesta" } }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );
    const token = auth.replace("Bearer ", "").trim();
    const { data: userData, error: uErr } = await supabase.auth.getUser(token);
    if (uErr || !userData.user) {
      return json({ error: { code: "UNAUTHORIZED", message: "Auth non valida" } }, 401);
    }

    const email = (userData.user.email ?? "").toLowerCase();
    const userId = userData.user.id;
    const isOwner = ownerEmails().includes(email);
    let isAdmin = isOwner;
    if (!isAdmin) {
      const { data: role } = await supabase
        .from("user_roles").select("role")
        .eq("user_id", userId).eq("role", "admin").maybeSingle();
      isAdmin = !!role;
    }
    if (!isAdmin) return json({ error: { code: "FORBIDDEN", message: "Solo owner/admin" } }, 403);

    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("api_credit_thresholds")
        .select("provider, warning_threshold_eur, critical_threshold_eur, block_threshold_eur, recommended_topup_eur, notes, updated_at, updated_by");
      if (error) {
        console.error("act:get error", error.message);
        return json({ error: { code: "INTERNAL", message: "Errore lettura soglie" } }, 500);
      }
      const byProvider = new Map<string, any>();
      (data ?? []).forEach((row) => byProvider.set(row.provider, row));
      const thresholds = KNOWN_PROVIDERS.map((p) => {
        const row = byProvider.get(p);
        return {
          provider: p,
          ...DEFAULTS,
          ...(row ?? {}),
          source: row ? "persisted" : "default",
        };
      });
      return json({
        ok: true,
        defaults: DEFAULTS,
        thresholds,
        automation_note: AUTOMATION_NOTE,
      });
    }

    if (req.method === "POST") {
      let body: any = null;
      try { body = await req.json(); } catch { /* noop */ }
      if (!body || typeof body !== "object") {
        return json({ error: { code: "BAD_REQUEST", message: "Body JSON richiesto" } }, 400);
      }
      const provider = String(body.provider ?? "").toLowerCase().trim();
      if (!KNOWN_PROVIDERS.includes(provider)) {
        return json({ error: { code: "BAD_REQUEST", message: "Provider non valido" } }, 400);
      }

      const num = (v: unknown, fb: number) => {
        const n = typeof v === "number" ? v : Number(v);
        return Number.isFinite(n) && n >= 0 ? n : fb;
      };
      const warning = num(body.warning_threshold_eur, DEFAULTS.warning_threshold_eur);
      const critical = num(body.critical_threshold_eur, DEFAULTS.critical_threshold_eur);
      const block = num(body.block_threshold_eur, DEFAULTS.block_threshold_eur);
      const topup = num(body.recommended_topup_eur, DEFAULTS.recommended_topup_eur);

      if (!(warning >= critical && critical >= block)) {
        return json({
          error: { code: "BAD_REQUEST", message: "Ordine soglie non valido: warning ≥ critical ≥ block" },
        }, 400);
      }

      const notes = typeof body.notes === "string" ? body.notes.slice(0, 500) : null;

      const { data, error } = await supabase
        .from("api_credit_thresholds")
        .upsert({
          provider,
          warning_threshold_eur: warning,
          critical_threshold_eur: critical,
          block_threshold_eur: block,
          recommended_topup_eur: topup,
          notes,
          updated_at: new Date().toISOString(),
          updated_by: userId,
        }, { onConflict: "provider" })
        .select()
        .maybeSingle();

      if (error) {
        console.error("act:post error", error.message);
        return json({ error: { code: "INTERNAL", message: "Errore salvataggio soglia" } }, 500);
      }
      return json({ ok: true, threshold: data, automation_note: AUTOMATION_NOTE });
    }

    return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Usa GET o POST" } }, 405);
  } catch (e) {
    console.error("api-credit-thresholds fatal:", (e as Error).message);
    return json({ error: { code: "INTERNAL", message: "Errore temporaneo" } }, 500);
  }
});
