
CREATE TABLE IF NOT EXISTS public.apify_spend_daily (
  day_utc date PRIMARY KEY,
  calls integer NOT NULL DEFAULT 0,
  est_usd numeric(10,3) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.apify_spend_daily TO authenticated;
GRANT ALL ON public.apify_spend_daily TO service_role;
ALTER TABLE public.apify_spend_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role manages apify spend" ON public.apify_spend_daily;
CREATE POLICY "service role manages apify spend" ON public.apify_spend_daily
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated read apify spend" ON public.apify_spend_daily;
CREATE POLICY "authenticated read apify spend" ON public.apify_spend_daily
  FOR SELECT TO authenticated USING (true);
