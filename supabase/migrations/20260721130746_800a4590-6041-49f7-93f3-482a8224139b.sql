
-- 1) Sanitize quartiere in promotion RPC and force tipo_lead='PRIVATO' on new writes
CREATE OR REPLACE FUNCTION public.promote_padova_collect_v2_to_listings(
  p_since timestamp with time zone DEFAULT (now() - '06:00:00'::interval)
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new int := 0;
  v_upd int := 0;
  v_idealista_new int := 0;
  v_now timestamptz := now();
BEGIN
  -- Branch 1: non-idealista portals → UPSERT with field merging
  WITH src AS (
    SELECT DISTINCT ON (portal, url)
      portal, url, raw_address, agency, agency_phone,
      prezzo, mq, locali, bagni, lat, lng,
      -- Sanitizzazione quartiere: rimuove "Subdistrict "/"District ",
      -- normalizza e accetta solo se risolvibile dal contratto ufficiale.
      CASE
        WHEN public.civiko_resolve_commercial_zone_slug(
               regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')
             ) IS NULL
        THEN NULL
        ELSE regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')
      END AS quartiere,
      raw_json
    FROM public.padova_collect_v2_items
    WHERE lower(coalesce(citta,'')) = 'padova'
      AND portal IS NOT NULL
      AND lower(portal) <> 'idealista'
      AND url IS NOT NULL
      AND updated_at >= p_since
      AND (prezzo IS NOT NULL OR mq IS NOT NULL)
    ORDER BY portal, url, updated_at DESC
  ),
  ups AS (
    INSERT INTO public.padova_listings
      (fonte, url, agency, telefono, tipo_lead, mq, locali, bagni, prezzo,
       lat, lng, indirizzo, quartiere, raw_json, imported_at, last_seen_at)
    SELECT
      s.portal, s.url, s.agency, s.agency_phone,
      'PRIVATO'::text,
      s.mq, s.locali, s.bagni,
      CASE WHEN s.prezzo IS NULL THEN NULL
           WHEN s.prezzo > 2147483647 THEN NULL
           ELSE s.prezzo::int END,
      s.lat, s.lng, s.raw_address, s.quartiere, s.raw_json, v_now, v_now
    FROM src s
    ON CONFLICT (fonte, url) DO UPDATE SET
      agency      = COALESCE(EXCLUDED.agency, public.padova_listings.agency),
      telefono    = COALESCE(EXCLUDED.telefono, public.padova_listings.telefono),
      tipo_lead   = COALESCE(EXCLUDED.tipo_lead, public.padova_listings.tipo_lead),
      mq          = COALESCE(EXCLUDED.mq, public.padova_listings.mq),
      locali      = COALESCE(EXCLUDED.locali, public.padova_listings.locali),
      bagni       = COALESCE(EXCLUDED.bagni, public.padova_listings.bagni),
      prezzo      = COALESCE(EXCLUDED.prezzo, public.padova_listings.prezzo),
      lat         = COALESCE(EXCLUDED.lat, public.padova_listings.lat),
      lng         = COALESCE(EXCLUDED.lng, public.padova_listings.lng),
      indirizzo   = COALESCE(EXCLUDED.indirizzo, public.padova_listings.indirizzo),
      quartiere   = COALESCE(EXCLUDED.quartiere, public.padova_listings.quartiere),
      raw_json    = COALESCE(EXCLUDED.raw_json, public.padova_listings.raw_json),
      last_seen_at = v_now,
      expired_at  = NULL
    WHERE (EXCLUDED.prezzo IS NOT NULL OR EXCLUDED.mq IS NOT NULL)
    RETURNING (xmax = 0) AS inserted
  )
  SELECT
    count(*) FILTER (WHERE inserted),
    count(*) FILTER (WHERE NOT inserted)
  INTO v_new, v_upd
  FROM ups;

  -- Branch 2: idealista → conservative INSERT ... ON CONFLICT DO NOTHING
  WITH src_id AS (
    SELECT DISTINCT ON (portal, url)
      portal, url, raw_address, agency, agency_phone,
      prezzo, mq, locali, bagni, lat, lng,
      CASE
        WHEN public.civiko_resolve_commercial_zone_slug(
               regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')
             ) IS NULL
        THEN NULL
        ELSE regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')
      END AS quartiere,
      raw_json
    FROM public.padova_collect_v2_items
    WHERE lower(coalesce(citta,'')) = 'padova'
      AND lower(portal) = 'idealista'
      AND url IS NOT NULL
      AND updated_at >= p_since
      AND (prezzo IS NOT NULL OR mq IS NOT NULL)
    ORDER BY portal, url, updated_at DESC
  ),
  ins_id AS (
    INSERT INTO public.padova_listings
      (fonte, url, agency, telefono, tipo_lead, mq, locali, bagni, prezzo,
       lat, lng, indirizzo, quartiere, raw_json, imported_at, last_seen_at)
    SELECT
      s.portal, s.url, s.agency, s.agency_phone,
      'PRIVATO'::text,
      s.mq, s.locali, s.bagni,
      CASE WHEN s.prezzo IS NULL THEN NULL
           WHEN s.prezzo > 2147483647 THEN NULL
           ELSE s.prezzo::int END,
      s.lat, s.lng, s.raw_address, s.quartiere, s.raw_json, v_now, v_now
    FROM src_id s
    ON CONFLICT (fonte, url) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_idealista_new FROM ins_id;

  RETURN jsonb_build_object(
    'ok', true,
    'since', p_since,
    'new', v_new,
    'updated', v_upd,
    'idealista_new', v_idealista_new
  );
END;
$function$;

-- 2) Bonifica one-shot: rimuove il prefisso grezzo da padova_listings.
--    Il trigger civiko_padova_listings_zone_trg ricalcola commercial_zone_slug
--    via civiko_resolve_commercial_zone_slug.
UPDATE public.padova_listings
   SET quartiere = regexp_replace(quartiere, '^(Subdistrict|District)\s+', '', 'i')
 WHERE quartiere ~* '^(Subdistrict|District)\s+';

-- 3) Ridefinisce padova_quartieri_stats_v: contendibili sempre attribuiti alle
--    8 zone canoniche via contratto, altrimenti 'Altre zone'.
CREATE OR REPLACE VIEW public.padova_quartieri_stats_v AS
WITH listings_zoned AS (
  SELECT
    COALESCE(m.microzona, NULLIF(btrim(l_1.quartiere), ''), 'Altre zone') AS zona,
    l_1.agency,
    l_1.tipo_lead
  FROM public.padova_listings l_1
  LEFT JOIN public.quartiere_canon_map m
    ON m.chiave = public.canon_quartiere(l_1.quartiere)
),
l_agg AS (
  SELECT
    zona,
    count(*) AS n_annunci,
    count(DISTINCT lower(btrim(agency))) FILTER (
      WHERE COALESCE(btrim(agency), '') <> ''
        AND lower(btrim(agency)) <> 'agenzie'
    ) AS n_agenzie,
    count(*) FILTER (WHERE upper(COALESCE(tipo_lead, '')) = 'PRIVATO') AS n_privati
  FROM listings_zoned
  GROUP BY zona
),
c_zoned AS (
  SELECT
    pc.prezzo_min,
    pc.prezzo_max,
    pc.n_ribassi,
    COALESCE(cz.nome, 'Altre zone') AS zona
  FROM public.padova_contendibili pc
  LEFT JOIN public.civiko_commercial_zones cz
    ON cz.slug = public.civiko_resolve_commercial_zone_slug(pc.quartiere)
),
c_agg AS (
  SELECT
    zona,
    count(*) AS n_contendibili,
    count(*) FILTER (WHERE COALESCE(n_ribassi, 0) > 0) AS n_ribassi,
    min(prezzo_min) AS prezzo_min,
    max(prezzo_max) AS prezzo_max
  FROM c_zoned
  GROUP BY zona
)
SELECT
  COALESCE(c.zona, l.zona) AS zona,
  COALESCE(c.n_contendibili, 0::bigint) AS n_contendibili,
  COALESCE(l.n_annunci, 0::bigint) AS n_annunci,
  COALESCE(l.n_agenzie, 0::bigint) AS n_agenzie,
  c.prezzo_min,
  c.prezzo_max,
  COALESCE(c.n_ribassi, 0::bigint) AS n_ribassi,
  COALESCE(l.n_privati, 0::bigint) AS n_privati
FROM c_agg c
FULL JOIN l_agg l ON l.zona = c.zona;
