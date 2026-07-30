-- ═══════════════════════════════════════════════════════════════
-- CHECKPOINT 9E2-FINAL — hardening concorrenza e retry
-- 1) release: ordine lock deterministico ZONA → AGENZIA (come activate)
-- 2) release: guardia "superseded" (subscription più recente attiva)
-- 3) activate: fail-closed su customer/subscription di altro tenant
-- 4) claim: stale after 5 minuti (allineato al contratto)
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.civiko_activate_paid_zone_atomic(
  p_agency_id uuid,
  p_zone_slug text,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_status text,
  p_price_id text DEFAULT NULL::text,
  p_plan_key text DEFAULT NULL::text,
  p_billing_interval text DEFAULT 'monthly'::text,
  p_email text DEFAULT NULL::text,
  p_current_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_trial_end timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_cancel_at_period_end boolean DEFAULT false,
  p_app_id text DEFAULT 'civiko_one'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_zone public.civiko_commercial_zones%ROWTYPE;
  v_pilot_slug constant text := 'centro-storico';
  v_owner_agency uuid;
  v_owner_app text;
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

  -- Lock deterministico: ZONA poi AGENZIA (identico in ogni percorso)
  PERFORM pg_advisory_xact_lock(hashtextextended('civiko_zone:' || v_pilot_slug, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('civiko_agency:' || p_agency_id::text, 0));

  -- ── Fail-closed identità Stripe: nessun trasferimento silenzioso ──
  SELECT agency_id, app_id INTO v_owner_agency, v_owner_app
    FROM public.billing_customers
   WHERE stripe_customer_id = btrim(p_stripe_customer_id)
   FOR UPDATE;

  IF v_owner_agency IS NOT NULL
     AND (v_owner_agency <> p_agency_id OR COALESCE(v_owner_app, '') <> COALESCE(p_app_id, '')) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_OWNED_BY_OTHER_TENANT');
  END IF;

  v_owner_agency := NULL;
  v_owner_app := NULL;
  SELECT agency_id, app_id INTO v_owner_agency, v_owner_app
    FROM public.billing_subscriptions
   WHERE stripe_subscription_id = btrim(p_stripe_subscription_id)
   FOR UPDATE;

  IF v_owner_agency IS NOT NULL
     AND (v_owner_agency <> p_agency_id OR COALESCE(v_owner_app, '') <> COALESCE(p_app_id, '')) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SUBSCRIPTION_OWNED_BY_OTHER_TENANT');
  END IF;

  SELECT * INTO v_zone
    FROM public.civiko_commercial_zones
   WHERE slug = v_pilot_slug
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ZONE_NOT_FOUND');
  END IF;

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

  IF EXISTS (
    SELECT 1 FROM public.civiko_commercial_zones
     WHERE slug <> v_pilot_slug
       AND (occupied_agency_id = p_agency_id)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AGENCY_ALREADY_HAS_ZONE');
  END IF;

  -- Customer Core (solo stesso tenant: verificato sopra)
  UPDATE public.billing_customers
     SET agency_id = p_agency_id,
         app_id = p_app_id,
         email = COALESCE(p_email, email),
         updated_at = now()
   WHERE stripe_customer_id = btrim(p_stripe_customer_id);

  IF NOT FOUND THEN
    INSERT INTO public.billing_customers (agency_id, app_id, stripe_customer_id, email)
    VALUES (p_agency_id, p_app_id, btrim(p_stripe_customer_id), p_email)
    ON CONFLICT (agency_id, app_id) DO UPDATE
      SET stripe_customer_id = EXCLUDED.stripe_customer_id,
          email = COALESCE(EXCLUDED.email, public.billing_customers.email),
          updated_at = now();
  END IF;

  -- Subscription Core (solo stesso tenant: verificato sopra)
  INSERT INTO public.billing_subscriptions (
    agency_id, app_id, stripe_customer_id, stripe_subscription_id, status,
    price_id, plan_key, billing_interval, current_period_end, trial_end,
    cancel_at_period_end, zona_status, zona_assegnata
  ) VALUES (
    p_agency_id, p_app_id, btrim(p_stripe_customer_id), btrim(p_stripe_subscription_id),
    COALESCE(p_status, 'active'), p_price_id, p_plan_key, p_billing_interval,
    p_current_period_end, p_trial_end, COALESCE(p_cancel_at_period_end, false),
    'assegnata', v_pilot_slug
  )
  ON CONFLICT (stripe_subscription_id) DO UPDATE SET
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
    updated_at = now()
  WHERE public.billing_subscriptions.agency_id = EXCLUDED.agency_id
    AND public.billing_subscriptions.app_id = EXCLUDED.app_id;

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
    'subscription_id', btrim(p_stripe_subscription_id)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.civiko_release_zone_on_cancel_atomic(
  p_stripe_subscription_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_peek_agency uuid;
  v_peek_zone text;
  v_sub public.billing_subscriptions%ROWTYPE;
  v_zone public.civiko_commercial_zones%ROWTYPE;
  v_released boolean := false;
  v_superseded boolean := false;
  v_pilot_slug constant text := 'centro-storico';
BEGIN
  IF p_stripe_subscription_id IS NULL OR btrim(p_stripe_subscription_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SUBSCRIPTION_REQUIRED');
  END IF;

  -- 1) Lettura preliminare SENZA lock di riga (solo per calcolare le chiavi di lock)
  SELECT agency_id, zona_assegnata INTO v_peek_agency, v_peek_zone
    FROM public.billing_subscriptions
   WHERE stripe_subscription_id = btrim(p_stripe_subscription_id);

  IF v_peek_agency IS NULL AND v_peek_zone IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.billing_subscriptions
     WHERE stripe_subscription_id = btrim(p_stripe_subscription_id)
  ) THEN
    RETURN jsonb_build_object('ok', true, 'code', 'SUBSCRIPTION_UNKNOWN', 'released', false);
  END IF;

  -- 2) Advisory lock ZONA poi AGENZIA (stesso ordine dell'attivazione)
  PERFORM pg_advisory_xact_lock(hashtextextended('civiko_zone:' || COALESCE(v_peek_zone, v_pilot_slug), 0));
  IF v_peek_agency IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('civiko_agency:' || v_peek_agency::text, 0));
  END IF;

  -- 3) Rilettura + lock di riga della subscription
  SELECT * INTO v_sub
    FROM public.billing_subscriptions
   WHERE stripe_subscription_id = btrim(p_stripe_subscription_id)
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'code', 'SUBSCRIPTION_UNKNOWN', 'released', false);
  END IF;

  -- 4) Rivalidazione post-lock: se agency/zona sono cambiate, non procedere
  IF v_sub.agency_id IS DISTINCT FROM v_peek_agency
     OR v_sub.zona_assegnata IS DISTINCT FROM v_peek_zone THEN
    RETURN jsonb_build_object('ok', false, 'code', 'IDENTITY_CHANGED_RETRY', 'released', false);
  END IF;

  -- 5) Marca cancellata la subscription (idempotente)
  UPDATE public.billing_subscriptions
     SET status = 'canceled',
         zona_status = CASE WHEN v_sub.zona_assegnata IS NULL THEN zona_status ELSE 'liberata' END,
         updated_at = now()
   WHERE id = v_sub.id;

  IF v_sub.zona_assegnata IS NOT NULL AND v_sub.agency_id IS NOT NULL THEN
    -- 6) Guardia superseded: esiste altra subscription attiva della stessa
    --    agenzia sulla stessa zona? Allora la zona NON si tocca.
    IF EXISTS (
      SELECT 1 FROM public.billing_subscriptions s
       WHERE s.id <> v_sub.id
         AND s.agency_id = v_sub.agency_id
         AND s.zona_assegnata = v_sub.zona_assegnata
         AND s.status IN ('active', 'trialing')
    ) THEN
      v_superseded := true;
    ELSE
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

    -- La subscription superseded non deve risultare "liberata" sulla zona viva
    IF v_superseded THEN
      UPDATE public.billing_subscriptions
         SET zona_status = 'superseded', updated_at = now()
       WHERE id = v_sub.id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'released', v_released,
    'superseded', v_superseded,
    'zone', v_sub.zona_assegnata,
    'agency_id', v_sub.agency_id
  );
END;
$function$;

-- Stale claim allineato al contratto: 5 minuti
CREATE OR REPLACE FUNCTION public.stripe_webhook_event_claim(
  p_event_id text,
  p_type text,
  p_stale_after interval DEFAULT '00:05:00'::interval
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public.civiko_activate_paid_zone_atomic(uuid, text, text, text, text, text, text, text, text, timestamptz, timestamptz, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.civiko_release_zone_on_cancel_atomic(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stripe_webhook_event_claim(text, text, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.civiko_activate_paid_zone_atomic(uuid, text, text, text, text, text, text, text, text, timestamptz, timestamptz, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.civiko_release_zone_on_cancel_atomic(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.stripe_webhook_event_claim(text, text, interval) TO service_role;