-- Civiko Padova scope guard (forward-only)
CREATE OR REPLACE FUNCTION public.civiko_normalize_comune(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT NULLIF(
    btrim(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              lower(btrim(coalesce(public.civiko_ascii_fold(p_value), ''))),
              '^comune\s+di\s+', '', 'i'),
            '[\s,]*[\(\[]?\s*(pd|padova|italia|italy|veneto)\s*[\)\]]?$', '', 'i'),
          '[\.;:]+$', '', 'g'),
        '\s+', ' ', 'g')
    ), '');
$$;

CREATE OR REPLACE FUNCTION public.civiko_is_comune_padova(p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT coalesce(public.civiko_normalize_comune(p_value), '') = 'padova';
$$;

GRANT EXECUTE ON FUNCTION public.civiko_normalize_comune(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.civiko_is_comune_padova(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.promote_padova_collect_v2_to_listings(
  p_since timestamp with time zone DEFAULT (now() - '06:00:00'::interval))
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_new int := 0; v_upd int := 0;
  v_idealista_new int := 0; v_idealista_updated int := 0;
  v_scanned int := 0; v_kept int := 0; v_out int := 0;
  v_out_written int := 0;
  v_now timestamptz := now();
BEGIN
  -- Contatori bounded della corsa corrente (finestra p_since).
  SELECT count(*) INTO v_scanned
    FROM public.padova_collect_v2_items
   WHERE url IS NOT NULL AND updated_at >= p_since
     AND (prezzo IS NOT NULL OR mq IS NOT NULL);

  SELECT count(*) INTO v_kept
    FROM public.padova_collect_v2_items
   WHERE url IS NOT NULL AND updated_at >= p_since
     AND (prezzo IS NOT NULL OR mq IS NOT NULL)
     AND public.civiko_is_comune_padova(citta);

  v_out := GREATEST(0, v_scanned - v_kept);

  WITH src AS (
    SELECT DISTINCT ON (portal, url)
      portal, url, raw_address, agency, agency_phone,
      prezzo, mq, locali, bagni, lat, lng,
      public.civiko_classify_tipo_lead(tipo_lead, n_agenzie, agency) AS tipo_lead,
      CASE WHEN public.civiko_resolve_commercial_zone_slug(
             regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')) IS NULL
        THEN NULL
        ELSE regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')
      END AS quartiere,
      raw_json
    FROM public.padova_collect_v2_items
    WHERE public.civiko_is_comune_padova(citta)
      AND portal IS NOT NULL AND lower(portal) <> 'idealista'
      AND url IS NOT NULL AND updated_at >= p_since
      AND (prezzo IS NOT NULL OR mq IS NOT NULL)
    ORDER BY portal, url, updated_at DESC
  ),
  ups AS (
    INSERT INTO public.padova_listings
      (fonte, url, agency, telefono, tipo_lead, mq, locali, bagni, prezzo,
       lat, lng, indirizzo, quartiere, comune, raw_json, imported_at, last_seen_at)
    SELECT s.portal, s.url, s.agency, s.agency_phone, s.tipo_lead,
      s.mq, s.locali, s.bagni,
      CASE WHEN s.prezzo IS NULL THEN NULL WHEN s.prezzo > 2147483647 THEN NULL ELSE s.prezzo::int END,
      s.lat, s.lng, s.raw_address, s.quartiere, 'Padova', s.raw_json, v_now, v_now
    FROM src s
    ON CONFLICT (fonte, url) DO UPDATE SET
      agency = COALESCE(EXCLUDED.agency, public.padova_listings.agency),
      telefono = COALESCE(EXCLUDED.telefono, public.padova_listings.telefono),
      tipo_lead = public.civiko_merge_tipo_lead(public.padova_listings.tipo_lead, EXCLUDED.tipo_lead),
      mq = COALESCE(EXCLUDED.mq, public.padova_listings.mq),
      locali = COALESCE(EXCLUDED.locali, public.padova_listings.locali),
      bagni = COALESCE(EXCLUDED.bagni, public.padova_listings.bagni),
      prezzo = COALESCE(EXCLUDED.prezzo, public.padova_listings.prezzo),
      lat = COALESCE(EXCLUDED.lat, public.padova_listings.lat),
      lng = COALESCE(EXCLUDED.lng, public.padova_listings.lng),
      indirizzo = COALESCE(EXCLUDED.indirizzo, public.padova_listings.indirizzo),
      quartiere = CASE
        WHEN nullif(trim(coalesce(public.padova_listings.quartiere, '')), '') IS NULL
         AND EXCLUDED.quartiere IS NOT NULL
         AND public.civiko_resolve_commercial_zone_slug(EXCLUDED.quartiere) IN (
               SELECT slug FROM public.civiko_commercial_zones)
        THEN EXCLUDED.quartiere
        ELSE public.padova_listings.quartiere
      END,
      comune = 'Padova',
      raw_json = COALESCE(EXCLUDED.raw_json, public.padova_listings.raw_json),
      last_seen_at = v_now,
      expired_at = NULL
    WHERE (EXCLUDED.prezzo IS NOT NULL OR EXCLUDED.mq IS NOT NULL)
    RETURNING (xmax = 0) AS inserted, public.padova_listings.comune AS comune_out
  )
  SELECT count(*) FILTER (WHERE inserted),
         count(*) FILTER (WHERE NOT inserted),
         count(*) FILTER (WHERE NOT public.civiko_is_comune_padova(comune_out))
  INTO v_new, v_upd, v_out_written FROM ups;

  WITH src_id AS (
    SELECT DISTINCT ON (portal, url)
      portal, url, raw_address, agency, agency_phone,
      prezzo, mq, locali, bagni, lat, lng,
      public.civiko_classify_tipo_lead(tipo_lead, n_agenzie, agency) AS tipo_lead,
      CASE WHEN public.civiko_resolve_commercial_zone_slug(
             regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')) IS NULL
        THEN NULL
        ELSE regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')
      END AS quartiere,
      raw_json
    FROM public.padova_collect_v2_items
    WHERE public.civiko_is_comune_padova(citta)
      AND lower(portal) = 'idealista' AND url IS NOT NULL AND updated_at >= p_since
      AND (prezzo IS NOT NULL OR mq IS NOT NULL)
    ORDER BY portal, url, updated_at DESC
  ),
  ups_id AS (
    INSERT INTO public.padova_listings
      (fonte, url, agency, telefono, tipo_lead, mq, locali, bagni, prezzo,
       lat, lng, indirizzo, quartiere, comune, raw_json, imported_at, last_seen_at)
    SELECT s.portal, s.url, s.agency, s.agency_phone, s.tipo_lead,
      s.mq, s.locali, s.bagni,
      CASE WHEN s.prezzo IS NULL THEN NULL WHEN s.prezzo > 2147483647 THEN NULL ELSE s.prezzo::int END,
      s.lat, s.lng, s.raw_address, s.quartiere, 'Padova', s.raw_json, v_now, v_now
    FROM src_id s
    ON CONFLICT (fonte, url) DO UPDATE SET
      agency = COALESCE(EXCLUDED.agency, public.padova_listings.agency),
      telefono = COALESCE(EXCLUDED.telefono, public.padova_listings.telefono),
      tipo_lead = public.civiko_merge_tipo_lead(public.padova_listings.tipo_lead, EXCLUDED.tipo_lead),
      mq = COALESCE(EXCLUDED.mq, public.padova_listings.mq),
      locali = COALESCE(EXCLUDED.locali, public.padova_listings.locali),
      bagni = COALESCE(EXCLUDED.bagni, public.padova_listings.bagni),
      prezzo = COALESCE(EXCLUDED.prezzo, public.padova_listings.prezzo),
      lat = COALESCE(EXCLUDED.lat, public.padova_listings.lat),
      lng = COALESCE(EXCLUDED.lng, public.padova_listings.lng),
      indirizzo = COALESCE(EXCLUDED.indirizzo, public.padova_listings.indirizzo),
      quartiere = COALESCE(EXCLUDED.quartiere, public.padova_listings.quartiere),
      comune = 'Padova',
      raw_json = COALESCE(EXCLUDED.raw_json, public.padova_listings.raw_json),
      last_seen_at = v_now,
      expired_at = NULL
    WHERE (EXCLUDED.prezzo IS NOT NULL OR EXCLUDED.mq IS NOT NULL)
    RETURNING (xmax = 0) AS inserted, public.padova_listings.comune AS comune_out
  )
  SELECT count(*) FILTER (WHERE inserted),
         count(*) FILTER (WHERE NOT inserted),
         v_out_written + count(*) FILTER (WHERE NOT public.civiko_is_comune_padova(comune_out))
  INTO v_idealista_new, v_idealista_updated, v_out_written FROM ups_id;

  RETURN jsonb_build_object(
    'ok', true, 'since', p_since,
    'new', v_new, 'updated', v_upd,
    'idealista_new', v_idealista_new,
    'idealista_updated', v_idealista_updated,
    'scope_counters', jsonb_build_object(
      'scanned', v_scanned,
      'padova_kept', v_kept,
      'out_of_scope_rejected', v_out,
      'writes', v_new + v_upd + v_idealista_new + v_idealista_updated,
      'out_of_scope_written', v_out_written
    )
  );
END
$function$;