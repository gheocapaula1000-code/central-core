
-- =====================================================
-- TEST INTENSIVO 7 GIORNI + AUTO-RIENTRO MODALITA' RISPARMIO
-- =====================================================

-- 1) Spese giornaliere Firecrawl
CREATE TABLE IF NOT EXISTS public.firecrawl_spend_daily (
  day_utc date PRIMARY KEY,
  calls int NOT NULL DEFAULT 0,
  pages int NOT NULL DEFAULT 0,
  est_usd numeric(10,3) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.firecrawl_spend_daily TO authenticated;
GRANT ALL ON public.firecrawl_spend_daily TO service_role;
ALTER TABLE public.firecrawl_spend_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role manages firecrawl spend" ON public.firecrawl_spend_daily;
CREATE POLICY "service role manages firecrawl spend" ON public.firecrawl_spend_daily
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated read firecrawl spend" ON public.firecrawl_spend_daily;
CREATE POLICY "authenticated read firecrawl spend" ON public.firecrawl_spend_daily
  AS PERMISSIVE FOR SELECT TO authenticated USING (true);

-- 2) Spese giornaliere AI
CREATE TABLE IF NOT EXISTS public.ai_spend_daily (
  day_utc date NOT NULL,
  provider text NOT NULL CHECK (provider IN ('openai','anthropic','perplexity','lovable')),
  calls int NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  est_usd numeric(10,4) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day_utc, provider)
);
GRANT SELECT ON public.ai_spend_daily TO authenticated;
GRANT ALL ON public.ai_spend_daily TO service_role;
ALTER TABLE public.ai_spend_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role manages ai spend" ON public.ai_spend_daily;
CREATE POLICY "service role manages ai spend" ON public.ai_spend_daily
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated read ai spend" ON public.ai_spend_daily;
CREATE POLICY "authenticated read ai spend" ON public.ai_spend_daily
  AS PERMISSIVE FOR SELECT TO authenticated USING (true);

-- 3) Modalita' operativa (singleton)
CREATE TABLE IF NOT EXISTS public.operational_mode (
  id int PRIMARY KEY DEFAULT 1,
  mode text NOT NULL CHECK (mode IN ('test_intensive','saving')) DEFAULT 'test_intensive',
  test_started_at timestamptz,
  test_ends_at timestamptz,
  monthly_cap_usd numeric(10,2) NOT NULL DEFAULT 100,
  firecrawl_daily_cap_credits int NOT NULL DEFAULT 5000,
  ai_daily_cap_usd numeric(10,2) NOT NULL DEFAULT 0.50,
  heavy_cron_every_n_days int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operational_mode_singleton CHECK (id = 1)
);
GRANT SELECT ON public.operational_mode TO authenticated;
GRANT ALL ON public.operational_mode TO service_role;
ALTER TABLE public.operational_mode ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role manages operational mode" ON public.operational_mode;
CREATE POLICY "service role manages operational mode" ON public.operational_mode
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated read operational mode" ON public.operational_mode;
CREATE POLICY "authenticated read operational mode" ON public.operational_mode
  AS PERMISSIVE FOR SELECT TO authenticated USING (true);

-- 4) Alert pendenti (per watchdog -> dashboard / notifiche future)
CREATE TABLE IF NOT EXISTS public.cron_alerts_pending (
  id bigserial PRIMARY KEY,
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')) DEFAULT 'info',
  message text NOT NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);
GRANT SELECT ON public.cron_alerts_pending TO authenticated;
GRANT ALL ON public.cron_alerts_pending TO service_role;
ALTER TABLE public.cron_alerts_pending ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role manages cron alerts" ON public.cron_alerts_pending;
CREATE POLICY "service role manages cron alerts" ON public.cron_alerts_pending
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated read cron alerts" ON public.cron_alerts_pending;
CREATE POLICY "authenticated read cron alerts" ON public.cron_alerts_pending
  AS PERMISSIVE FOR SELECT TO authenticated USING (true);

-- 5) Stato iniziale: test_intensive per 7 giorni
INSERT INTO public.operational_mode
  (id, mode, test_started_at, test_ends_at, monthly_cap_usd, firecrawl_daily_cap_credits, ai_daily_cap_usd, heavy_cron_every_n_days)
VALUES
  (1, 'test_intensive', now(), now() + interval '7 days', 100, 5000, 0.50, 1)
ON CONFLICT (id) DO UPDATE SET
  mode = 'test_intensive',
  test_started_at = now(),
  test_ends_at = now() + interval '7 days',
  monthly_cap_usd = 100,
  firecrawl_daily_cap_credits = 5000,
  ai_daily_cap_usd = 0.50,
  heavy_cron_every_n_days = 1,
  updated_at = now();

-- 6) Vista aggregata mese corrente (USD)
--    Apify baseline 29 USD/mese + Firecrawl baseline 19 USD/mese + AI variabile.
CREATE OR REPLACE VIEW public.total_spend_current_month AS
SELECT
  date_trunc('month', now() AT TIME ZONE 'UTC')::date AS month_start,
  29.0 + COALESCE((
    SELECT SUM(est_usd) FROM public.apify_spend_daily
    WHERE day_utc >= date_trunc('month', now() AT TIME ZONE 'UTC')::date
  ), 0) AS apify_usd,
  19.0 + COALESCE((
    SELECT SUM(est_usd) FROM public.firecrawl_spend_daily
    WHERE day_utc >= date_trunc('month', now() AT TIME ZONE 'UTC')::date
  ), 0) AS firecrawl_usd,
  COALESCE((
    SELECT SUM(est_usd) FROM public.ai_spend_daily
    WHERE day_utc >= date_trunc('month', now() AT TIME ZONE 'UTC')::date
  ), 0) AS ai_usd;

GRANT SELECT ON public.total_spend_current_month TO authenticated, service_role;
