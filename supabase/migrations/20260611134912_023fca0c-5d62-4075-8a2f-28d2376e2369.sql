
-- Add zona fields for Civiko One exclusive zone management
ALTER TABLE public.billing_subscriptions
  ADD COLUMN IF NOT EXISTS zona_status text NOT NULL DEFAULT 'in_attesa',
  ADD COLUMN IF NOT EXISTS zona_assegnata text,
  ADD COLUMN IF NOT EXISTS billing_interval text;

-- Idempotency table for Stripe webhook events
CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.stripe_webhook_events TO authenticated;
GRANT ALL ON public.stripe_webhook_events TO service_role;

ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access_stripe_events"
  ON public.stripe_webhook_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
