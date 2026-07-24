CREATE OR REPLACE FUNCTION public.get_padova_verified_price_drops_by_zone_v2(
  p_commercial_zone_slug text,
  p_quartiere text DEFAULT NULL::text,
  p_limit integer DEFAULT 500,
  p_min_drop_pct numeric DEFAULT 5,
  p_max_age_days integer DEFAULT 14
)
RETURNS TABLE(source_id text, listing_id text, source text, url text, title text, mq numeric, lat double precision, lng double precision, initial_price_eur numeric, current_price_eur numeric, total_drop_pct numeric, drops_count integer, observations_count integer, first_seen_at timestamp with time zone, last_seen_at timestamp with time zone, comune text, omi_zone text, commercial_zone_slug text, zone_match_method text, zone_match_confidence numeric, quartiere text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH branch_a AS (
    SELECT
      d.source_id, d.listing_id, d.source, d.url, d.title, d.mq,
      d.lat, d.lng,
      d.initial_price_eur, d.current_price_eur, d.total_drop_pct,
      d.drops_count, d.observations_count,
      d.first_seen_at, d.last_seen_at,
      d.comune, d.omi_zone, d.commercial_zone_slug,
      d.zone_match_method, d.zone_match_confidence,
      NULL::text AS quartiere
    FROM public.get_padova_verified_price_drops(p_limit, p_min_drop_pct, p_max_age_days) d
    WHERE d.commercial_zone_slug = p_commercial_zone_slug
  ),
  hist_base AS (
    SELECT
      pl.id                                          AS listing_id,
      pl.url, pl.indirizzo AS title, pl.mq::numeric  AS mq,
      pl.lat, pl.lng, pl.comune, pl.omi_zone, pl.quartiere, pl.fonte AS source,
      pl.commercial_zone_slug,
      h.id                                           AS hist_id,
      h.prezzo, h.snapshot_date, h.created_at
    FROM public.padova_listings_price_history h
    JOIN public.padova_listings pl ON pl.id = h.listing_id
    WHERE pl.expired_at IS NULL
      AND lower(coalesce(pl.comune,'')) = 'padova'
      AND pl.url IS NOT NULL
      AND pl.url ILIKE 'https://%'
      AND pl.commercial_zone_slug = p_commercial_zone_slug
      AND (p_quartiere IS NULL OR pl.quartiere = p_quartiere)
  ),
  hist_days AS (
    SELECT listing_id, count(DISTINCT snapshot_date)::bigint AS obs_days
    FROM hist_base
    GROUP BY listing_id
  ),
  hist AS (
    SELECT
      hb.*,
      LAG(hb.prezzo) OVER (PARTITION BY hb.listing_id ORDER BY hb.snapshot_date ASC, hb.hist_id ASC) AS prev_prezzo,
      row_number() OVER (PARTITION BY hb.listing_id ORDER BY hb.snapshot_date ASC, hb.hist_id ASC) AS rn_asc,
      row_number() OVER (PARTITION BY hb.listing_id ORDER BY hb.snapshot_date DESC, hb.hist_id DESC) AS rn_desc,
      count(*) OVER (PARTITION BY hb.listing_id) AS obs_count
    FROM hist_base hb
  ),
  hist_pairs AS (
    SELECT h.listing_id,
           max(h.url)         AS url,
           max(h.title)       AS title,
           max(h.mq)          AS mq,
           max(h.lat)         AS lat,
           max(h.lng)         AS lng,
           max(h.comune)      AS comune,
           max(h.omi_zone)    AS omi_zone,
           max(h.commercial_zone_slug) AS commercial_zone_slug,
           max(h.quartiere)   AS quartiere,
           max(h.source)      AS source,
           max(h.obs_count)   AS obs_count,
           max(hd.obs_days)   AS obs_days,
           max(h.prezzo) FILTER (WHERE h.rn_asc  = 1) AS first_price,
           max(h.prezzo) FILTER (WHERE h.rn_desc = 1) AS last_price,
           max(h.created_at) FILTER (WHERE h.rn_asc  = 1) AS first_seen_at,
           max(h.created_at) FILTER (WHERE h.rn_desc = 1) AS last_seen_at,
           count(*) FILTER (WHERE h.prev_prezzo IS NOT NULL AND h.prezzo < h.prev_prezzo)::int AS drops_count
    FROM hist h
    JOIN hist_days hd ON hd.listing_id = h.listing_id
    GROUP BY h.listing_id
  ),
  branch_b AS (
    SELECT
      ('lph:' || listing_id::text) AS source_id,
      listing_id::text             AS listing_id,
      source, url, title, mq, lat, lng,
      first_price::numeric AS initial_price_eur,
      last_price::numeric  AS current_price_eur,
      CASE
        WHEN first_price IS NULL OR first_price <= 0 THEN 0
        ELSE round(((first_price - last_price)::numeric / first_price::numeric) * 100, 2)
      END AS total_drop_pct,
      COALESCE(drops_count, 0)::int AS drops_count,
      obs_count::int   AS observations_count,
      first_seen_at, last_seen_at,
      comune, omi_zone, commercial_zone_slug,
      'padova_listings_price_history'::text AS zone_match_method,
      1.0::numeric                          AS zone_match_confidence,
      quartiere
    FROM hist_pairs
    WHERE obs_days >= 2
      AND first_price IS NOT NULL AND last_price IS NOT NULL
      AND last_price < first_price
      AND (first_price - last_price)::numeric / first_price::numeric * 100 >= p_min_drop_pct
      AND last_seen_at >= now() - make_interval(days => p_max_age_days)
  ),
  unioned AS (
    SELECT * FROM branch_a
    UNION ALL
    SELECT * FROM branch_b
  ),
  deduped AS (
    SELECT DISTINCT ON (url) *
    FROM unioned
    ORDER BY url, last_seen_at DESC NULLS LAST
  )
  SELECT
    source_id, listing_id, source, url, title, mq,
    lat, lng,
    initial_price_eur, current_price_eur, total_drop_pct,
    drops_count, observations_count,
    first_seen_at, last_seen_at,
    comune, omi_zone, commercial_zone_slug,
    zone_match_method, zone_match_confidence, quartiere
  FROM deduped
  WHERE p_commercial_zone_slug IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.civiko_commercial_zones z WHERE z.slug = p_commercial_zone_slug)
    AND (p_quartiere IS NULL OR quartiere = p_quartiere)
  ORDER BY last_seen_at DESC NULLS LAST
  LIMIT p_limit;
$function$;