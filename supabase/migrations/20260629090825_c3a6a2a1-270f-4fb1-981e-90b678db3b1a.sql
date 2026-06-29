
ALTER TABLE public.civiko_commercial_zones
  ADD COLUMN IF NOT EXISTS status text NOT NULL
    DEFAULT 'disponibile'
    CHECK (status IN ('disponibile','in_trial','occupata')),
  ADD COLUMN IF NOT EXISTS trial_agency_id uuid
    REFERENCES public.agencies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trial_reserved_until timestamptz,
  ADD COLUMN IF NOT EXISTS occupied_agency_id uuid
    REFERENCES public.agencies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS occupied_since timestamptz;

CREATE OR REPLACE FUNCTION public.reserve_commercial_zone(
  p_slug text,
  p_agency_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_zone public.civiko_commercial_zones%ROWTYPE;
BEGIN
  SELECT * INTO v_zone
  FROM public.civiko_commercial_zones
  WHERE slug = p_slug
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'zona_non_trovata');
  END IF;

  IF v_zone.status = 'occupata' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'zona_occupata');
  END IF;

  IF v_zone.status = 'in_trial'
     AND v_zone.trial_reserved_until > now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'zona_in_trial');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.civiko_commercial_zones
    WHERE (trial_agency_id = p_agency_id
       OR occupied_agency_id = p_agency_id)
      AND status <> 'disponibile'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'agency_ha_gia_zona');
  END IF;

  UPDATE public.civiko_commercial_zones
  SET status = 'in_trial',
      trial_agency_id = p_agency_id,
      trial_reserved_until = now() + INTERVAL '7 days'
  WHERE slug = p_slug;

  RETURN jsonb_build_object(
    'ok', true,
    'zona', p_slug,
    'trial_until', (now() + INTERVAL '7 days')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_commercial_zone(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_commercial_zone(text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.expire_commercial_zone_trials()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.civiko_commercial_zones
  SET status = 'disponibile',
      trial_agency_id = NULL,
      trial_reserved_until = NULL
  WHERE status = 'in_trial'
    AND trial_reserved_until < now();
END;
$$;

REVOKE ALL ON FUNCTION public.expire_commercial_zone_trials() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expire_commercial_zone_trials() TO service_role;
