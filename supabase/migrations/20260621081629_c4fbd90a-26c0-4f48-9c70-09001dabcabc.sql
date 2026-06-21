
CREATE OR REPLACE FUNCTION public._safe_int(p text)
RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = public
AS $$
  SELECT CASE
    WHEN p IS NULL THEN NULL
    WHEN regexp_replace(p, '[^0-9]', '', 'g') = '' THEN NULL
    ELSE regexp_replace(p, '[^0-9]', '', 'g')::int
  END
$$;

CREATE OR REPLACE FUNCTION public._safe_float(p text)
RETURNS double precision
LANGUAGE sql IMMUTABLE SET search_path = public
AS $$
  SELECT CASE
    WHEN p IS NULL THEN NULL
    WHEN (regexp_match(p, '-?[0-9]+(\.[0-9]+)?'))[1] IS NULL THEN NULL
    ELSE (substring(p from '-?[0-9]+(\.[0-9]+)?'))::float8
  END
$$;

CREATE OR REPLACE FUNCTION public.promote_padova_agencies_listings(p_since timestamptz DEFAULT (now() - interval '6 hours'))
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_ideal_new int := 0; v_ideal_upd int := 0;
  v_casa_new  int := 0; v_casa_upd  int := 0;
  v_imm_new   int := 0; v_imm_upd   int := 0;
  v_now timestamptz := now();
BEGIN
  -- IDEALISTA
  WITH src AS (
    SELECT DISTINCT ON (url)
      url, agency, tipo_lead, mq, locali, bagni, prezzo, lat, lng, indirizzo, raw_json, fetched_at
    FROM public.padova_idealista_staging
    WHERE fetched_at >= p_since AND url IS NOT NULL
    ORDER BY url, fetched_at DESC
  ),
  ups AS (
    INSERT INTO public.padova_listings
      (fonte, url, agency, tipo_lead, mq, locali, bagni, prezzo, lat, lng, indirizzo,
       raw_json, published_at_portal, imported_at, last_seen_at)
    SELECT 'idealista', s.url, s.agency, s.tipo_lead, s.mq, s.locali, s.bagni, s.prezzo,
           s.lat, s.lng, s.indirizzo, s.raw_json,
           CASE WHEN s.raw_json->'modificationDate'->>'value' ~ '^[0-9]+$'
                THEN to_timestamp((s.raw_json->'modificationDate'->>'value')::bigint / 1000.0)
                ELSE NULL END,
           v_now, v_now
    FROM src s
    ON CONFLICT (fonte, url) DO UPDATE SET
      agency = COALESCE(EXCLUDED.agency, public.padova_listings.agency),
      tipo_lead = COALESCE(EXCLUDED.tipo_lead, public.padova_listings.tipo_lead),
      mq = COALESCE(EXCLUDED.mq, public.padova_listings.mq),
      locali = COALESCE(EXCLUDED.locali, public.padova_listings.locali),
      bagni = COALESCE(EXCLUDED.bagni, public.padova_listings.bagni),
      prezzo = COALESCE(EXCLUDED.prezzo, public.padova_listings.prezzo),
      lat = COALESCE(EXCLUDED.lat, public.padova_listings.lat),
      lng = COALESCE(EXCLUDED.lng, public.padova_listings.lng),
      indirizzo = COALESCE(EXCLUDED.indirizzo, public.padova_listings.indirizzo),
      raw_json = EXCLUDED.raw_json,
      published_at_portal = COALESCE(public.padova_listings.published_at_portal, EXCLUDED.published_at_portal),
      last_seen_at = v_now, expired_at = NULL
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted)
    INTO v_ideal_new, v_ideal_upd FROM ups;

  -- CASA
  WITH src AS (
    SELECT DISTINCT ON (raw_json->>'url')
      raw_json->>'url' AS url,
      raw_json->>'publisherName' AS agency,
      CASE WHEN raw_json->>'publisherName' IS NOT NULL THEN 'AGENZIA' ELSE NULL END AS tipo_lead,
      public._safe_int(raw_json->'features'->>'squareMeters') AS mq,
      public._safe_int(raw_json->'features'->>'rooms') AS locali,
      public._safe_int(raw_json->'features'->>'bathrooms') AS bagni,
      public._safe_int(raw_json->>'price') AS prezzo,
      public._safe_float(raw_json->'location'->'coordinates'->>'lat') AS lat,
      public._safe_float(raw_json->'location'->'coordinates'->>'lon') AS lng,
      coalesce(raw_json->'title'->>'main', raw_json->'location'->>'city') AS indirizzo,
      raw_json, fetched_at
    FROM public.padova_casa_staging
    WHERE fetched_at >= p_since AND raw_json->>'url' IS NOT NULL
    ORDER BY raw_json->>'url', fetched_at DESC
  ),
  ups AS (
    INSERT INTO public.padova_listings
      (fonte, url, agency, tipo_lead, mq, locali, bagni, prezzo, lat, lng, indirizzo,
       raw_json, published_at_portal, imported_at, last_seen_at)
    SELECT 'casa', s.url, s.agency, s.tipo_lead, s.mq, s.locali, s.bagni, s.prezzo,
           s.lat, s.lng, s.indirizzo, s.raw_json, NULL, v_now, v_now
    FROM src s
    ON CONFLICT (fonte, url) DO UPDATE SET
      agency = COALESCE(EXCLUDED.agency, public.padova_listings.agency),
      tipo_lead = COALESCE(EXCLUDED.tipo_lead, public.padova_listings.tipo_lead),
      mq = COALESCE(EXCLUDED.mq, public.padova_listings.mq),
      locali = COALESCE(EXCLUDED.locali, public.padova_listings.locali),
      bagni = COALESCE(EXCLUDED.bagni, public.padova_listings.bagni),
      prezzo = COALESCE(EXCLUDED.prezzo, public.padova_listings.prezzo),
      lat = COALESCE(EXCLUDED.lat, public.padova_listings.lat),
      lng = COALESCE(EXCLUDED.lng, public.padova_listings.lng),
      indirizzo = COALESCE(EXCLUDED.indirizzo, public.padova_listings.indirizzo),
      raw_json = EXCLUDED.raw_json,
      last_seen_at = v_now, expired_at = NULL
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted)
    INTO v_casa_new, v_casa_upd FROM ups;

  -- IMMOBILIARE (memo23 actor)
  WITH src AS (
    SELECT DISTINCT ON (regexp_replace(regexp_replace(raw_json->>'shareUrl', '\?.*$', ''), '/$', ''))
      regexp_replace(regexp_replace(raw_json->>'shareUrl', '\?.*$', ''), '/$', '') AS url,
      coalesce(raw_json->'author'->>'displayName',
               raw_json->'advertiser'->'agency'->>'displayName',
               raw_json->'advertiser'->'agency'->>'name') AS agency,
      CASE WHEN raw_json->'author' IS NOT NULL OR raw_json->'advertiser'->'agency' IS NOT NULL THEN 'AGENZIA' ELSE 'PRIVATO' END AS tipo_lead,
      public._safe_int(raw_json->'mainData'->>'surface') AS mq,
      public._safe_int(raw_json->'mainData'->>'rooms') AS locali,
      public._safe_int(raw_json->'mainData'->>'bathrooms') AS bagni,
      public._safe_int(raw_json->'price'->>'value') AS prezzo,
      public._safe_float(raw_json->'geography'->'location'->>'latitude') AS lat,
      public._safe_float(raw_json->'geography'->'location'->>'longitude') AS lng,
      coalesce(raw_json->'geography'->>'address', raw_json->'title'->>'short', raw_json->>'title') AS indirizzo,
      raw_json, fetched_at,
      CASE WHEN raw_json->>'creationDate' ~ '^[0-9]+$'
           THEN to_timestamp((raw_json->>'creationDate')::bigint)
           ELSE NULL END AS pub_at
    FROM public.padova_immobiliare_detail_staging
    WHERE fetched_at >= p_since AND raw_json IS NOT NULL AND raw_json->>'shareUrl' IS NOT NULL
    ORDER BY regexp_replace(regexp_replace(raw_json->>'shareUrl', '\?.*$', ''), '/$', ''), fetched_at DESC
  ),
  ups AS (
    INSERT INTO public.padova_listings
      (fonte, url, agency, tipo_lead, mq, locali, bagni, prezzo, lat, lng, indirizzo,
       raw_json, published_at_portal, imported_at, last_seen_at)
    SELECT 'immobiliare', s.url, s.agency, s.tipo_lead, s.mq, s.locali, s.bagni, s.prezzo,
           s.lat, s.lng, s.indirizzo, s.raw_json, s.pub_at, v_now, v_now
    FROM src s
    ON CONFLICT (fonte, url) DO UPDATE SET
      agency = COALESCE(EXCLUDED.agency, public.padova_listings.agency),
      tipo_lead = COALESCE(EXCLUDED.tipo_lead, public.padova_listings.tipo_lead),
      mq = COALESCE(EXCLUDED.mq, public.padova_listings.mq),
      locali = COALESCE(EXCLUDED.locali, public.padova_listings.locali),
      bagni = COALESCE(EXCLUDED.bagni, public.padova_listings.bagni),
      prezzo = COALESCE(EXCLUDED.prezzo, public.padova_listings.prezzo),
      lat = COALESCE(EXCLUDED.lat, public.padova_listings.lat),
      lng = COALESCE(EXCLUDED.lng, public.padova_listings.lng),
      indirizzo = COALESCE(EXCLUDED.indirizzo, public.padova_listings.indirizzo),
      raw_json = EXCLUDED.raw_json,
      published_at_portal = COALESCE(public.padova_listings.published_at_portal, EXCLUDED.published_at_portal),
      last_seen_at = v_now, expired_at = NULL
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted)
    INTO v_imm_new, v_imm_upd FROM ups;

  RETURN jsonb_build_object(
    'ok', true, 'since', p_since,
    'idealista', jsonb_build_object('new', v_ideal_new, 'updated', v_ideal_upd),
    'casa', jsonb_build_object('new', v_casa_new, 'updated', v_casa_upd),
    'immobiliare', jsonb_build_object('new', v_imm_new, 'updated', v_imm_upd)
  );
END $$;

GRANT EXECUTE ON FUNCTION public.promote_padova_agencies_listings(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public._safe_int(text) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public._safe_float(text) TO service_role, authenticated;
