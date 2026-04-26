-- ── billing_customers ─────────────────────────────────────────
CREATE TABLE public.billing_customers (
  id BIGSERIAL PRIMARY KEY,
  agency_id UUID NOT NULL,
  app_id TEXT NOT NULL DEFAULT 'civiko_one',
  stripe_customer_id TEXT NOT NULL,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agency_id, app_id),
  UNIQUE (stripe_customer_id)
);
ALTER TABLE public.billing_customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agency_read_own_customer" ON public.billing_customers
  FOR SELECT TO authenticated USING (agency_id = auth.uid());
CREATE POLICY "service_role_full_billing_customers" ON public.billing_customers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── billing_subscriptions ─────────────────────────────────────
CREATE TABLE public.billing_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  agency_id UUID NOT NULL,
  app_id TEXT NOT NULL DEFAULT 'civiko_one',
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  plan_key TEXT,
  price_id TEXT,
  current_period_end TIMESTAMPTZ,
  trial_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_billing_subs_agency_app ON public.billing_subscriptions (agency_id, app_id);
ALTER TABLE public.billing_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agency_read_own_subscription" ON public.billing_subscriptions
  FOR SELECT TO authenticated USING (agency_id = auth.uid());
CREATE POLICY "service_role_full_billing_subs" ON public.billing_subscriptions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── billing_usage ─────────────────────────────────────────────
CREATE TABLE public.billing_usage (
  id BIGSERIAL PRIMARY KEY,
  agency_id UUID NOT NULL,
  app_id TEXT NOT NULL DEFAULT 'civiko_one',
  period_key TEXT NOT NULL,
  scans_used INTEGER NOT NULL DEFAULT 0,
  owner_reports_used INTEGER NOT NULL DEFAULT 0,
  piano_esclusiva_used INTEGER NOT NULL DEFAULT 0,
  zona_in_movimento_used INTEGER NOT NULL DEFAULT 0,
  hyperlocal_signals_used INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agency_id, app_id, period_key)
);
ALTER TABLE public.billing_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agency_read_own_usage" ON public.billing_usage
  FOR SELECT TO authenticated USING (agency_id = auth.uid());
CREATE POLICY "service_role_full_billing_usage" ON public.billing_usage
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── billing_entitlements ──────────────────────────────────────
CREATE TABLE public.billing_entitlements (
  id BIGSERIAL PRIMARY KEY,
  plan_key TEXT NOT NULL,
  app_id TEXT NOT NULL DEFAULT 'civiko_one',
  monthly_scans INTEGER,
  monthly_owner_reports INTEGER,
  monthly_piano_esclusiva INTEGER,
  team_seats INTEGER,
  allow_hyperlocal_signals BOOLEAN NOT NULL DEFAULT true,
  allow_local_buzz BOOLEAN NOT NULL DEFAULT false,
  allow_pdf_export BOOLEAN NOT NULL DEFAULT false,
  allow_white_label BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plan_key, app_id)
);
ALTER TABLE public.billing_entitlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_entitlements" ON public.billing_entitlements
  FOR SELECT TO public USING (true);
CREATE POLICY "service_role_full_entitlements" ON public.billing_entitlements
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── triggers (reuse civiko_touch_updated_at) ──────────────────
CREATE TRIGGER trg_billing_customers_updated
  BEFORE UPDATE ON public.billing_customers
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();
CREATE TRIGGER trg_billing_subs_updated
  BEFORE UPDATE ON public.billing_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();
CREATE TRIGGER trg_billing_usage_updated
  BEFORE UPDATE ON public.billing_usage
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();
CREATE TRIGGER trg_billing_entitlements_updated
  BEFORE UPDATE ON public.billing_entitlements
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();

-- ── seed entitlements for Civiko One plans ────────────────────
INSERT INTO public.billing_entitlements
  (plan_key, app_id, monthly_scans, monthly_owner_reports, monthly_piano_esclusiva, team_seats,
   allow_hyperlocal_signals, allow_local_buzz, allow_pdf_export, allow_white_label)
VALUES
  ('civiko_studio', 'civiko_one',  30,  10,  10, 1, true,  false, false, false),
  ('civiko_pro',    'civiko_one', 150,  60,  60, 3, true,  true,  true,  false),
  ('civiko_elite',  'civiko_one', NULL, NULL, NULL, 10, true, true,  true,  true);
