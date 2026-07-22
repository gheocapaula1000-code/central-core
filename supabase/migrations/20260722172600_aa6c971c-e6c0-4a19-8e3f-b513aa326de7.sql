
CREATE OR REPLACE FUNCTION public.process_padova_subito_staging(
  p_since_hours integer DEFAULT 48,
  p_max_rows integer DEFAULT 1000
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_now         timestamptz := now();
  v_now_iso     text := to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_job_id      text := 'subito-staging-promote-' || to_char(v_now, 'YYYYMMDDHH24MISS');
  v_since       timestamptz := v_now - make_interval(hours => COALESCE(p_since_hours, 48));
  v_found       int := 0;
  v_processed   int := 0;
  v_created     int := 0;
  v_updated     int := 0;
  v_skipped_out int := 0;
  v_skipped_bad int := 0;
  v_errors      int := 0;
  v_max_before  timestamptz;
  v_max_after   timestamptz;
BEGIN
  SELECT max(created_at) INTO v_max_before
    FROM public.padova_collect_v2_items WHERE portal = 'subito';

  WITH src AS (
    SELECT id, raw_json
      FROM public.padova_subito_staging
     WHERE fetched_at >= v_since
     ORDER BY fetched_at DESC
     LIMIT GREATEST(1, LEAST(COALESCE(p_max_rows, 1000), 5000))
  ),
  mapped AS (
    SELECT
      s.id AS staging_id,
      NULLIF(regexp_replace(COALESCE(s.raw_json->>'urls_default',''), '\?.*$', ''), '') AS url_raw,
      regexp_replace(regexp_replace(COALESCE(s.raw_json->>'urls_default',''), '\?.*$', ''), '^http:', 'https:') AS url,
      substring(COALESCE(s.raw_json->>'urls_default','') from '-([0-9]+)\.htm') AS listing_id,
      LOWER(TRIM(COALESCE(s.raw_json->>'geo_town_value',''))) AS town,
      LOWER(TRIM(COALESCE(s.raw_json->>'type_value',''))) AS type_v,
      NULLIF(regexp_replace(COALESCE(s.raw_json->>'features_price_values',''), '[^0-9]', '', 'g'), '')::numeric AS prezzo,
      NULLIF(regexp_replace(COALESCE(s.raw_json->>'features_size_values',''), '[^0-9]', '', 'g'), '')::integer AS mq,
      NULLIF(regexp_replace(COALESCE(s.raw_json->>'features_room_values',''), '[^0-9]', '', 'g'), '')::integer AS locali,
      NULLIF(regexp_replace(COALESCE(s.raw_json->>'features_bathrooms_values',''), '[^0-9]', '', 'g'), '')::integer AS bagni,
      NULLIF(TRIM(COALESCE(s.raw_json->>'features_floor_values', s.raw_json->>'features_floor_label','')), '') AS piano,
      NULLIF(TRIM(COALESCE(s.raw_json->>'features_building_condition_label','')), '') AS stato,
      CASE
        WHEN NULLIF(s.raw_json->>'geo_map_latitude','') IS NULL THEN NULL
        ELSE NULLIF((s.raw_json->>'geo_map_latitude')::double precision, 0::double precision)
      END AS lat,
      CASE
        WHEN NULLIF(s.raw_json->>'geo_map_longitude','') IS NULL THEN NULL
        ELSE NULLIF((s.raw_json->>'geo_map_longitude')::double precision, 0::double precision)
      END AS lng,
      NULLIF(TRIM(COALESCE(s.raw_json->>'geo_map_address','')), '') AS addr,
      LOWER(COALESCE(s.raw_json->>'advertiser_company','')) = 'true' AS is_company,
      NULLIF(TRIM(COALESCE(s.raw_json->>'advertiser_name','')), '') AS advertiser_name,
      NULLIF(TRIM(COALESCE(s.raw_json->>'advertiser_phone','')), '') AS advertiser_phone,
      NULLIF(TRIM(COALESCE(s.raw_json->>'category_label','')), '') AS tipologia,
      s.raw_json AS rj
    FROM src s
  ),
  eligible AS (
    SELECT *
      FROM mapped
     WHERE url IS NOT NULL
       AND url <> ''
       AND town = 'padova'
       AND (type_v = '' OR type_v LIKE '%vendita%')
       AND prezzo IS NOT NULL
       AND prezzo >= 10000
  ),
  eligible_dedup AS (
    SELECT DISTINCT ON (url) *
      FROM eligible
     ORDER BY url, staging_id DESC
  ),
  upsert AS (
    INSERT INTO public.padova_collect_v2_items (
      job_id, portal, listing_id, url, raw_address, citta, cap, lat, lng,
      omi_zone, quartiere, tipo_lead, n_agenzie, prezzo, prezzo_iniziale,
      mq, locali, bagni, agency, agency_phone, tipologia, piano, stato,
      anno_costruzione, cluster_key, parse_status, processed_at, http_status,
      log_reason, attempts, raw_json, updated_at
    )
    SELECT
      v_job_id, 'subito', e.listing_id, e.url, e.addr, 'Padova', NULL, e.lat, e.lng,
      NULL, NULL,
      CASE WHEN e.is_company THEN 'AGENZIA' ELSE 'PRIVATO' END,
      CASE WHEN e.is_company THEN 1 ELSE 0 END,
      e.prezzo, e.prezzo,
      e.mq, e.locali, e.bagni,
      CASE WHEN e.is_company THEN e.advertiser_name ELSE NULL END,
      CASE WHEN e.advertiser_phone IS NOT NULL AND e.advertiser_phone <> '0' THEN e.advertiser_phone ELSE NULL END,
      e.tipologia, e.piano, e.stato,
      NULL, NULL, 'apify_subito_staging', v_now, 200,
      NULL, 0,
      jsonb_build_object(
        '_source', 'padova_subito_staging',
        '_staging_id', e.staging_id,
        '_shape', 'subito_listview',
        '_promoted_at', v_now_iso
      ) || COALESCE(e.rj, '{}'::jsonb),
      v_now
    FROM eligible_dedup e
    ON CONFLICT DO NOTHING
    RETURNING 1
  ),
  totals AS (
    SELECT
      (SELECT count(*) FROM src)              AS found_rows,
      (SELECT count(*) FROM mapped)           AS processed_rows,
      (SELECT count(*) FROM eligible_dedup)   AS eligible_rows,
      (SELECT count(*) FROM upsert)           AS inserted_rows
  )
  SELECT found_rows, processed_rows, eligible_rows
    INTO v_found, v_processed, v_created
    FROM totals;

  -- Since padova_collect_v2_items has no unique constraint on (portal,url),
  -- the ON CONFLICT DO NOTHING above is effectively a no-op, so we handle
  -- update-vs-insert with a two-step approach: touch existing rows, then insert missing.
  -- Overwrite the inserted count with a real one computed below.
  -- (Rollback: we haven't actually inserted anything if a unique index exists;
  --  the ON CONFLICT clause requires one. Without it, INSERT ... ON CONFLICT
  --  raises. So the CTE above is a no-op only when index exists — which it does
  --  not — hence we redo cleanly below.)

  -- Reset transactional bookkeeping and perform proper upsert.
  v_created := 0;

  CREATE TEMP TABLE _sub_pipe ON COMMIT DROP AS
  SELECT
    s.id AS staging_id,
    regexp_replace(regexp_replace(COALESCE(s.raw_json->>'urls_default',''), '\?.*$', ''), '^http:', 'https:') AS url,
    substring(COALESCE(s.raw_json->>'urls_default','') from '-([0-9]+)\.htm') AS listing_id,
    LOWER(TRIM(COALESCE(s.raw_json->>'geo_town_value',''))) AS town,
    LOWER(TRIM(COALESCE(s.raw_json->>'type_value',''))) AS type_v,
    NULLIF(regexp_replace(COALESCE(s.raw_json->>'features_price_values',''), '[^0-9]', '', 'g'), '')::numeric AS prezzo,
    NULLIF(regexp_replace(COALESCE(s.raw_json->>'features_size_values',''), '[^0-9]', '', 'g'), '')::integer AS mq,
    NULLIF(regexp_replace(COALESCE(s.raw_json->>'features_room_values',''), '[^0-9]', '', 'g'), '')::integer AS locali,
    NULLIF(regexp_replace(COALESCE(s.raw_json->>'features_bathrooms_values',''), '[^0-9]', '', 'g'), '')::integer AS bagni,
    NULLIF(TRIM(COALESCE(s.raw_json->>'features_floor_values', s.raw_json->>'features_floor_label','')), '') AS piano,
    NULLIF(TRIM(COALESCE(s.raw_json->>'features_building_condition_label','')), '') AS stato,
    CASE WHEN NULLIF(s.raw_json->>'geo_map_latitude','') IS NULL THEN NULL
         ELSE NULLIF((s.raw_json->>'geo_map_latitude')::double precision, 0::double precision) END AS lat,
    CASE WHEN NULLIF(s.raw_json->>'geo_map_longitude','') IS NULL THEN NULL
         ELSE NULLIF((s.raw_json->>'geo_map_longitude')::double precision, 0::double precision) END AS lng,
    NULLIF(TRIM(COALESCE(s.raw_json->>'geo_map_address','')), '') AS addr,
    LOWER(COALESCE(s.raw_json->>'advertiser_company','')) = 'true' AS is_company,
    NULLIF(TRIM(COALESCE(s.raw_json->>'advertiser_name','')), '') AS advertiser_name,
    NULLIF(TRIM(COALESCE(s.raw_json->>'advertiser_phone','')), '') AS advertiser_phone,
    NULLIF(TRIM(COALESCE(s.raw_json->>'category_label','')), '') AS tipologia,
    s.raw_json AS rj
  FROM (
    SELECT id, raw_json
      FROM public.padova_subito_staging
     WHERE fetched_at >= v_since
     ORDER BY fetched_at DESC
     LIMIT GREATEST(1, LEAST(COALESCE(p_max_rows, 1000), 5000))
  ) s;

  v_found := (SELECT count(*) FROM _sub_pipe);

  -- Skipped: out-of-scope (city != Padova or not sale)
  v_skipped_out := (
    SELECT count(*) FROM _sub_pipe
     WHERE town <> 'padova' OR (type_v <> '' AND type_v NOT LIKE '%vendita%')
  );

  -- Skipped: bad (missing url or price)
  v_skipped_bad := (
    SELECT count(*) FROM _sub_pipe
     WHERE town = 'padova'
       AND (type_v = '' OR type_v LIKE '%vendita%')
       AND (url IS NULL OR url = '' OR prezzo IS NULL OR prezzo < 10000)
  );

  -- Eligible dedup per url (most recent wins)
  CREATE TEMP TABLE _sub_eligible ON COMMIT DROP AS
  SELECT DISTINCT ON (url) *
    FROM _sub_pipe
   WHERE town = 'padova'
     AND (type_v = '' OR type_v LIKE '%vendita%')
     AND url IS NOT NULL AND url <> ''
     AND prezzo IS NOT NULL AND prezzo >= 10000
   ORDER BY url, staging_id DESC;

  v_processed := (SELECT count(*) FROM _sub_eligible);

  -- Existing rows by (portal, url)
  CREATE TEMP TABLE _sub_existing ON COMMIT DROP AS
  SELECT c.id, c.url
    FROM public.padova_collect_v2_items c
   WHERE c.portal = 'subito'
     AND c.url IN (SELECT url FROM _sub_eligible);

  -- Update existing rows
  BEGIN
    WITH upd AS (
      UPDATE public.padova_collect_v2_items c
         SET listing_id       = COALESCE(e.listing_id, c.listing_id),
             raw_address      = COALESCE(e.addr, c.raw_address),
             citta            = 'Padova',
             lat              = COALESCE(e.lat, c.lat),
             lng              = COALESCE(e.lng, c.lng),
             tipo_lead        = CASE WHEN e.is_company THEN 'AGENZIA' ELSE 'PRIVATO' END,
             n_agenzie        = CASE WHEN e.is_company THEN 1 ELSE 0 END,
             prezzo           = e.prezzo,
             mq               = COALESCE(e.mq, c.mq),
             locali           = COALESCE(e.locali, c.locali),
             bagni            = COALESCE(e.bagni, c.bagni),
             agency           = CASE WHEN e.is_company THEN COALESCE(e.advertiser_name, c.agency) ELSE c.agency END,
             agency_phone     = CASE WHEN e.advertiser_phone IS NOT NULL AND e.advertiser_phone <> '0'
                                       THEN e.advertiser_phone ELSE c.agency_phone END,
             tipologia        = COALESCE(e.tipologia, c.tipologia),
             piano            = COALESCE(e.piano, c.piano),
             stato            = COALESCE(e.stato, c.stato),
             parse_status     = 'apify_subito_staging',
             processed_at     = v_now,
             updated_at       = v_now,
             raw_json         = jsonb_build_object(
                                  '_source', 'padova_subito_staging',
                                  '_staging_id', e.staging_id,
                                  '_shape', 'subito_listview',
                                  '_promoted_at', v_now_iso
                                ) || COALESCE(e.rj, '{}'::jsonb)
        FROM _sub_eligible e
       WHERE c.portal = 'subito' AND c.url = e.url
       RETURNING c.id
    )
    SELECT count(*) INTO v_updated FROM upd;
  EXCEPTION WHEN OTHERS THEN
    v_errors := v_errors + 1;
    v_updated := 0;
  END;

  -- Insert new rows
  BEGIN
    WITH ins AS (
      INSERT INTO public.padova_collect_v2_items (
        job_id, portal, listing_id, url, raw_address, citta, cap, lat, lng,
        omi_zone, quartiere, tipo_lead, n_agenzie, prezzo, prezzo_iniziale,
        mq, locali, bagni, agency, agency_phone, tipologia, piano, stato,
        anno_costruzione, cluster_key, parse_status, processed_at, http_status,
        log_reason, attempts, raw_json, updated_at
      )
      SELECT
        v_job_id, 'subito', e.listing_id, e.url, e.addr, 'Padova', NULL, e.lat, e.lng,
        NULL, NULL,
        CASE WHEN e.is_company THEN 'AGENZIA' ELSE 'PRIVATO' END,
        CASE WHEN e.is_company THEN 1 ELSE 0 END,
        e.prezzo, e.prezzo,
        e.mq, e.locali, e.bagni,
        CASE WHEN e.is_company THEN e.advertiser_name ELSE NULL END,
        CASE WHEN e.advertiser_phone IS NOT NULL AND e.advertiser_phone <> '0'
             THEN e.advertiser_phone ELSE NULL END,
        e.tipologia, e.piano, e.stato,
        NULL, NULL, 'apify_subito_staging', v_now, 200,
        NULL, 0,
        jsonb_build_object(
          '_source', 'padova_subito_staging',
          '_staging_id', e.staging_id,
          '_shape', 'subito_listview',
          '_promoted_at', v_now_iso
        ) || COALESCE(e.rj, '{}'::jsonb),
        v_now
      FROM _sub_eligible e
      WHERE NOT EXISTS (
        SELECT 1 FROM _sub_existing x WHERE x.url = e.url
      )
      RETURNING 1
    )
    SELECT count(*) INTO v_created FROM ins;
  EXCEPTION WHEN OTHERS THEN
    v_errors := v_errors + 1;
    v_created := 0;
  END;

  SELECT max(created_at) INTO v_max_after
    FROM public.padova_collect_v2_items WHERE portal = 'subito';

  RETURN jsonb_build_object(
    'ok', true,
    'job_id', v_job_id,
    'since_hours', p_since_hours,
    'max_rows', p_max_rows,
    'staging_rows_found', v_found,
    'staging_rows_processed', v_processed,
    'collect_created', v_created,
    'collect_updated', v_updated,
    'skipped_out_of_scope', v_skipped_out,
    'skipped_bad_data', v_skipped_bad,
    'errors', v_errors,
    'max_created_at_before', v_max_before,
    'max_created_at_after', v_max_after
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.process_padova_subito_staging(integer, integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.process_padova_subito_staging(integer, integer) FROM PUBLIC, anon, authenticated;
