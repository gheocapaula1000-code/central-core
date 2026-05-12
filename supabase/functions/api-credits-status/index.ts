// api-credits-status — admin-only API credit & usage monitor
// Never returns keys, tokens or full payloads. Synthetic, sanitized output only.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function ownerEmails(): string[] {
  const raw = Deno.env.get("CORE_ADMIN_BOOTSTRAP_EMAILS") ?? "";
  return raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

type Risk = "basso" | "medio" | "alto" | "ignoto";
type AutomationKind = "auto_reload" | "manual_only" | "managed" | "pay_per_call";

interface ProviderCard {
  key: string;
  name: string;
  category: "ai" | "scraping" | "maps" | "payments" | "platform";
  configured: boolean;
  connection_status: "ok" | "error" | "unknown";
  credit_estimate: { value: number | null; unit: string; raw_label?: string };
  threshold_min_eur: number | null;
  usage_24h: { calls: number | null; cost_eur: number | null };
  usage_7d: { calls: number | null; cost_eur: number | null };
  exhaustion_risk: Risk;
  recommended_action: string;
  billing_url: string;
  automation: AutomationKind;
  automation_label: string;
  last_check: string;
  error?: string;
}

const now = () => new Date().toISOString();

function riskFromEur(eur: number | null, threshold = 25): Risk {
  if (eur == null) return "ignoto";
  if (eur < 10) return "alto";
  if (eur < threshold) return "medio";
  return "basso";
}

async function checkFirecrawl(): Promise<ProviderCard> {
  const key = Deno.env.get("FIRECRAWL_API_KEY");
  const base: ProviderCard = {
    key: "firecrawl",
    name: "Firecrawl",
    category: "scraping",
    configured: !!key,
    connection_status: "unknown",
    credit_estimate: { value: null, unit: "credits" },
    threshold_min_eur: 25,
    usage_24h: { calls: null, cost_eur: null },
    usage_7d: { calls: null, cost_eur: null },
    exhaustion_risk: "ignoto",
    recommended_action: "Verifica credito sul portale provider.",
    billing_url: "https://www.firecrawl.dev/app/billing",
    automation: "auto_reload",
    automation_label: "Automazione possibile (auto-reload disponibile)",
    last_check: now(),
  };
  if (!key) {
    base.connection_status = "error";
    base.recommended_action = "Configurare FIRECRAWL_API_KEY.";
    base.exhaustion_risk = "alto";
    return base;
  }
  try {
    const r = await fetch("https://api.firecrawl.dev/v2/team/credit-usage", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      const remaining = j?.data?.remaining_credits ?? j?.remaining_credits ?? null;
      base.connection_status = "ok";
      base.credit_estimate = { value: remaining, unit: "credits", raw_label: remaining != null ? `${remaining} credits` : undefined };
      // ~ heuristic 1 credit ≈ €0.001 (free) to €0.005 (Hobby). Stima conservativa ×0.003
      const est = remaining != null ? Math.round(remaining * 0.003) : null;
      base.exhaustion_risk = riskFromEur(est);
      base.recommended_action = est == null
        ? "Controlla credito sul portale."
        : est < 10 ? "Ricarica entro 24h o aumenta il piano."
        : est < 25 ? "Pianifica ricarica in settimana."
        : "Nessuna azione richiesta.";
    } else {
      base.connection_status = "error";
      base.error = `HTTP ${r.status}`;
      base.recommended_action = "Verifica chiave o stato servizio Firecrawl.";
    }
  } catch (e) {
    base.connection_status = "error";
    base.error = (e as Error).message.slice(0, 120);
  }
  return base;
}

async function checkApify(): Promise<ProviderCard> {
  const key = Deno.env.get("APIFY_API_TOKEN");
  const base: ProviderCard = {
    key: "apify",
    name: "Apify",
    category: "scraping",
    configured: !!key,
    connection_status: "unknown",
    credit_estimate: { value: null, unit: "EUR" },
    threshold_min_eur: 25,
    usage_24h: { calls: null, cost_eur: null },
    usage_7d: { calls: null, cost_eur: null },
    exhaustion_risk: "ignoto",
    recommended_action: "Verifica usage sul portale provider.",
    billing_url: "https://console.apify.com/billing",
    automation: "auto_reload",
    automation_label: "Automazione possibile (limite spesa configurabile)",
    last_check: now(),
  };
  if (!key) {
    base.connection_status = "error";
    base.recommended_action = "Configurare APIFY_API_TOKEN.";
    base.exhaustion_risk = "alto";
    return base;
  }
  try {
    const r = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(key)}`);
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      const plan = j?.data?.plan?.id ?? "unknown";
      const monthlyLimit = j?.data?.plan?.maxMonthlyUsageUsd ?? null;
      const usedUsd = j?.data?.currentBillingPeriod?.usageUsd ?? null;
      const remainingUsd = monthlyLimit != null && usedUsd != null ? Math.max(0, monthlyLimit - usedUsd) : null;
      const remainingEur = remainingUsd != null ? Math.round(remainingUsd * 0.92) : null;
      base.connection_status = "ok";
      base.credit_estimate = {
        value: remainingEur,
        unit: "EUR",
        raw_label: `Piano ${plan}${remainingUsd != null ? ` · ~$${remainingUsd.toFixed(2)} residui` : ""}`,
      };
      base.exhaustion_risk = riskFromEur(remainingEur);
      base.recommended_action = remainingEur == null
        ? "Verifica usage sul portale."
        : remainingEur < 10 ? "Aumenta limite mensile o piano."
        : remainingEur < 25 ? "Considera upgrade nei prossimi giorni."
        : "Nessuna azione richiesta.";
    } else {
      base.connection_status = "error";
      base.error = `HTTP ${r.status}`;
    }
  } catch (e) {
    base.connection_status = "error";
    base.error = (e as Error).message.slice(0, 120);
  }
  return base;
}

function configOnly(opts: {
  key: string;
  name: string;
  envVar: string;
  category: ProviderCard["category"];
  billing_url: string;
  automation: AutomationKind;
  automation_label: string;
  hint_no_remote_balance?: boolean;
}): ProviderCard {
  const configured = !!Deno.env.get(opts.envVar);
  return {
    key: opts.key,
    name: opts.name,
    category: opts.category,
    configured,
    connection_status: configured ? "ok" : "error",
    credit_estimate: {
      value: null,
      unit: opts.category === "payments" ? "n/a" : "EUR",
      raw_label: opts.hint_no_remote_balance ? "Saldo non esposto via API — controlla dashboard provider" : undefined,
    },
    threshold_min_eur: opts.category === "payments" ? null : 25,
    usage_24h: { calls: null, cost_eur: null },
    usage_7d: { calls: null, cost_eur: null },
    exhaustion_risk: configured ? "ignoto" : "alto",
    recommended_action: configured
      ? "Apri il portale per saldo esatto e impostare alert."
      : `Configurare ${opts.envVar}.`,
    billing_url: opts.billing_url,
    automation: opts.automation,
    automation_label: opts.automation_label,
    last_check: now(),
  };
}

async function liveProbeOpenAI(card: ProviderCard) {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return;
  try {
    const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
    card.connection_status = r.ok ? "ok" : "error";
    if (!r.ok) card.error = `HTTP ${r.status}`;
  } catch (e) { card.connection_status = "error"; card.error = (e as Error).message.slice(0, 120); }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

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
    if (uErr || !userData.user) return json({ error: { code: "UNAUTHORIZED", message: "Auth non valida" } }, 401);

    const email = (userData.user.email ?? "").toLowerCase();
    const isOwner = ownerEmails().includes(email);
    let isAdmin = isOwner;
    if (!isAdmin) {
      const { data: role } = await supabase
        .from("user_roles").select("role").eq("user_id", userData.user.id).eq("role", "admin").maybeSingle();
      isAdmin = !!role;
    }
    if (!isAdmin) return json({ error: { code: "FORBIDDEN", message: "Solo admin/owner" } }, 403);

    const [firecrawl, apify] = await Promise.all([checkFirecrawl(), checkApify()]);

    const perplexity = configOnly({
      key: "perplexity", name: "Perplexity", envVar: "PERPLEXITY_API_KEY",
      category: "ai", billing_url: "https://www.perplexity.ai/settings/api",
      automation: "auto_reload", automation_label: "Automazione possibile (auto-reload sul portale)",
      hint_no_remote_balance: true,
    });
    const lovable = configOnly({
      key: "lovable", name: "Lovable AI Gateway", envVar: "LOVABLE_API_KEY",
      category: "platform", billing_url: "https://lovable.dev/settings/billing",
      automation: "managed", automation_label: "Gestito da Lovable Cloud",
      hint_no_remote_balance: true,
    });
    const openai = configOnly({
      key: "openai", name: "OpenAI", envVar: "OPENAI_API_KEY",
      category: "ai", billing_url: "https://platform.openai.com/account/billing/overview",
      automation: "auto_reload", automation_label: "Automazione possibile (auto-recharge configurabile)",
      hint_no_remote_balance: true,
    });
    await liveProbeOpenAI(openai);
    const anthropic = configOnly({
      key: "anthropic", name: "Anthropic", envVar: "ANTHROPIC_API_KEY",
      category: "ai", billing_url: "https://console.anthropic.com/settings/billing",
      automation: "auto_reload", automation_label: "Automazione possibile (auto-reload sul portale)",
      hint_no_remote_balance: true,
    });
    const googleMaps = configOnly({
      key: "google_maps", name: "Google Maps", envVar: "GOOGLE_MAPS_API_KEY",
      category: "maps", billing_url: "https://console.cloud.google.com/google/maps-apis/quotas",
      automation: "pay_per_call", automation_label: "Pay-per-call · imposta budget alert su GCP",
      hint_no_remote_balance: true,
    });
    const mapbox = configOnly({
      key: "mapbox", name: "Mapbox", envVar: "MAPBOX_API_KEY",
      category: "maps", billing_url: "https://account.mapbox.com/billing/",
      automation: "pay_per_call", automation_label: "Pay-per-call · imposta soft limit sul portale",
      hint_no_remote_balance: true,
    });
    const stripe = configOnly({
      key: "stripe", name: "Stripe", envVar: "STRIPE_SECRET_KEY",
      category: "payments", billing_url: "https://dashboard.stripe.com/settings/billing",
      automation: "managed", automation_label: "Nessun credito da monitorare (revenue, non spesa)",
    });

    const providers: ProviderCard[] = [firecrawl, apify, perplexity, lovable, openai, anthropic, googleMaps, mapbox, stripe];

    const summary = {
      total: providers.length,
      configured: providers.filter((p) => p.configured).length,
      missing: providers.filter((p) => !p.configured).length,
      risk_high: providers.filter((p) => p.exhaustion_risk === "alto").length,
      risk_medium: providers.filter((p) => p.exhaustion_risk === "medio").length,
      risk_unknown: providers.filter((p) => p.exhaustion_risk === "ignoto").length,
    };

    const alerts = providers
      .filter((p) => p.exhaustion_risk === "alto" || p.exhaustion_risk === "medio")
      .map((p) => ({
        level: p.exhaustion_risk === "alto" ? "red" : "yellow",
        provider: p.name,
        message: `Credito basso su ${p.name}. Consigliato ricaricare ${p.exhaustion_risk === "alto" ? "≥ 50€" : "≥ 25€"} o aumentare limite.`,
        action_url: p.billing_url,
      }));

    return json({ ok: true, checked_at: now(), summary, providers, alerts });
  } catch (e) {
    console.error("api-credits-status error:", e);
    return json({ error: { code: "INTERNAL", message: "Errore temporaneo" } }, 500);
  }
});
