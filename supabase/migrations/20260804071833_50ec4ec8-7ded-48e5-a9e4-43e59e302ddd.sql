CREATE OR REPLACE FUNCTION public.promote_padova_collect_v2_to_listings(p_since timestamp with time zone DEFAULT (now() - '06:00:00'::interval))
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new int := 0; v_upd int := 0;
  v_idealista_new int := 0; v_idealista_updated int := 0;
  v_now timestamptz := now();
BEGIN
  WITH src AS (
    SELECT DISTINCT ON (portal, url)
      portal, url, raw_address, agency, agency_phone,
      prezzo, mq, locali, bagni, lat, lng,
      CASE WHEN public.civiko_resolve_commercial_zone_slug(
             regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')) IS NULL
        THEN NULL
        ELSE regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')
      END AS quartiere,
      raw_json
    FROM public.padova_collect_v2_items
    WHERE lower(coalesce(citta,'')) = 'padova'
      AND portal IS NOT NULL AND lower(portal) <> 'idealista'
      AND url IS NOT NULL AND updated_at >= p_since
      AND (prezzo IS NOT NULL OR mq IS NOT NULL)
    ORDER BY portal, url, updated_at DESC
  ),
  ups AS (
    INSERT INTO public.padova_listings
      (fonte, url, agency, telefono, tipo_lead, mq, locali, bagni, prezzo,
       lat, lng, indirizzo, quartiere, raw_json, imported_at, last_seen_at)
    SELECT s.portal, s.url, s.agency, s.agency_phone, 'PRIVATO'::text,
      s.mq, s.locali, s.bagni,
      CASE WHEN s.prezzo IS NULL THEN NULL WHEN s.prezzo > 2147483647 THEN NULL ELSE s.prezzo::int END,
      s.lat, s.lng, s.raw_address, s.quartiere, s.raw_json, v_now, v_now
    FROM src s
    ON CONFLICT (fonte, url) DO UPDATE SET
      agency = COALESCE(EXCLUDED.agency, public.padova_listings.agency),
      telefono = COALESCE(EXCLUDED.telefono, public.padova_listings.telefono),
      tipo_lead = COALESCE(EXCLUDED.tipo_lead, public.padova_listings.tipo_lead),
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
      raw_json = COALESCE(EXCLUDED.raw_json, public.padova_listings.raw_json),
      last_seen_at = v_now,
      expired_at = NULL
    WHERE (EXCLUDED.prezzo IS NOT NULL OR EXCLUDED.mq IS NOT NULL)
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted)
  INTO v_new, v_upd FROM ups;

  WITH src_id AS (
    SELECT DISTINCT ON (portal, url)
      portal, url, raw_address, agency, agency_phone,
      prezzo, mq, locali, bagni, lat, lng,
      CASE upper(nullif(trim(coalesce(tipo_lead, '')), ''))
        WHEN 'AGENZIA' THEN 'AGENZIA'
        WHEN 'PRIVATO' THEN 'PRIVATO'
        ELSE NULL
      END AS tipo_lead,
      CASE WHEN public.civiko_resolve_commercial_zone_slug(
             regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')) IS NULL
        THEN NULL
        ELSE regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')
      END AS quartiere,
      raw_json
    FROM public.padova_collect_v2_items
    WHERE lower(coalesce(citta,'')) = 'padova'
      AND lower(portal) = 'idealista' AND url IS NOT NULL AND updated_at >= p_since
      AND (prezzo IS NOT NULL OR mq IS NOT NULL)
    ORDER BY portal, url, updated_at DESC
  ),
  ups_id AS (
    INSERT INTO public.padova_listings
      (fonte, url, agency, telefono, tipo_lead, mq, locali, bagni, prezzo,
       lat, lng, indirizzo, quartiere, raw_json, imported_at, last_seen_at)
    SELECT s.portal, s.url, s.agency, s.agency_phone, s.tipo_lead,
      s.mq, s.locali, s.bagni,
      CASE WHEN s.prezzo IS NULL THEN NULL WHEN s.prezzo > 2147483647 THEN NULL ELSE s.prezzo::int END,
      s.lat, s.lng, s.raw_address, s.quartiere, s.raw_json, v_now, v_now
    FROM src_id s
    ON CONFLICT (fonte, url) DO UPDATE SET
      agency = COALESCE(EXCLUDED.agency, public.padova_listings.agency),
      telefono = COALESCE(EXCLUDED.telefono, public.padova_listings.telefono),
      tipo_lead = COALESCE(EXCLUDED.tipo_lead, public.padova_listings.tipo_lead),
      mq = COALESCE(EXCLUDED.mq, public.padova_listings.mq),
      locali = COALESCE(EXCLUDED.locali, public.padova_listings.locali),
      bagni = COALESCE(EXCLUDED.bagni, public.padova_listings.bagni),
      prezzo = COALESCE(EXCLUDED.prezzo, public.padova_listings.prezzo),
      lat = COALESCE(EXCLUDED.lat, public.padova_listings.lat),
      lng = COALESCE(EXCLUDED.lng, public.padova_listings.lng),
      indirizzo = COALESCE(EXCLUDED.indirizzo, public.padova_listings.indirizzo),
      quartiere = COALESCE(EXCLUDED.quartiere, public.padova_listings.quartiere),
      raw_json = COALESCE(EXCLUDED.raw_json, public.padova_listings.raw_json),
      last_seen_at = v_now,
      expired_at = NULL
    WHERE (EXCLUDED.prezzo IS NOT NULL OR EXCLUDED.mq IS NOT NULL)
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted)
  INTO v_idealista_new, v_idealista_updated FROM ups_id;

  RETURN jsonb_build_object(
    'ok', true, 'since', p_since,
    'new', v_new, 'updated', v_upd,
    'idealista_new', v_idealista_new,
    'idealista_updated', v_idealista_updated
  );
END
$function$;