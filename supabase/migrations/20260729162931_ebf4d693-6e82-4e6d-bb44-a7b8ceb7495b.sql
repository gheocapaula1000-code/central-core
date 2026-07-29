CREATE OR REPLACE FUNCTION public.reserve_padova_pilot_zone_atomic(
  p_slug text,
  p_agency_id uuid,
  p_user_id uuid,
  p_user_email text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_slug text;
  v_zone public.civiko_commercial_zones%ROWTYPE;
  v_now timestamptz := now();
  v_until timestamptz;
  v_mem public.agency_memberships%ROWTYPE;
  v_other text;
BEGIN
  -- 1) Validazione fail-closed dei parametri (nessuna scrittura prima di qui)
  v_slug := btrim(coalesce(p_slug, ''));
  IF v_slug = '' OR p_agency_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'parametri_non_validi');
  END IF;

  -- 2) Gate territoriale Padova Pilot v1: solo centro-storico
  IF v_slug <> 'centro-storico' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'pilot_zone_locked');
  END IF;

  -- 3) Lock deterministico sull'agenzia: due richieste concorrenti della
  --    stessa agenzia vengono serializzate anche su zone diverse.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('civiko_zone_reserve', 0),
    hashtextextended(p_agency_id::text, 0)
  );

  -- 4) Lock della riga zona richiesta
  SELECT * INTO v_zone
  FROM public.civiko_commercial_zones
  WHERE slug = v_slug
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'zona_non_trovata');
  END IF;

  -- 5) Normalizzazione limitata: solo la zona richiesta se il trial è scaduto
  IF v_zone.status = 'in_trial'
     AND (v_zone.trial_reserved_until IS NULL OR v_zone.trial_reserved_until <= v_now) THEN
    UPDATE public.civiko_commercial_zones
    SET status = 'disponibile', trial_agency_id = NULL, trial_reserved_until = NULL
    WHERE id = v_zone.id
    RETURNING * INTO v_zone;
  END IF;

  -- 6) Conflitti con altre agenzie (zero mutazioni)
  IF v_zone.status = 'occupata'
     AND v_zone.occupied_agency_id IS DISTINCT FROM p_agency_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'zona_occupata');
  END IF;

  IF v_zone.status = 'in_trial'
     AND v_zone.trial_reserved_until > v_now
     AND v_zone.trial_agency_id IS DISTINCT FROM p_agency_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'zona_in_trial');
  END IF;

  -- 7) Successo idempotente: la zona è già della stessa agenzia
  IF v_zone.status = 'occupata' AND v_zone.occupied_agency_id = p_agency_id THEN
    RETURN jsonb_build_object(
      'ok', true, 'already_mine', true, 'zona', v_slug,
      'status', 'occupata', 'trial_until', v_zone.trial_reserved_until
    );
  END IF;

  IF v_zone.status = 'in_trial'
     AND v_zone.trial_agency_id = p_agency_id
     AND v_zone.trial_reserved_until > v_now THEN
    RETURN jsonb_build_object(
      'ok', true, 'already_mine', true, 'zona', v_slug,
      'status', 'in_trial', 'trial_until', v_zone.trial_reserved_until
    );
  END IF;

  -- 8) Altra zona attiva già appartenente alla stessa agenzia.
  --    I trial scaduti della stessa agenzia vengono normalizzati prima,
  --    così non producono mai agency_ha_gia_zona.
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

  -- 9) Nessun conflitto: crea agenzia e membership, poi prenota.
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
    INSERT INTO public.agency_memberships (agency_id, user_id, role, status)
    VALUES (p_agency_id, p_user_id, 'owner', 'active');
  ELSIF v_mem.role <> 'owner' THEN
    -- Fail-closed: nessuna promozione silenziosa di ruolo.
    RETURN jsonb_build_object('ok', false, 'error', 'membership_incompatibile');
  ELSIF v_mem.status <> 'active' THEN
    UPDATE public.agency_memberships
    SET status = 'active', updated_at = v_now
    WHERE id = v_mem.id;
  END IF;

  -- 10) Scadenza calcolata una sola volta lato database
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

REVOKE ALL ON FUNCTION public.reserve_padova_pilot_zone_atomic(text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_padova_pilot_zone_atomic(text, uuid, uuid, text) TO service_role;