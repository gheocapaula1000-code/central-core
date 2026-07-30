-- ═══════════════════════════════════════════════════════════════
-- CHECKPOINT 9E2 — Zona pagata automatica e transazionale
-- ═══════════════════════════════════════════════════════════════

-- ── 1. stripe_webhook_events → macchina di stato ritentabile ──
ALTER TABLE public.stripe_webhook_events
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'processed',
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.stripe_webhook_events
  ALTER COLUMN processed_at DROP NOT NULL;

ALTER TABLE public.stripe_webhook_events
  ALTER COLUMN processed_at SET DEFAULT NULL;

-- Eventi legacy: già completati
UPDATE public.stripe_webhook_events
   SET status = 'processed'
 WHERE status IS DISTINCT FROM 'processed'
   AND processed_at IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.stripe_webhook_events'::regclass
       AND conname = 'stripe_webhook_events_status_chk'
  ) THEN
    ALTER TABLE public.stripe_webhook_events
      ADD CONSTRAINT stripe_webhook_events_status_chk
      CHECK (status IN ('processing', 'processed', 'failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS stripe_webhook_events_status_idx
  ON public.stripe_webhook_events (status, claimed_at);

ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_webhook_events FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.stripe_webhook_events FROM PUBLIC;
REVOKE ALL ON public.stripe_webhook_events FROM anon;
REVOKE ALL ON public.stripe_webhook_events FROM authenticated;
GRANT ALL ON public.stripe_webhook_events TO service_role;

-- ── 2. Claim atomico ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stripe_webhook_event_claim(
  p_event_id text,
  p_type text,
  p_stale_after interval DEFAULT interval '15 minutes'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.stripe_webhook_events%ROWTYPE;
BEGIN
  IF p_event_id IS NULL OR btrim(p_event_id) = '' THEN
    RAISE EXCEPTION 'p_event_id is required';
  END IF;

  INSERT INTO public.stripe_webhook_events (id, type, status, claimed_at, attempts, processed_at)
  VALUES (p_event_id, COALESCE(p_type, 'unknown'), 'processing', now(), 1, NULL)
  ON CONFLICT (id) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('claimed', true, 'attempts', v_row.attempts, 'fresh', true);
  END IF;

  -- Riacquisizione: failed oppure processing stale
  UPDATE public.stripe_webhook_events
     SET status = 'processing',
         claimed_at = now(),
         attempts = attempts + 1,
         updated_at = now()
   WHERE id = p_event_id
     AND status <> 'processed'
     AND (status = 'failed' OR claimed_at IS NULL OR claimed_at < now() - p_stale_after)
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('claimed', true, 'attempts', v_row.attempts, 'fresh', false);
  END IF;

  SELECT * INTO v_row FROM public.stripe_webhook_events WHERE id = p_event_id;
  RETURN jsonb_build_object(
    'claimed', false,
    'status', COALESCE(v_row.status, 'unknown'),
    'attempts', COALESCE(v_row.attempts, 0)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.stripe_webhook_event_mark_processed(p_event_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.stripe_webhook_events
     SET status = 'processed',
         processed_at = now(),
         last_error = NULL,
         updated_at = now()
   WHERE id = p_event_id;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.stripe_webhook_event_mark_failed(
  p_event_id text,
  p_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.stripe_webhook_events
     SET status = 'failed',
         processed_at = NULL,
         last_error = left(COALESCE(p_error, 'unknown'), 500),
         updated_at = now()
   WHERE id = p_event_id
     AND status <> 'processed';
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.stripe_webhook_event_claim(text, text, interval) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stripe_webhook_event_mark_processed(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stripe_webhook_event_mark_failed(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stripe_webhook_event_claim(text, text, interval) TO service_role;
GRANT EXECUTE ON FUNCTION public.stripe_webhook_event_mark_processed(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.stripe_webhook_event_mark_failed(text, text) TO service_role;

-- ── 3. Attivazione pagamento: transazionale e idempotente ────
CREATE OR REPLACE FUNCTION public.civiko_activate_paid_zone_atomic(
  p_agency_id uuid,
  p_zone_slug text,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_status text,
  p_price_id text DEFAULT NULL,
  p_plan_key text DEFAULT NULL,
  p_billing_interval text DEFAULT 'monthly',
  p_email text DEFAULT NULL,
  p_current_period_end timestamptz DEFAULT NULL,
  p_trial_end timestamptz DEFAULT NULL,
  p_cancel_at_period_end boolean DEFAULT false,
  p_app_id text DEFAULT 'civiko_one'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_zone public.civiko_commercial_zones%ROWTYPE;
  v_pilot_slug constant text := 'centro-storico';
BEGIN
  IF p_agency_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AGENCY_REQUIRED');
  END IF;
  IF p_stripe_customer_id IS NULL OR btrim(p_stripe_customer_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_REQUIRED');
  END IF;
  IF p_stripe_subscription_id IS NULL OR btrim(p_stripe_subscription_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SUBSCRIPTION_REQUIRED');
  END IF;
  IF p_zone_slug IS NULL OR btrim(p_zone_slug) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ZONE_REQUIRED');
  END IF;
  IF btrim(p_zone_slug) <> v_pilot_slug THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ZONE_NOT_IN_PILOT', 'zone', p_zone_slug);
  END IF;

  -- Lock deterministico su agenzia e zona
  PERFORM pg_advisory_xact_lock(hashtextextended('civiko_zone:' || v_pilot_slug, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('civiko_agency:' || p_agency_id::text, 0));

  SELECT * INTO v_zone
    FROM public.civiko_commercial_zones
   WHERE slug = v_pilot_slug
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ZONE_NOT_FOUND');
  END IF;

  -- Zona valida solo se in_trial della stessa agenzia oppure già occupata dalla stessa agenzia
  IF v_zone.occupied_agency_id IS NOT NULL AND v_zone.occupied_agency_id <> p_agency_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ZONE_OCCUPIED_BY_OTHER');
  END IF;

  IF v_zone.occupied_agency_id IS NULL THEN
    IF v_zone.status = 'in_trial' AND v_zone.trial_agency_id IS DISTINCT FROM p_agency_id THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ZONE_TRIAL_OF_OTHER');
    END IF;
    IF v_zone.status = 'disponibile' AND v_zone.trial_agency_id IS NOT NULL
       AND v_zone.trial_agency_id <> p_agency_id THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ZONE_TRIAL_OF_OTHER');
    END IF;
    IF v_zone.status NOT IN ('in_trial', 'disponibile') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ZONE_STATE_INVALID', 'status', v_zone.status);
    END IF;
  END IF;

  -- Un'agenzia = una zona: nessun'altra zona può risultare sua
  IF EXISTS (
    SELECT 1 FROM public.civiko_commercial_zones
     WHERE slug <> v_pilot_slug
       AND (occupied_agency_id = p_agency_id)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AGENCY_ALREADY_HAS_ZONE');
  END IF;

  -- Customer Core
  UPDATE public.billing_customers
     SET agency_id = p_agency_id,
         app_id = p_app_id,
         email = COALESCE(p_email, email),
         updated_at = now()
   WHERE stripe_customer_id = p_stripe_customer_id;

  IF NOT FOUND THEN
    INSERT INTO public.billing_customers (agency_id, app_id, stripe_customer_id, email)
    VALUES (p_agency_id, p_app_id, p_stripe_customer_id, p_email)
    ON CONFLICT (agency_id, app_id) DO UPDATE
      SET stripe_customer_id = EXCLUDED.stripe_customer_id,
          email = COALESCE(EXCLUDED.email, public.billing_customers.email),
          updated_at = now();
  END IF;

  -- Subscription Core
  INSERT INTO public.billing_subscriptions (
    agency_id, app_id, stripe_customer_id, stripe_subscription_id, status,
    price_id, plan_key, billing_interval, current_period_end, trial_end,
    cancel_at_period_end, zona_status, zona_assegnata
  ) VALUES (
    p_agency_id, p_app_id, p_stripe_customer_id, p_stripe_subscription_id,
    COALESCE(p_status, 'active'), p_price_id, p_plan_key, p_billing_interval,
    p_current_period_end, p_trial_end, COALESCE(p_cancel_at_period_end, false),
    'assegnata', v_pilot_slug
  )
  ON CONFLICT (stripe_subscription_id) DO UPDATE SET
    agency_id = EXCLUDED.agency_id,
    app_id = EXCLUDED.app_id,
    stripe_customer_id = EXCLUDED.stripe_customer_id,
    status = EXCLUDED.status,
    price_id = COALESCE(EXCLUDED.price_id, public.billing_subscriptions.price_id),
    plan_key = COALESCE(EXCLUDED.plan_key, public.billing_subscriptions.plan_key),
    billing_interval = COALESCE(EXCLUDED.billing_interval, public.billing_subscriptions.billing_interval),
    current_period_end = EXCLUDED.current_period_end,
    trial_end = EXCLUDED.trial_end,
    cancel_at_period_end = EXCLUDED.cancel_at_period_end,
    zona_status = 'assegnata',
    zona_assegnata = v_pilot_slug,
    updated_at = now();

  -- Zona → occupata (occupied_since invariato nei retry)
  UPDATE public.civiko_commercial_zones
     SET status = 'occupata',
         occupied_agency_id = p_agency_id,
         occupied_since = COALESCE(occupied_since, now()),
         agency_id = p_agency_id,
         trial_agency_id = NULL,
         trial_reserved_until = NULL
   WHERE id = v_zone.id
  RETURNING * INTO v_zone;

  RETURN jsonb_build_object(
    'ok', true,
    'zone', v_zone.slug,
    'zone_status', v_zone.status,
    'occupied_agency_id', v_zone.occupied_agency_id,
    'occupied_since', v_zone.occupied_since,
    'subscription_id', p_stripe_subscription_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.civiko_activate_paid_zone_atomic(uuid, text, text, text, text, text, text, text, text, timestamptz, timestamptz, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.civiko_activate_paid_zone_atomic(uuid, text, text, text, text, text, text, text, text, timestamptz, timestamptz, boolean, text) TO service_role;

-- ── 4. Cancellazione: transazionale e idempotente ────────────
CREATE OR REPLACE FUNCTION public.civiko_release_zone_on_cancel_atomic(
  p_stripe_subscription_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub public.billing_subscriptions%ROWTYPE;
  v_zone public.civiko_commercial_zones%ROWTYPE;
  v_released boolean := false;
BEGIN
  IF p_stripe_subscription_id IS NULL OR btrim(p_stripe_subscription_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SUBSCRIPTION_REQUIRED');
  END IF;

  SELECT * INTO v_sub
    FROM public.billing_subscriptions
   WHERE stripe_subscription_id = p_stripe_subscription_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'code', 'SUBSCRIPTION_UNKNOWN', 'released', false);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('civiko_agency:' || v_sub.agency_id::text, 0));

  UPDATE public.billing_subscriptions
     SET status = 'canceled',
         zona_status = 'liberata',
         updated_at = now()
   WHERE id = v_sub.id;

  IF v_sub.zona_assegnata IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('civiko_zone:' || v_sub.zona_assegnata, 0));

    SELECT * INTO v_zone
      FROM public.civiko_commercial_zones
     WHERE slug = v_sub.zona_assegnata
     FOR UPDATE;

    IF FOUND AND v_zone.occupied_agency_id IS NOT NULL
       AND v_zone.occupied_agency_id = v_sub.agency_id THEN
      UPDATE public.civiko_commercial_zones
         SET status = 'disponibile',
             occupied_agency_id = NULL,
             occupied_since = NULL,
             agency_id = NULL,
             trial_agency_id = NULL,
             trial_reserved_until = NULL
       WHERE id = v_zone.id;
      v_released := true;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'released', v_released,
    'zone', v_sub.zona_assegnata,
    'agency_id', v_sub.agency_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.civiko_release_zone_on_cancel_atomic(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.civiko_release_zone_on_cancel_atomic(text) TO service_role;