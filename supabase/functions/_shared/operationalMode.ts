// Operational mode helper.
//
// Modalita' "test_intensive": cron pesanti girano ogni notte, cap mensile $100,
// cap giornalieri larghi. Si attiva manualmente per N giorni e poi
// rientra automaticamente in "saving" tramite checkAndExpireTestMode().
//
// Modalita' "saving": cron pesanti girano ogni N giorni (default 3),
// cap mensile $50, cap giornalieri stretti.
//
// Lo stato vive in public.operational_mode (singleton id=1).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export type OperationalMode = {
  mode: "test_intensive" | "saving";
  test_started_at: string | null;
  test_ends_at: string | null;
  monthly_cap_usd: number;
  firecrawl_daily_cap_credits: number;
  ai_daily_cap_usd: number;
  heavy_cron_every_n_days: number;
};

const DEFAULTS: OperationalMode = {
  mode: "saving",
  test_started_at: null,
  test_ends_at: null,
  monthly_cap_usd: 50,
  firecrawl_daily_cap_credits: 2000,
  ai_daily_cap_usd: 0.2,
  heavy_cron_every_n_days: 3,
};

function sb() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Cache 60s per ridurre round-trip a DB nelle funzioni hot.
let _cache: { ts: number; data: OperationalMode } | null = null;

export async function getOperationalMode(): Promise<OperationalMode> {
  if (_cache && Date.now() - _cache.ts < 60_000) return _cache.data;
  const c = sb();
  if (!c) return DEFAULTS;
  const { data } = await c.from("operational_mode").select("*").eq("id", 1).maybeSingle();
  if (!data) return DEFAULTS;
  const out = data as OperationalMode;
  _cache = { ts: Date.now(), data: out };
  return out;
}

/** Auto-rientra in saving se test_ends_at e' passato. Idempotente. */
export async function checkAndExpireTestMode(): Promise<{ expired: boolean; mode: string }> {
  const c = sb();
  if (!c) return { expired: false, mode: "unknown" };
  const m = await getOperationalMode();
  if (m.mode !== "test_intensive") return { expired: false, mode: m.mode };
  if (!m.test_ends_at) return { expired: false, mode: m.mode };
  if (new Date(m.test_ends_at).getTime() > Date.now()) {
    return { expired: false, mode: m.mode };
  }
  await c.from("operational_mode").update({
    mode: "saving",
    monthly_cap_usd: 50,
    firecrawl_daily_cap_credits: 2000,
    ai_daily_cap_usd: 0.2,
    heavy_cron_every_n_days: 3,
    updated_at: new Date().toISOString(),
  }).eq("id", 1);
  await c.from("cron_alerts_pending").insert({
    severity: "info",
    message:
      "Test intensivo 7 giorni terminato. Rientrato in modalita' risparmio (cron pesante ogni 3 giorni, cap mensile $50).",
    source: "operational_mode_expiry",
  });
  _cache = null;
  return { expired: true, mode: "saving" };
}
