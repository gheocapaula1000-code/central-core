-- ═══════════════════════════════════════════════════════════════
-- Checkpoint 11B-A — apertura core delle 8 zone ufficiali Civiko One
-- Nessuna migration precedente viene modificata: solo CREATE OR REPLACE.
-- Autorità slug: le 8 zone ufficiali (identiche a CIVIKO_COMMERCIAL_ZONES).
-- ═══════════════════════════════════════════════════════════════

-- Helper immutabile: whitelist ufficiale degli 8 slug.
CREATE OR REPLACE FUNCTION public.civiko_is_official_zone_slug(p_slug text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT btrim(coalesce(p_slug, '')) IN (
    'centro-storico',
    'nord-arcella',
    'est-brenta',
    'est-forcellini-camin',
    'sud-est-sant-osvaldo',
    'sud-voltabarozzo-guizza',
    'sud-ovest-mandria',
    'ovest-chiesanuova-brentelle'
  )
$function$;

REVOKE ALL ON FUNCTION public.civiko_is_official_zone_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.civiko_is_official_zone_slug(text) TO service_role;

-- ───────────────────────────────────────────────────────────────
-- 1) Prenotazione atomica trial 7gg — generalizzata alle 8 zone.
--    Nome interno invariato per compatibilità di chiamata.
--    Lock deterministici: ZONA → AGENZIA → UTENTE (stesso ordine
--    zona-prima-di-agenzia dell'attivazione pagata).
-- ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reserve_padova_pilot_zone_atomic(
  p_slug text,
  p_agency_id uuid,
  p_user_id uuid,
  p_user_email text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_slug text;
  v_zone public.civiko_commercial_zones%ROWTYPE;
  v_now timestamptz := now();
  v_until timestamptz;
  v_mem public.agency_memberships%ROWTYPE;
  v_mem_found boolean := false;
  v_other text;
  v_already boolean := false;
  v_status text;
  v_conflict uuid;
BEGIN
  v_slug := btrim(coalesce(p_slug, ''));
  IF v_slug = '' OR p_agency_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'parametri_non_validi');
  END IF;

  -- Fail-closed PRIMA di ogni scrittura: solo gli 8 slug ufficiali.
  IF NOT public.civiko_is_official_zone_slug(v_slug) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'zona_non_trovata');
  END IF;

  -- Lock deterministici: ZONA -> AGENZIA -> UTENTE.
  PERFORM pg_advisory_xact_lock(hashtextextended('civiko_zone:' || v_slug, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('civiko_agency:' || p_agency_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('civiko_zone_reserve_user:' || p_user_id::text, 0));

  SELECT * INTO v_zone
  FROM public.civiko_commercial_zones
  WHERE slug = v_slug
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'zona_non_trovata');
  END IF;

  -- === GATE MEMBERSHIP PRIMA DI QUALUNQUE SCRITTURA ===
  SELECT * INTO v_mem
  FROM public.agency_memberships
  WHERE agency_id = p_agency_id AND user_id = p_user_id
  FOR UPDATE;
  v_mem_found := FOUND;

  IF v_mem_found AND v_mem.role <> 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'membership_incompatibile');
  END IF;

  SELECT agency_id INTO v_conflict
  FROM public.agency_memberships
  WHERE user_id = p_user_id
    AND agency_id <> p_agency_id
    AND status = 'active'
  LIMIT 1;

  IF v_conflict IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'membership_incompatibile');
  END IF;
  -- === da qui in poi sono consentite le scritture ===

  IF v_zone.status = 'in_trial'
     AND (v_zone.trial_reserved_until IS NULL OR v_zone.trial_reserved_until <= v_now) THEN
    UPDATE public.civiko_commercial_zones
    SET status = 'disponibile', trial_agency_id = NULL, trial_reserved_until = NULL
    WHERE id = v_zone.id
    RETURNING * INTO v_zone;
  END IF;

  IF v_zone.status = 'occupata'
     AND v_zone.occupied_agency_id IS DISTINCT FROM p_agency_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'zona_occupata');
  END IF;

  IF v_zone.status = 'in_trial'
     AND v_zone.trial_reserved_until > v_now
     AND v_zone.trial_agency_id IS DISTINCT FROM p_agency_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'zona_in_trial');
  END IF;

  IF v_zone.status = 'occupata' AND v_zone.occupied_agency_id = p_agency_id THEN
    v_already := true;
    v_status := 'occupata';
  ELSIF v_zone.status = 'in_trial'
     AND v_zone.trial_agency_id = p_agency_id
     AND v_zone.trial_reserved_until > v_now THEN
    v_already := true;
    v_status := 'in_trial';
  END IF;

  IF NOT v_already THEN
    UPDATE public.civiko_commercial_zones
    SET status = 'disponibile', trial_agency_id = NULL, trial_reserved_until = NULL
    WHERE trial_agency_id = p_agency_id
      AND status = 'in_trial'
      AND (trial_reserved_until IS NULL OR trial_reserved_until <= v_now);

    SELECT slug INTO v_other
    FROM public.civiko_commercial_zones
    WHERE slug <> v_slug
      AND (
        (status = 'occupata' AND occupied_agency_id = p_agency_id)
        OR (status = 'in_trial' AND trial_agency_id = p_agency_id AND trial_reserved_until > v_now)
      )
    LIMIT 1;

    IF v_other IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'agency_ha_gia_zona');
    END IF;
  END IF;

  INSERT INTO public.agencies (id, name, billing_email, status, plan)
  VALUES (
    p_agency_id,
    coalesce(nullif(btrim(coalesce(p_user_email, '')), ''), 'Agenzia ' || left(p_agency_id::text, 8)),
    nullif(btrim(coalesce(p_user_email, '')), ''),
    'active',
    'civiko_one_trial'
  )
  ON CONFLICT (id) DO NOTHING;

  IF NOT v_mem_found THEN
    INSERT INTO public.agency_memberships (agency_id, user_id, role, status)
    VALUES (p_agency_id, p_user_id, 'owner', 'active');
  ELSIF v_mem.status <> 'active' THEN
    UPDATE public.agency_memberships
    SET status = 'active', updated_at = v_now
    WHERE id = v_mem.id;
  END IF;

  IF v_already THEN
    RETURN jsonb_build_object(
      'ok', true, 'already_mine', true, 'zona', v_slug,
      'status', v_status, 'trial_until', v_zone.trial_reserved_until
    );
  END IF;

  v_until := v_now + INTERVAL '7 days';

  UPDATE public.civiko_commercial_zones
  SET status = 'in_trial',
      trial_agency_id = p_agency_id,
      trial_reserved_until = v_until
  WHERE id = v_zone.id;

  RETURN jsonb_build_object(
    'ok', true, 'already_mine', false, 'zona', v_slug,
    'status', 'in_trial', 'trial_until', v_until
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_padova_pilot_zone_atomic(text, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_padova_pilot_zone_atomic(text, uuid, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_padova_pilot_zone_atomic(text, uuid, uuid, text) TO service_role;

-- ───────────────────────────────────────────────────────────────
-- 2) Attivazione pagata — generalizzata alle 8 zone ufficiali.
--    Invarianti 9E2-FINAL preservate: lock ZONA -> AGENZIA,
--    guardie cross-tenant customer/subscription, occupied_since stabile.
-- ───────────────────────────────────────────────────────────────
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
  v_slug text;
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

  v_slug := btrim(p_zone_slug);
  IF NOT public.civiko_is_official_zone_slug(v_slug) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ZONE_NOT_OFFICIAL', 'zone', v_slug);
  END IF;

  -- Lock deterministico: ZONA poi AGENZIA (identico in ogni percorso)
  PERFORM pg_advisory_xact_lock(hashtextextended('civiko_zone:' || v_slug, 0));
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
   WHERE slug = v_slug
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

  -- Un'agenzia = una zona: nessuna altra zona occupata dalla stessa agenzia.
  IF EXISTS (
    SELECT 1 FROM public.civiko_commercial_zones
     WHERE slug <> v_slug
       AND (occupied_agency_id = p_agency_id)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AGENCY_ALREADY_HAS_ZONE');
  END IF;

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

  INSERT INTO public.billing_subscriptions (
    agency_id, app_id, stripe_customer_id, stripe_subscription_id, status,
    price_id, plan_key, billing_interval, current_period_end, trial_end,
    cancel_at_period_end, zona_status, zona_assegnata
  ) VALUES (
    p_agency_id, p_app_id, btrim(p_stripe_customer_id), btrim(p_stripe_subscription_id),
    COALESCE(p_status, 'active'), p_price_id, p_plan_key, p_billing_interval,
    p_current_period_end, p_trial_end, COALESCE(p_cancel_at_period_end, false),
    'assegnata', v_slug
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
    zona_assegnata = v_slug,
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

REVOKE ALL ON FUNCTION public.civiko_activate_paid_zone_atomic(uuid, text, text, text, text, text, text, text, text, timestamptz, timestamptz, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.civiko_activate_paid_zone_atomic(uuid, text, text, text, text, text, text, text, text, timestamptz, timestamptz, boolean, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.civiko_activate_paid_zone_atomic(uuid, text, text, text, text, text, text, text, text, timestamptz, timestamptz, boolean, text) TO service_role;

-- ───────────────────────────────────────────────────────────────
-- 3) Liberazione zona su cancellazione — nessun riferimento pilot.
--    Ordine lock invariato: ZONA -> AGENZIA. Guardia superseded intatta.
-- ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.civiko_release_zone_on_cancel_atomic(p_stripe_subscription_id text)
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
BEGIN
  IF p_stripe_subscription_id IS NULL OR btrim(p_stripe_subscription_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SUBSCRIPTION_REQUIRED');
  END IF;

  SELECT agency_id, zona_assegnata INTO v_peek_agency, v_peek_zone
    FROM public.billing_subscriptions
   WHERE stripe_subscription_id = btrim(p_stripe_subscription_id);

  IF NOT EXISTS (
    SELECT 1 FROM public.billing_subscriptions
     WHERE stripe_subscription_id = btrim(p_stripe_subscription_id)
  ) THEN
    RETURN jsonb_build_object('ok', true, 'code', 'SUBSCRIPTION_UNKNOWN', 'released', false);
  END IF;

  -- Advisory lock ZONA poi AGENZIA (stesso ordine dell'attivazione).
  PERFORM pg_advisory_xact_lock(
    hashtextextended('civiko_zone:' || COALESCE(v_peek_zone, '__no_zone__'), 0)
  );
  IF v_peek_agency IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('civiko_agency:' || v_peek_agency::text, 0));
  END IF;

  SELECT * INTO v_sub
    FROM public.billing_subscriptions
   WHERE stripe_subscription_id = btrim(p_stripe_subscription_id)
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'code', 'SUBSCRIPTION_UNKNOWN', 'released', false);
  END IF;

  IF v_sub.agency_id IS DISTINCT FROM v_peek_agency
     OR v_sub.zona_assegnata IS DISTINCT FROM v_peek_zone THEN
    RETURN jsonb_build_object('ok', false, 'code', 'IDENTITY_CHANGED_RETRY', 'released', false);
  END IF;

  UPDATE public.billing_subscriptions
     SET status = 'canceled',
         zona_status = CASE WHEN v_sub.zona_assegnata IS NULL THEN zona_status ELSE 'liberata' END,
         updated_at = now()
   WHERE id = v_sub.id;

  IF v_sub.zona_assegnata IS NOT NULL AND v_sub.agency_id IS NOT NULL THEN
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

REVOKE ALL ON FUNCTION public.civiko_release_zone_on_cancel_atomic(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.civiko_release_zone_on_cancel_atomic(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.civiko_release_zone_on_cancel_atomic(text) TO service_role;