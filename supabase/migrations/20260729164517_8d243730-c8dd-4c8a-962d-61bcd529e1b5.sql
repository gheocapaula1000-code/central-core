CREATE OR REPLACE FUNCTION public.reserve_padova_pilot_zone_atomic(p_slug text, p_agency_id uuid, p_user_id uuid, p_user_email text DEFAULT NULL::text)
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
  v_other text;
  v_already boolean := false;
  v_status text;
  v_conflict uuid;
BEGIN
  v_slug := btrim(coalesce(p_slug, ''));
  IF v_slug = '' OR p_agency_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'parametri_non_validi');
  END IF;

  IF v_slug <> 'centro-storico' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'pilot_zone_locked');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('civiko_zone_reserve:' || p_agency_id::text, 0)
  );

  SELECT * INTO v_zone
  FROM public.civiko_commercial_zones
  WHERE slug = v_slug
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'zona_non_trovata');
  END IF;

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

  -- Coerenza membership: eseguita SEMPRE, anche nel retry idempotente.
  INSERT INTO public.agencies (id, name, billing_email, status, plan)
  VALUES (
    p_agency_id,
    coalesce(nullif(btrim(coalesce(p_user_email, '')), ''), 'Agenzia ' || left(p_agency_id::text, 8)),
    nullif(btrim(coalesce(p_user_email, '')), ''),
    'active',
    'civiko_one_trial'
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT * INTO v_mem
  FROM public.agency_memberships
  WHERE agency_id = p_agency_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    SELECT agency_id INTO v_conflict
    FROM public.agency_memberships
    WHERE user_id = p_user_id
      AND agency_id <> p_agency_id
      AND status = 'active'
    LIMIT 1;

    IF v_conflict IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'membership_incompatibile');
    END IF;

    INSERT INTO public.agency_memberships (agency_id, user_id, role, status)
    VALUES (p_agency_id, p_user_id, 'owner', 'active');
  ELSIF v_mem.role <> 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'membership_incompatibile');
  ELSIF v_mem.status <> 'active' THEN
    UPDATE public.agency_memberships
    SET status = 'active', updated_at = v_now
    WHERE id = v_mem.id;
  END IF;

  IF v_already THEN
    -- trial_until NON viene rinnovato.
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